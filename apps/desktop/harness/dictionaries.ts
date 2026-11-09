import type { DictionaryLayer } from '@simplemd/plugin-api/internal/host';
import { sha256Hex } from '@simplemd/vault';
import { MEMORY_ROOT, type MemoryFsPort } from '@simplemd/vault/testing';
import type {
  DictionaryImported,
  DictionaryPort,
  GlobalDictionaryFile,
  GlobalDictionaryLayer,
} from '../src/platform/types';
import { FOLDER_DICTIONARY_DIR, isDictionaryName } from '../src/state/dictionary';

/**
 * Dicionários falsos do harness e dos testes (r32a, r33a), com a semântica dos comandos Rust
 * (`src-tauri/src/vault/dictionaries.rs` e `dictionaries/import.rs`).
 *
 * Camada global ("deste computador") em memória: nome = a regra de nomes do Rust
 * (`isDictionaryName`, senão `INVALID_PATH`); só `pessoal.txt` nasce pela gravação
 * (`PERMISSION_DENIED`, `ALREADY_EXISTS`); sobrescrita só com o sha256 da base (`CONFLICT` sem
 * gravar, `NOT_FOUND`); link recusado (`OUTSIDE_VAULT`); tetos de 10 MiB por arquivo e, por camada,
 * 16 arquivos e 20 MiB (o excesso vai para `skipped`); `pessoal.txt` primeiro e o resto pela ordem dos
 * bytes do nome.
 *
 * Importar (`import`, r33a): o "diálogo" tira da fila de `importNext` (vazia → `termos-medicos.txt`,
 * 49.999 termos sintéticos e "colecistectomia") e a fonte passa pelas regras do `import.rs`: `.txt`
 * ou `.dic` (+ `.aff`), 10 MiB, link → `SYMLINK`, NUL → `NOT_TEXT`, o BOM e o `SET` do `.aff`, a
 * contagem e as flags do `.dic`, o formato v1 sem NFC, o slug com `-2`…, os tetos da camada
 * (`LAYER_FULL`), uma importação por vez (`BUSY`), nunca sobrescreve, e o par `.dic`/`.aff` em
 * `hunspell/`. Renomear e remover (`rename`, `remove`) levam o par e protegem o `pessoal.txt`. Na
 * camada da pasta, a porta em memória da pasta aberta (`options.folder`); sem ela → `NO_VAULT`.
 *
 * `calls()` nunca guarda o texto. Só neste bundle (`assert-no-harness` procura o marcador).
 */
export const FAKE_DICTIONARIES_MARKER = 'simplemd:fake-dictionaries';

/** Os mesmos tetos do Rust (`policy::DICTIONARY_MAX_BYTES`, `dictionaries::LAYER_MAX_*`). */
export const DICTIONARY_FAKE_LIMITS = {
  fileMaxBytes: 10 * 1024 * 1024,
  layerMaxFiles: 16,
  layerMaxBytes: 20 * 1024 * 1024,
  layerMaxTerms: 200_000,
} as const;

const PERSONAL = 'pessoal.txt';
const PAIR_DIR = 'hunspell';
const SHA256_HEX = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** Só para inspeção (`text`): bytes inválidos viram U+FFFD em vez de lançar. */
const lenient = new TextDecoder('utf-8', { ignoreBOM: true });

type Entry = { readonly kind: 'file'; readonly bytes: Uint8Array } | { readonly kind: 'link' };

export interface DictionaryFakeCall {
  readonly op: 'read' | 'write' | 'import' | 'manage';
  /** Gravação e listas: o nome pedido ou criado (nunca o texto). */
  readonly name?: string;
  /** Gravação: o tamanho UTF-8 do texto. */
  readonly bytes?: number;
  /** Gravação: `create` (sem hash) ou `overwrite` (com o sha256 da base). */
  readonly mode?: 'create' | 'overwrite';
  /** Leitura que deu certo: quantos arquivos voltaram e quantos ficaram de fora. */
  readonly files?: number;
  readonly skipped?: number;
  /** Importar e renomear/remover: a camada; importação que deu certo: as palavras gravadas. */
  readonly layer?: DictionaryLayer;
  readonly words?: number;
  readonly action?: 'rename' | 'remove';
  /** `ok`, `cancelled` ou o código do erro. */
  readonly outcome: string;
}

/** Arquivos comuns da camada como `[nome, bytes em latin1]` (o `&persist=1` do harness). */
export type DictionariesSnapshot = ReadonlyArray<readonly [name: string, latin1: string]>;

/** O que o "diálogo" de `import` escolhe (r33a). */
export type HarnessImportPick =
  | 'cancel'
  | { readonly error: string; readonly detail?: Readonly<Record<string, unknown>> }
  | {
      readonly fileName: string;
      readonly bytes: string | Uint8Array;
      /** O `.aff` ao lado do `.dic` (com outro formato, não é lido). */
      readonly aff?: string | Uint8Array;
      /** O arquivo escolhido (`file`) ou o `.aff` ao lado (`aff`) é um link → `SYMLINK`. */
      readonly link?: 'file' | 'aff';
    };

/** A camada da pasta para o falso (r33a): a porta em memória da pasta aberta e a raiz dela. */
export interface HarnessDictionaryFolder {
  /** A porta atual (o harness troca de porta a cada pasta escolhida). */
  port(): MemoryFsPort;
  /** Raiz da pasta aberta (o token do Tauri); `null` = nenhuma → `NO_VAULT`. */
  root(): string | null;
}

export interface HarnessDictionariesControl {
  readonly marker: string;
  /** Nomes presentes na camada global (arquivos e links, também `hunspell/…`), sem filtro. */
  names(): string[];
  /** Texto de um arquivo comum da camada global (sem validar o UTF-8), ou `null`. */
  text(name: string): string | null;
  /** Bytes de um arquivo comum da camada global (o par em `hunspell/` incluso), ou `null`. */
  bytes(name: string): Uint8Array | null;
  /** Gravação "por fora do app" (outro programa, outra janela): sem regra nenhuma. */
  put(name: string, content: string | Uint8Array): void;
  /** Um link no lugar de `name`: recusado na leitura e na gravação. */
  link(name: string): void;
  remove(name: string): void;
  /** A próxima operação `op` (padrão: a próxima gravação) falha com `code`, sem tocar a camada. */
  failNext(code: string, op?: 'read' | 'write' | 'import' | 'manage'): void;
  /** r33a: o que o próximo "diálogo" de importação escolhe (fila; vazia → a lista padrão). */
  importNext(pick: HarnessImportPick): void;
  calls(): readonly DictionaryFakeCall[];
  snapshot(): DictionariesSnapshot;
  restore(snapshot: DictionariesSnapshot): void;
  /**
   * "Computador novo": camada global vazia, sem chamadas, falhas nem escolhas pendentes; o app é
   * avisado e relê a camada (r32c, N3).
   */
  reset(): void;
}

interface FakeError {
  readonly code: string;
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

const failure = (code: string, detail?: Readonly<Record<string, unknown>>): FakeError =>
  detail === undefined
    ? { code, message: `Dicionário falso: ${code}` }
    : { code, message: `Dicionário falso: ${code}`, detail };

const sized = (code: string, size: number): FakeError => failure(code, { size });

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

const toBytes = (content: string | Uint8Array): Uint8Array =>
  typeof content === 'string' ? encoder.encode(content) : new Uint8Array(content);

// --- importação: o espelho do `import.rs` (r33a) ------------------------------------------------

type Encoding = 'UTF-8' | 'UTF-16LE' | 'UTF-16BE' | 'ISO-8859-1' | 'ISO-8859-15' | 'Windows-1252';

/** Uma linha da fonte: termo, descartada (fora do formato v1) ou fora da contagem. */
export type ImportLine = { readonly term: string } | 'invalid' | 'skip';

/** Espaço, controle, formatação invisível e metade de par substituto num termo. */
const NOT_IN_TERM = /[\p{White_Space}\p{Cc}\p{Cf}\p{Cs}]/u;
/** O que vira U+FFFD no nome do arquivo do cabeçalho. */
const NOT_IN_HEADER = /[\p{Cc}\p{Cf}]|(?! )\p{White_Space}/u;
/** Os bytes 0x80–0x9F que a Windows-1252 não define. */
const CP1252_UNDEFINED = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);
const strictDecoders = {
  'UTF-8': decoder,
  'UTF-16LE': new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }),
  'UTF-16BE': new TextDecoder('utf-16be', { fatal: true, ignoreBOM: true }),
} as const;
const latin9 = new TextDecoder('iso-8859-15');
const windows1252 = new TextDecoder('windows-1252');

/**
 * Termo do formato v1 como o `v1_term` do Rust (o `normalizeWord` do app sem o NFC, D-R33-3): sem
 * os espaços das pontas; vazio ou `#` no início → `skip`; mais de 64 caracteres, espaço, controle ou
 * formatação invisível → `invalid`.
 */
export function importLine(raw: string): ImportLine {
  const term = raw.trim();
  if (term === '' || term.startsWith('#')) return 'skip';
  return [...term].length > 64 || NOT_IN_TERM.test(term) ? 'invalid' : { term };
}

/**
 * A palavra de uma linha de `.dic` (o `dic_word` do Rust): até a primeira `/` não escapada (`\/`
 * vira `/`), cortada no TAB e no primeiro campo morfológico (` xx:`).
 */
export function dicWord(line: string): string {
  let word = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && line[i + 1] === '/') {
      word += '/';
      i++;
    } else if (c === '/' || c === '\t') break;
    else word += c;
  }
  const field = / [a-z]{2}:/.exec(word);
  return field === null ? word : word.slice(0, field.index);
}

const FOLD = new Map(
  (
    [
      ['ÀÁÂÃÄÅàáâãäå', 'a'],
      ['Ææ', 'ae'],
      ['Çç', 'c'],
      ['ÈÉÊËèéêë', 'e'],
      ['ÌÍÎÏìíîï', 'i'],
      ['Ðð', 'd'],
      ['Ññ', 'n'],
      ['ÒÓÔÕÖØòóôõöø', 'o'],
      ['ÙÚÛÜùúûü', 'u'],
      ['ÝýÿŸ', 'y'],
      ['Þþ', 'th'],
      ['ß', 'ss'],
      ['Œœ', 'oe'],
      ['Šš', 's'],
      ['Žž', 'z'],
    ] as const
  ).flatMap(([letters, ascii]) => [...letters].map((c) => [c, ascii] as const)),
);

/**
 * O nome de uma lista importada (o `slug` do Rust, D-R33-2): o nome do arquivo sem a extensão em
 * ASCII minúsculo — letras latinas sem acento, dígitos e `_`; o resto vira um `-` só —, até 48
 * caracteres. Vazio ou reservado → `importado`; `pessoal` → `pessoal-importado`.
 */
export function slugOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  let out = '';
  let dash = false;
  for (const c of stem) {
    if (c >= '\u0300' && c <= '\u036f') continue; // acento combinado (NFD)
    const ascii = /^[A-Za-z0-9_]$/.test(c);
    const latin = ascii ? undefined : FOLD.get(c);
    if (!ascii && latin === undefined) {
      dash = true;
      continue;
    }
    if (dash && out !== '') out += '-';
    dash = false;
    out += latin ?? c.toLowerCase();
  }
  out = shorten(out, 48);
  if (out === '' || !isDictionaryName(`${out}.txt`)) return 'importado';
  return out === 'pessoal' ? 'pessoal-importado' : out;
}

/** Corta o slug (ASCII) em `max` e tira os `-` do fim. */
function shorten(slug: string, max: number): string {
  return slug.slice(0, max).replace(/-+$/, '');
}

const tooLarge = (fileName: string, size: number): FakeError =>
  failure('TOO_LARGE', { fileName, size, max: DICTIONARY_FAKE_LIMITS.fileMaxBytes });

/** O `SET` do `.aff` (a primeira linha `SET <nome>`), como o `declared_encoding` do Rust. */
function declaredEncoding(aff: Uint8Array): Encoding | null {
  const body = aff[0] === 0xef && aff[1] === 0xbb && aff[2] === 0xbf ? aff.subarray(3) : aff;
  for (const line of toLatin1(body).split('\n')) {
    const set = /^[\t\n\f\r ]*SET[\t ][\t\n\f\r ]*([^\t\n\f\r ]*)/.exec(line);
    const name = set?.[1] ?? '';
    if (name === '') continue;
    switch (name.replace(/[-_]/g, '').toUpperCase()) {
      case 'UTF8':
        return 'UTF-8';
      case 'ISO88591':
        return 'ISO-8859-1';
      case 'ISO885915':
        return 'ISO-8859-15';
      case 'MICROSOFTCP1252':
      case 'CP1252':
      case 'WINDOWS1252':
        return 'Windows-1252';
      default:
        throw failure('UNSUPPORTED_ENCODING', {
          encoding: [...name]
            .filter((c) => /[A-Za-z0-9._-]/.test(c))
            .slice(0, 32)
            .join(''),
        });
    }
  }
  return null;
}

function strict(encoding: keyof typeof strictDecoders, bytes: Uint8Array): string {
  try {
    return strictDecoders[encoding].decode(bytes);
  } catch {
    throw failure('BAD_ENCODING', { encoding });
  }
}

/** Bytes → texto como o `decode` do Rust: BOM, NUL, a declarada e a recaída Windows-1252. */
function decode(
  bytes: Uint8Array,
  declared: Encoding | null,
): { text: string; encoding: Encoding } {
  const starts = (...prefix: number[]) => prefix.every((b, i) => bytes[i] === b);
  let text: string;
  let encoding: Encoding;
  if (starts(0xef, 0xbb, 0xbf)) {
    [text, encoding] = [strict('UTF-8', bytes.subarray(3)), 'UTF-8'];
  } else if (starts(0xff, 0xfe)) {
    [text, encoding] = [strict('UTF-16LE', bytes.subarray(2)), 'UTF-16LE'];
  } else if (starts(0xfe, 0xff)) {
    [text, encoding] = [strict('UTF-16BE', bytes.subarray(2)), 'UTF-16BE'];
  } else if (bytes.includes(0)) {
    throw failure('NOT_TEXT');
  } else if (declared === 'UTF-8') {
    [text, encoding] = [strict('UTF-8', bytes), 'UTF-8'];
  } else if (declared === 'ISO-8859-1') {
    [text, encoding] = [toLatin1(bytes), 'ISO-8859-1'];
  } else if (declared === 'ISO-8859-15') {
    [text, encoding] = [latin9.decode(bytes), 'ISO-8859-15'];
  } else if (declared === 'Windows-1252') {
    if (bytes.some((b) => CP1252_UNDEFINED.has(b)))
      throw failure('BAD_ENCODING', { encoding: 'Windows-1252' });
    [text, encoding] = [windows1252.decode(bytes), 'Windows-1252'];
  } else {
    try {
      [text, encoding] = [decoder.decode(bytes), 'UTF-8'];
    } catch {
      [text, encoding] = [windows1252.decode(bytes), 'Windows-1252'];
    }
  }
  if (text.includes('\0')) throw failure('NOT_TEXT');
  return { text, encoding };
}

/** Os termos (na ordem, sem repetidos) e os descartados, como o `parse_terms` do Rust. */
function parseTerms(
  format: 'txt' | 'dic',
  text: string,
): { terms: string[]; discarded: number } | null {
  const seen = new Set<string>();
  let discarded = 0;
  for (const [index, line] of text.replace(/\r\n?/g, '\n').split('\n').entries()) {
    let parsed: ImportLine;
    if (format === 'txt') parsed = importLine(line);
    else {
      const count = index === 0 && /^\d+$/.test(line.trim());
      if (count || line.startsWith('#') || line.startsWith('\t') || line.trim() === '') continue;
      const word = importLine(dicWord(line));
      parsed = word === 'skip' ? 'invalid' : word;
    }
    if (parsed === 'skip') continue;
    if (parsed === 'invalid' || seen.has(parsed.term)) discarded++;
    else if (seen.size === DICTIONARY_FAKE_LIMITS.layerMaxTerms) return null;
    else seen.add(parsed.term);
  }
  return { terms: [...seen], discarded };
}

interface FakeList {
  readonly slug: string;
  readonly bytes: Uint8Array;
  readonly terms: readonly string[];
  readonly discarded: number;
  readonly encoding: Encoding;
  readonly pair: readonly [dic: Uint8Array, aff: Uint8Array] | null;
}

/** Lê e converte a fonte escolhida, na ordem das conferências do Rust (`read_source` + `convert`). */
function convert(pick: Extract<HarnessImportPick, { readonly fileName: string }>): FakeList {
  const { fileName } = pick;
  // Como o `Path::extension` do Rust: um nome que só começa com `.` não tem extensão.
  const dot = fileName.lastIndexOf('.');
  const extension = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  if (extension !== 'txt' && extension !== 'dic') throw failure('UNSUPPORTED_TYPE');
  if (pick.link === 'file') throw failure('SYMLINK');
  const bytes = toBytes(pick.bytes);
  if (bytes.length > DICTIONARY_FAKE_LIMITS.fileMaxBytes) throw tooLarge(fileName, bytes.length);
  let aff: Uint8Array | null = null;
  if (extension === 'dic') {
    if (pick.link === 'aff') throw failure('SYMLINK');
    if (pick.aff !== undefined) {
      aff = toBytes(pick.aff);
      const affName = `${fileName.slice(0, -3)}${fileName.endsWith('DIC') ? 'AFF' : 'aff'}`;
      if (aff.length > DICTIONARY_FAKE_LIMITS.fileMaxBytes) throw tooLarge(affName, aff.length);
    }
  }
  const { text, encoding } = decode(bytes, aff === null ? null : declaredEncoding(aff));
  const parsed = parseTerms(extension, text);
  if (parsed === null) throw failure('LAYER_FULL');
  if (parsed.terms.length === 0) throw failure('EMPTY');
  const shown = [...fileName]
    .slice(0, 128)
    .map((c) => (NOT_IN_HEADER.test(c) ? '\uFFFD' : c))
    .join('');
  const today = new Date().toISOString().slice(0, 10);
  const out = encoder.encode(
    `# Importado de ${shown} em ${today}\n${parsed.terms.map((t) => `${t}\n`).join('')}`,
  );
  if (out.length > DICTIONARY_FAKE_LIMITS.fileMaxBytes) throw tooLarge(fileName, out.length);
  return {
    slug: slugOf(fileName),
    bytes: out,
    terms: parsed.terms,
    discarded: parsed.discarded,
    encoding,
    pair: extension === 'dic' && aff !== null ? [bytes, aff] : null,
  };
}

/** A lista padrão do "diálogo" (design-r33 §4): 49.999 termos sintéticos e "colecistectomia". */
function defaultPick(): HarnessImportPick {
  const lines = ['# Termos médicos (lista sintética do harness)'];
  for (let i = 1; i < 50_000; i++) lines.push(`termo${String(i).padStart(5, '0')}`);
  lines.splice(25_000, 0, 'colecistectomia');
  return { fileName: 'termos-medicos.txt', bytes: `${lines.join('\n')}\n` };
}

/**
 * Uma camada vista pelo falso: o que há num caminho relativo à pasta da camada (sem seguir link),
 * as entradas da pasta, os bytes e as mudanças "no disco".
 */
interface FakeLayer {
  /** A pasta da camada (ou a `.simplemd` dela) como link → `OUTSIDE_VAULT`. */
  check(): Promise<void>;
  kind(rel: string): Promise<'file' | 'link' | 'dir' | 'other' | null>;
  list(): Promise<ReadonlyArray<{ name: string; kind: string; size: number }>>;
  bytes(rel: string): Uint8Array | null;
  write(rel: string, bytes: Uint8Array): void;
  remove(rel: string): void;
}

export function createHarnessDictionaries(
  options: { readonly folder?: HarnessDictionaryFolder } = {},
): {
  dictionaries: DictionaryPort;
  control: HarnessDictionariesControl;
} {
  const entries = new Map<string, Entry>();
  let calls: DictionaryFakeCall[] = [];
  let faults: Array<{ readonly op: DictionaryFakeCall['op']; readonly code: string }> = [];
  let picks: HarnessImportPick[] = [];
  let importing = false;
  const listeners = new Set<() => void>();

  const takeFault = (op: DictionaryFakeCall['op']): string | null => {
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
    if (bytes.length > DICTIONARY_FAKE_LIMITS.fileMaxBytes) throw sized('TOO_LARGE', bytes.length);
    if (expectedSha256 === null && name !== PERSONAL) throw failure('PERMISSION_DENIED');
    const entry = entries.get(name);
    if (entry?.kind === 'link') throw failure('OUTSIDE_VAULT');
    if (expectedSha256 === null) {
      if (entry !== undefined) throw failure('ALREADY_EXISTS');
    } else {
      if (entry === undefined) throw failure('NOT_FOUND');
      if (entry.bytes.length > DICTIONARY_FAKE_LIMITS.fileMaxBytes)
        throw sized('TOO_LARGE', entry.bytes.length);
      if (sha256Hex(entry.bytes) !== expectedSha256) throw failure('CONFLICT');
    }
    entries.set(name, { kind: 'file', bytes });
  }

  /** A camada global em memória: `hunspell/<nome>` é uma chave como outra qualquer. */
  const globalLayer: FakeLayer = {
    async check() {},
    async kind(rel) {
      const entry = entries.get(rel);
      if (entry !== undefined) return entry.kind;
      return [...entries.keys()].some((key) => key.startsWith(`${rel}/`)) ? 'dir' : null;
    },
    async list() {
      return [...entries]
        .filter(([name]) => !name.includes('/'))
        .map(([name, entry]) => ({
          name,
          kind: entry.kind,
          size: entry.kind === 'file' ? entry.bytes.length : 0,
        }));
    },
    bytes: (rel) => {
      const entry = entries.get(rel);
      return entry?.kind === 'file' ? entry.bytes : null;
    },
    write: (rel, bytes) => void entries.set(rel, { kind: 'file', bytes }),
    remove: (rel) => void entries.delete(rel),
  };

  /** A camada da pasta aberta: `.simplemd/dictionaries` na porta em memória (escritas "do Rust"). */
  function folderLayer(): FakeLayer {
    const root = options.folder?.root() ?? null;
    if (options.folder === undefined || root === null) throw failure('NO_VAULT');
    const port = options.folder.port();
    const abs = (rel: string) => `${root}/${FOLDER_DICTIONARY_DIR}${rel === '' ? '' : `/${rel}`}`;
    const memory = (rel: string) => abs(rel).slice(MEMORY_ROOT.length + 1);
    const kindOf = async (path: string) => {
      const stat = await port.lstat(path);
      return stat === null ? null : stat.kind === 'symlink' ? 'link' : stat.kind;
    };
    return {
      async check() {
        for (const path of [`${root}/.simplemd`, abs('')]) {
          const kind = await kindOf(path);
          if (kind === 'link') throw failure('OUTSIDE_VAULT');
          if (kind !== null && kind !== 'dir') throw failure('INVALID_PATH');
        }
      },
      kind: (rel) => kindOf(abs(rel)),
      async list() {
        if ((await kindOf(abs(''))) !== 'dir') return [];
        return (await port.readDir(abs(''))).map((item) => ({
          name: item.name,
          kind: item.kind === 'symlink' ? 'link' : item.kind,
          size: item.size ?? 0,
        }));
      },
      bytes: (rel) => port.readBytes(memory(rel)),
      write: (rel, bytes) => port.externalWrite(memory(rel), bytes),
      remove: (rel) => port.remove(memory(rel)),
    };
  }

  const layerOf = (layer: DictionaryLayer): FakeLayer =>
    layer === 'global' ? globalLayer : folderLayer();

  /** `<stem>.txt` ou o par `hunspell/<stem>.dic|.aff` existe: o nome está ocupado. */
  async function taken(layer: FakeLayer, stem: string): Promise<boolean> {
    for (const rel of [`${stem}.txt`, `${PAIR_DIR}/${stem}.dic`, `${PAIR_DIR}/${stem}.aff`])
      if ((await layer.kind(rel)) !== null) return true;
    return false;
  }

  /** A pasta do par (`hunspell/`) como link → `OUTSIDE_VAULT`; algo que não é pasta → `INVALID_PATH`. */
  async function checkPairDir(layer: FakeLayer): Promise<void> {
    const kind = await layer.kind(PAIR_DIR);
    if (kind === 'link') throw failure('OUTSIDE_VAULT');
    if (kind !== null && kind !== 'dir') throw failure('INVALID_PATH');
  }

  /** Os tetos da camada antes de gravar, contados como o `check_room` do Rust. */
  async function checkRoom(layer: FakeLayer, list: FakeList): Promise<void> {
    const found = (await layer.list()).filter(
      (item) => isDictionaryName(item.name) && (item.kind === 'file' || item.kind === 'link'),
    );
    const readable = found.filter(
      (item) => item.kind === 'file' && item.size <= DICTIONARY_FAKE_LIMITS.fileMaxBytes,
    );
    const bytes = readable.reduce((sum, item) => sum + item.size, list.bytes.length);
    if (
      found.length + 1 > DICTIONARY_FAKE_LIMITS.layerMaxFiles ||
      bytes > DICTIONARY_FAKE_LIMITS.layerMaxBytes
    )
      throw failure('LAYER_FULL');
    const union = new Set(list.terms);
    for (const item of readable) {
      let text: string;
      try {
        text = decoder.decode(layer.bytes(item.name) ?? new Uint8Array());
      } catch {
        continue;
      }
      for (const line of (text.startsWith('\uFEFF') ? text.slice(1) : text).split('\n')) {
        const parsed = importLine(line);
        if (typeof parsed === 'object') union.add(parsed.term);
        if (union.size > DICTIONARY_FAKE_LIMITS.layerMaxTerms) throw failure('LAYER_FULL');
      }
    }
  }

  async function importList(layer: DictionaryLayer): Promise<DictionaryImported | null> {
    if (layer === 'folder') folderLayer(); // sem pasta → NO_VAULT, sem "diálogo"
    if (importing) throw failure('BUSY');
    importing = true;
    try {
      await Promise.resolve(); // o "diálogo"
      const fault = takeFault('import');
      if (fault !== null) throw failure(fault);
      const pick = picks.shift() ?? defaultPick();
      if (pick === 'cancel') return null;
      if ('error' in pick) throw failure(pick.error, pick.detail);
      const list = convert(pick);
      const target = layerOf(layer);
      await target.check();
      await checkRoom(target, list);
      if (list.pair !== null) await checkPairDir(target);
      let stem = list.slug;
      for (let n = 2; await taken(target, stem); n++) {
        if (n > 99) throw failure('ALREADY_EXISTS');
        stem = `${shorten(list.slug, 48 - `-${n}`.length)}-${n}`;
      }
      if (list.pair !== null) {
        target.write(`${PAIR_DIR}/${stem}.dic`, list.pair[0]);
        target.write(`${PAIR_DIR}/${stem}.aff`, list.pair[1]);
      }
      target.write(`${stem}.txt`, list.bytes);
      return {
        name: `${stem}.txt`,
        words: list.terms.length,
        discarded: list.discarded,
        encoding: list.encoding,
        pair: list.pair !== null,
      };
    } finally {
      importing = false;
    }
  }

  /** Renomear (`to`) ou remover (`to = null`) uma lista, como o `dict_manage` do Rust. */
  async function manageList(layer: DictionaryLayer, name: string, to: string | null) {
    const fault = takeFault('manage');
    if (fault !== null) throw failure(fault);
    const target = layerOf(layer);
    for (const checked of to === null ? [name] : [name, to]) {
      if (!isDictionaryName(checked)) throw failure('INVALID_NAME');
      // O `pessoal.txt` em qualquer caixa Unicode (`ſ` → `S`), como o `is_personal` do Rust.
      if (checked.toUpperCase() === PERSONAL.toUpperCase() || checked.toLowerCase() === PERSONAL)
        throw failure('PROTECTED');
    }
    await target.check();
    const kind = await target.kind(name);
    if (kind === null) throw failure('NOT_FOUND');
    if (kind === 'link') throw failure('OUTSIDE_VAULT');
    if (kind !== 'file') throw failure('INVALID_PATH');
    const stem = name.slice(0, -'.txt'.length);
    const pair: string[] = [];
    await checkPairDir(target);
    for (const extension of ['dic', 'aff']) {
      const found = await target.kind(`${PAIR_DIR}/${stem}.${extension}`);
      if (found === 'link') throw failure('OUTSIDE_VAULT');
      if (found !== null && found !== 'file') throw failure('INVALID_PATH');
      if (found === 'file') pair.push(extension);
    }
    if (to === null) {
      target.remove(name);
      for (const extension of pair) target.remove(`${PAIR_DIR}/${stem}.${extension}`);
      return;
    }
    const toStem = to.slice(0, -'.txt'.length);
    if (await taken(target, toStem)) throw failure('ALREADY_EXISTS');
    const move = (from: string, into: string) => {
      const bytes = target.bytes(from);
      if (bytes === null) return;
      target.remove(from);
      target.write(into, bytes);
    };
    for (const extension of pair)
      move(`${PAIR_DIR}/${stem}.${extension}`, `${PAIR_DIR}/${toStem}.${extension}`);
    move(name, to);
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
    async import(layer) {
      try {
        const imported = await importList(layer);
        calls.push(
          imported === null
            ? { op: 'import', layer, outcome: 'cancelled' }
            : {
                op: 'import',
                layer,
                name: imported.name,
                words: imported.words,
                outcome: 'ok',
              },
        );
        return imported;
      } catch (error) {
        calls.push({ op: 'import', layer, outcome: (error as FakeError).code });
        throw error;
      }
    },
    async rename(layer, name, to) {
      try {
        await manageList(layer, name, to);
        calls.push({ op: 'manage', layer, name, action: 'rename', outcome: 'ok' });
      } catch (error) {
        const outcome = (error as FakeError).code;
        calls.push({ op: 'manage', layer, name, action: 'rename', outcome });
        throw error;
      }
    },
    async remove(layer, name) {
      try {
        await manageList(layer, name, null);
        calls.push({ op: 'manage', layer, name, action: 'remove', outcome: 'ok' });
      } catch (error) {
        const outcome = (error as FakeError).code;
        calls.push({ op: 'manage', layer, name, action: 'remove', outcome });
        throw error;
      }
    },
    onExternalChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };

  const control: HarnessDictionariesControl = {
    marker: FAKE_DICTIONARIES_MARKER,
    names: () => [...entries.keys()],
    text(name) {
      const entry = entries.get(name);
      return entry?.kind === 'file' ? lenient.decode(entry.bytes) : null;
    },
    bytes(name) {
      const entry = entries.get(name);
      return entry?.kind === 'file' ? new Uint8Array(entry.bytes) : null;
    },
    put(name, content) {
      entries.set(name, { kind: 'file', bytes: toBytes(content) });
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
    importNext(pick) {
      picks.push(pick);
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
      picks = [];
      importing = false;
      for (const listener of [...listeners]) listener();
    },
  };
  return { dictionaries, control };
}
