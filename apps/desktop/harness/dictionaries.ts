import { sha256Hex, toVaultPath } from '@simplemd/vault';
import type {
  DictionaryPort,
  GlobalDictionaryFile,
  GlobalDictionaryLayer,
} from '../src/platform/types';

/**
 * Camada global de dicionários falsa do harness e dos testes (r32a): os `.txt` "deste computador" em
 * memória, com a semântica dos comandos Rust `dict_global_read`/`dict_global_write`
 * (`src-tauri/src/vault/dictionaries.rs`). Nome = um segmento aceito pela guarda de caminho e
 * terminado em `.txt` (senão `INVALID_PATH`); só `pessoal.txt` nasce (`PERMISSION_DENIED`,
 * `ALREADY_EXISTS`); sobrescrita só com o sha256 da base (`CONFLICT` sem gravar, `NOT_FOUND`); link
 * recusado (`OUTSIDE_VAULT`); tetos de 10 MiB por arquivo e, por camada, 16 arquivos e 20 MiB (o
 * excesso vai para `skipped`); `pessoal.txt` primeiro e o resto pela ordem dos bytes do nome.
 * `calls()` nunca guarda o texto. Só neste bundle (`assert-no-harness` procura o marcador).
 */
export const FAKE_DICTIONARIES_MARKER = 'simplemd:fake-dictionaries';

/** Os mesmos tetos do Rust (`policy::DICTIONARY_MAX_BYTES`, `dictionaries::LAYER_MAX_*`). */
export const DICTIONARY_FAKE_LIMITS = {
  fileMaxBytes: 10 * 1024 * 1024,
  layerMaxFiles: 16,
  layerMaxBytes: 20 * 1024 * 1024,
} as const;

const PERSONAL = 'pessoal.txt';
const SHA256_HEX = /^[0-9a-f]{64}$/;
const TXT = /\.txt$/i;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** Só para inspeção (`text`): bytes inválidos viram U+FFFD em vez de lançar. */
const lenient = new TextDecoder('utf-8', { ignoreBOM: true });

type Entry = { readonly kind: 'file'; readonly bytes: Uint8Array } | { readonly kind: 'link' };

export interface DictionaryFakeCall {
  readonly op: 'read' | 'write';
  /** Gravação: o nome pedido e o tamanho UTF-8 do texto (nunca o texto). */
  readonly name?: string;
  readonly bytes?: number;
  /** Gravação: `create` (sem hash) ou `overwrite` (com o sha256 da base). */
  readonly mode?: 'create' | 'overwrite';
  /** Leitura que deu certo: quantos arquivos voltaram e quantos ficaram de fora. */
  readonly files?: number;
  readonly skipped?: number;
  /** `ok` ou o código do erro. */
  readonly outcome: string;
}

/** Arquivos comuns da camada como `[nome, bytes em latin1]` (o `&persist=1` do harness). */
export type DictionariesSnapshot = ReadonlyArray<readonly [name: string, latin1: string]>;

export interface HarnessDictionariesControl {
  readonly marker: string;
  /** Nomes presentes (arquivos e links), em qualquer ordem e sem filtro. */
  names(): string[];
  /** Texto de um arquivo comum (sem validar o UTF-8), ou `null`. */
  text(name: string): string | null;
  /** Gravação "por fora do app" (outro programa, outra janela): sem regra nenhuma. */
  put(name: string, content: string | Uint8Array): void;
  /** Um link no lugar de `name`: recusado na leitura e na gravação. */
  link(name: string): void;
  remove(name: string): void;
  /** A próxima operação `op` (padrão: a próxima gravação) falha com `code`, sem tocar a camada. */
  failNext(code: string, op?: 'read' | 'write'): void;
  calls(): readonly DictionaryFakeCall[];
  snapshot(): DictionariesSnapshot;
  restore(snapshot: DictionariesSnapshot): void;
  /** Camada vazia, sem chamadas nem falhas pendentes. */
  reset(): void;
}

interface FakeError {
  readonly code: string;
  readonly message: string;
  readonly detail?: { readonly size: number };
}

const failure = (code: string, size?: number): FakeError =>
  size === undefined
    ? { code, message: `Dicionário falso: ${code}` }
    : { code, message: `Dicionário falso: ${code}`, detail: { size } };

/** `policy::dictionary_name`: um segmento só, aceito pela guarda de caminho, terminado em `.txt`. */
function isDictionaryName(name: string): boolean {
  if (name.length <= '.txt'.length || name.includes('/') || !TXT.test(name)) return false;
  try {
    return toVaultPath(name) === name;
  } catch {
    return false;
  }
}

/** `pessoal.txt` primeiro; o resto pela ordem dos bytes UTF-8 do nome, como no Rust. */
function layerOrder(a: string, b: string): number {
  if (a === PERSONAL || b === PERSONAL) return a === b ? 0 : a === PERSONAL ? -1 : 1;
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  for (let i = 0; i < x.length && i < y.length; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return x.length - y.length;
}

/** Bytes → latin1 (um caractere por byte), em blocos para não estourar a pilha. */
function toLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

export function createHarnessDictionaries(): {
  dictionaries: DictionaryPort;
  control: HarnessDictionariesControl;
} {
  const entries = new Map<string, Entry>();
  let calls: DictionaryFakeCall[] = [];
  let faults: Array<{ readonly op: 'read' | 'write'; readonly code: string }> = [];

  const takeFault = (op: 'read' | 'write'): string | null => {
    const fault = faults.find((f) => f.op === op);
    if (fault === undefined) return null;
    faults = faults.filter((f) => f !== fault);
    return fault.code;
  };

  function read(): GlobalDictionaryLayer {
    const fault = takeFault('read');
    if (fault !== null) throw failure(fault);
    const files: GlobalDictionaryFile[] = [];
    let skipped = 0;
    let budget: number = DICTIONARY_FAKE_LIMITS.layerMaxBytes;
    for (const name of [...entries.keys()].filter(isDictionaryName).sort(layerOrder)) {
      const entry = entries.get(name);
      if (entry === undefined) continue;
      if (files.length === DICTIONARY_FAKE_LIMITS.layerMaxFiles) {
        skipped++;
        continue;
      }
      if (entry.kind === 'link') {
        files.push({ name, error: 'OUTSIDE_VAULT' });
        continue;
      }
      const size = entry.bytes.length;
      if (size > DICTIONARY_FAKE_LIMITS.fileMaxBytes) {
        files.push({ name, error: 'TOO_LARGE' });
        continue;
      }
      if (size > budget) {
        skipped++;
        continue;
      }
      budget -= size;
      let text: string;
      try {
        text = decoder.decode(entry.bytes);
      } catch {
        files.push({ name, error: 'NOT_UTF8' });
        continue;
      }
      files.push({ name, text, sha256: sha256Hex(entry.bytes) });
    }
    return { files, skipped };
  }

  /** A ordem das conferências é a do Rust: nome, hash, teto, criação, link, existência, base. */
  function write(name: string, bytes: Uint8Array, expectedSha256: string | null): void {
    const fault = takeFault('write');
    if (fault !== null) throw failure(fault);
    if (!isDictionaryName(name)) throw failure('INVALID_PATH');
    if (expectedSha256 !== null && !SHA256_HEX.test(expectedSha256)) throw failure('INVALID_PATH');
    if (bytes.length > DICTIONARY_FAKE_LIMITS.fileMaxBytes)
      throw failure('TOO_LARGE', bytes.length);
    if (expectedSha256 === null && name !== PERSONAL) throw failure('PERMISSION_DENIED');
    const entry = entries.get(name);
    if (entry?.kind === 'link') throw failure('OUTSIDE_VAULT');
    if (expectedSha256 === null) {
      if (entry !== undefined) throw failure('ALREADY_EXISTS');
    } else {
      if (entry === undefined) throw failure('NOT_FOUND');
      if (entry.bytes.length > DICTIONARY_FAKE_LIMITS.fileMaxBytes)
        throw failure('TOO_LARGE', entry.bytes.length);
      if (sha256Hex(entry.bytes) !== expectedSha256) throw failure('CONFLICT');
    }
    entries.set(name, { kind: 'file', bytes });
  }

  const dictionaries: DictionaryPort = {
    async readGlobal() {
      try {
        const layer = read();
        calls.push({
          op: 'read',
          files: layer.files.length,
          skipped: layer.skipped,
          outcome: 'ok',
        });
        return layer;
      } catch (error) {
        calls.push({ op: 'read', outcome: (error as FakeError).code });
        throw error;
      }
    },
    async writeGlobal(name, text, expectedSha256) {
      const bytes = encoder.encode(text);
      const call = {
        op: 'write' as const,
        name,
        bytes: bytes.length,
        mode: expectedSha256 === null ? ('create' as const) : ('overwrite' as const),
      };
      try {
        write(name, bytes, expectedSha256);
        calls.push({ ...call, outcome: 'ok' });
      } catch (error) {
        calls.push({ ...call, outcome: (error as FakeError).code });
        throw error;
      }
    },
  };

  const control: HarnessDictionariesControl = {
    marker: FAKE_DICTIONARIES_MARKER,
    names: () => [...entries.keys()],
    text(name) {
      const entry = entries.get(name);
      return entry?.kind === 'file' ? lenient.decode(entry.bytes) : null;
    },
    put(name, content) {
      const bytes = typeof content === 'string' ? encoder.encode(content) : new Uint8Array(content);
      entries.set(name, { kind: 'file', bytes });
    },
    link(name) {
      entries.set(name, { kind: 'link' });
    },
    remove(name) {
      entries.delete(name);
    },
    failNext(code, op = 'write') {
      faults.push({ op, code });
    },
    calls: () => calls,
    snapshot: () =>
      [...entries].flatMap(([name, entry]) =>
        entry.kind === 'file' ? [[name, toLatin1(entry.bytes)] as const] : [],
      ),
    restore(snapshot) {
      for (const [name, latin1] of snapshot)
        entries.set(name, { kind: 'file', bytes: Uint8Array.from(latin1, (c) => c.charCodeAt(0)) });
    },
    reset() {
      entries.clear();
      calls = [];
      faults = [];
    },
  };
  return { dictionaries, control };
}
