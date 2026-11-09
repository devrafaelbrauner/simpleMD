import type {
  DictionaryHost,
  DictionaryLayer,
  DictionaryWarning,
  DictionaryWriteResult,
} from '@simplemd/plugin-api/internal/host';
import {
  isVaultError,
  sha256Hex,
  toVaultPath,
  type ContentVaultProvider,
  type FsDirItem,
  type VaultHandle,
} from '@simplemd/vault';
import type { DictionaryPort } from '../platform/types';
import type { Clock } from './sync';

/**
 * Dicionário do usuário (r32b; D-P26-03; design-r32 §1): o formato v1 e o serviço que une a camada
 * global (deste computador, `AppPlatform.dictionaries`) e a da pasta aberta
 * (`.simplemd/dictionaries/*.txt`, pelo `vault`). Um só gravador por arquivo: o LanguageTool recebe o
 * serviço pelo arquivo de registro (`services.dictionary`, DA-R7-26) e a lista das Configurações
 * (r32c) usa o mesmo objeto, com o plugin ligado ou não (D-R32-1).
 *
 * Formato v1: UTF-8, um termo por linha, `#` no início = comentário; termo = NFC do texto sem espaços
 * nas pontas, 1–64 caracteres, sem espaço, controle (Cc) ou formatação invisível (Cf, inclusive
 * bidi); a duplicata sai (vale a primeira). O app grava sem BOM e com `\n`; na leitura, um BOM
 * inicial e o `\r` do fim da linha saem.
 *
 * Camadas: `pessoal.txt` primeiro, o resto pela ordem dos bytes do nome (a do Rust). Por camada,
 * até 200.000 termos, 16 arquivos e 20 MiB; até 10 MiB por arquivo (D-R32-2). O excesso fica de fora
 * com um aviso, que por enquanto o plugin mostra (D-R32-7).
 *
 * Carga sob demanda: nada é lido até a primeira assinatura (ou gravação). Daí em diante, a global é
 * relida a cada pasta aberta e a da pasta na abertura e quando o observador vê um `.txt` dela mudar.
 * Gravação condicional (sha256 da base lida): base velha → relê a camada e tenta mais uma vez.
 */

export const DICTIONARY_LIMITS = {
  /** Caracteres (pontos de código) por termo. */
  termMaxChars: 64,
  /** Termos por camada (D-R32-2). */
  layerMaxTerms: 200_000,
  /** Arquivos por camada (os com erro contam), como no Rust. */
  layerMaxFiles: 16,
  layerMaxBytes: 20 * 1024 * 1024,
  /** `policy::DICTIONARY_MAX_BYTES`. */
  fileMaxBytes: 10 * 1024 * 1024,
} as const;

/** O único arquivo que o app cria numa camada (D-R32-3); "Adicionar" acrescenta nele. */
export const PERSONAL_DICTIONARY = 'pessoal.txt';
/** A camada da pasta, relativa à raiz da pasta. */
export const FOLDER_DICTIONARY_DIR = '.simplemd/dictionaries';
/** Espera depois do último evento do observador antes de reler a camada da pasta. */
export const DICTIONARY_RELOAD_DEBOUNCE_MS = 300;

/** Espaço, controle, formatação invisível (inclusive bidi) e metade de par substituto. */
const NOT_IN_TERM = /[\p{White_Space}\p{Cc}\p{Cf}\p{Cs}]/u;
/** A pasta vem da sincronização: nome com controle ou formatação invisível não é dicionário. */
const NOT_IN_NAME = /[\p{Cc}\p{Cf}]/u;
const MIB = 1024 * 1024;
const LAYER_NAMES: Readonly<Record<DictionaryLayer, string>> = {
  global: 'deste computador',
  folder: 'desta pasta',
};
const encoder = new TextEncoder();

/**
 * O termo do formato v1 que a linha (ou palavra) representa, ou `null`: linha vazia, comentário
 * (`#`), mais de 64 caracteres, espaço, controle ou formatação invisível.
 */
export function normalizeWord(raw: string): string | null {
  const term = raw.trim().normalize('NFC');
  // 64 caracteres em NFC cabem em 128 unidades UTF-16: o corte vem antes de espalhar a linha.
  if (term === '' || term.length > 2 * DICTIONARY_LIMITS.termMaxChars) return null;
  if (term.startsWith('#') || NOT_IN_TERM.test(term)) return null;
  return [...term].length <= DICTIONARY_LIMITS.termMaxChars ? term : null;
}

/** Os termos de um arquivo v1, na ordem, sem duplicatas (vale a primeira ocorrência). */
export function parseWordList(text: string): string[] {
  const terms = new Set<string>();
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  for (const line of body.split('\n')) {
    const term = normalizeWord(line);
    if (term !== null) terms.add(term);
  }
  return [...terms];
}

/** Caixa misturada ("eXcessão"), como `StringTools.isMixedCase` do LanguageTool. */
function isMixedCase(word: string): boolean {
  if (word === word.toLowerCase() || word === word.toUpperCase()) return false;
  const first = String.fromCodePoint(word.codePointAt(0) ?? 0);
  const tail = word.slice(first.length);
  return first === first.toLowerCase() || tail !== tail.toLowerCase();
}

/**
 * A palavra está em `words` (termos em NFC), com a regra do LanguageTool para palavras ignoradas
 * (`SpellingCheckRule.isIgnoredNoCase`): igual ou — sem caixa misturada — a forma em minúsculas
 * está lá. "excessão" aceita "Excessão" e "EXCESSÃO"; "Brasil" não aceita "brasil" (CR-S8 N3). A
 * palavra é comparada em NFC: a nota pode vir decomposta (NFD).
 */
export function inDictionary(words: ReadonlySet<string>, word: string): boolean {
  const term = word.normalize('NFC');
  return words.has(term) || (!isMixedCase(term) && words.has(term.toLowerCase().normalize('NFC')));
}

/** `pessoal.txt` primeiro; o resto pela ordem dos bytes UTF-8 do nome, como no Rust. */
function layerOrder(a: string, b: string): number {
  if (a === PERSONAL_DICTIONARY || b === PERSONAL_DICTIONARY)
    return a === b ? 0 : a === PERSONAL_DICTIONARY ? -1 : 1;
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  for (let i = 0; i < x.length && i < y.length; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return x.length - y.length;
}

/** Nome de dicionário da pasta: um segmento aceito pela guarda de caminho, terminado em `.txt`. */
function isDictionaryName(name: string): boolean {
  if (name.length <= '.txt'.length || !/\.txt$/i.test(name) || NOT_IN_NAME.test(name)) return false;
  const path = `${FOLDER_DICTIONARY_DIR}/${name}`;
  try {
    return toVaultPath(path) === path;
  } catch {
    return false;
  }
}

/** Bytes UTF-8 sem codificar (metade de par vira U+FFFD no `TextEncoder`: 3 bytes). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit < 0xdc00 && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** O texto sem as linhas do termo, ou `null` se ele não está lá (comentários e o resto ficam). */
function withoutTerm(text: string, term: string): string | null {
  const lines = text.split('\n');
  const kept = lines.filter((line) => normalizeWord(line) !== term);
  return kept.length === lines.length ? null : kept.join('\n');
}

function codeOf(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : 'IO';
}

/** Mensagem do erro (a do Rust e a do vault não têm caminho). */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
    ? error.message
    : String(error);
}

/** A base ficou velha: o arquivo mudou, sumiu ou nasceu desde a leitura. */
function isStale(error: unknown): boolean {
  const code = codeOf(error);
  return code === 'CONFLICT' || code === 'ALREADY_EXISTS' || code === 'NOT_FOUND';
}

function fileProblem(code: string): string {
  switch (code) {
    case 'TOO_LARGE':
      return `passa de ${DICTIONARY_LIMITS.fileMaxBytes / MIB} MiB`;
    case 'NOT_UTF8':
      return 'não está em UTF-8';
    case 'OUTSIDE_VAULT':
      return 'é um link';
    default:
      return 'não pôde ser lido';
  }
}

/** Camada como foi lida: os arquivos legíveis em ordem, os com erro e os deixados de fora. */
interface RawFile {
  readonly name: string;
  readonly text: string;
  /** Global: sha256 dos bytes (do Rust). Pasta: `null` — a base vai como `{ mtime, text }`. */
  readonly sha256: string | null;
  readonly mtime: number;
}

interface RawLayer {
  readonly files: readonly RawFile[];
  readonly errors: readonly { readonly name: string; readonly code: string }[];
  readonly skipped: number;
}

const EMPTY_RAW: RawLayer = { files: [], errors: [], skipped: 0 };

/** O `pessoal.txt` lido: a base da próxima gravação e o tamanho em bytes. */
interface Personal extends RawFile {
  readonly bytes: number;
}

/**
 * `idle` = ainda não lida; `loading` = primeira leitura; `ready`; `error` = a última leitura falhou
 * (os termos são os da anterior); `none` = camada da pasta sem pasta aberta.
 */
export type DictionaryLayerStatus = 'idle' | 'loading' | 'ready' | 'error' | 'none';

interface LayerData {
  readonly status: DictionaryLayerStatus;
  readonly terms: ReadonlySet<string>;
  /** `undefined`: não existe (a gravação cria); `{ error }`: existe, mas não pôde ser lido. */
  readonly personal: Personal | { readonly error: string } | undefined;
  readonly warnings: readonly DictionaryWarning[];
}

/** Uma camada para quem a mostra (lista das Configurações, r32c). */
export interface DictionaryLayerView {
  readonly status: DictionaryLayerStatus;
  /** Na ordem dos arquivos, sem duplicatas, até o teto. */
  readonly terms: readonly string[];
  readonly warnings: readonly DictionaryWarning[];
}

/** Imutável; um objeto novo a cada mudança (`useSyncExternalStore`). */
export interface DictionarySnapshot {
  readonly global: DictionaryLayerView;
  readonly folder: DictionaryLayerView;
}

/** Remoção (D-R32-6): `absent` = o termo não estava em nenhum arquivo lido da camada. */
export type DictionaryRemoveResult =
  | { readonly status: 'removed' | 'absent' | 'invalid' | 'no-folder' }
  | { readonly status: 'failed'; readonly message: string };

const EMPTY_TERMS: ReadonlySet<string> = new Set();
const IDLE: LayerData = { status: 'idle', terms: EMPTY_TERMS, personal: undefined, warnings: [] };
const NO_FOLDER: LayerData = { ...IDLE, status: 'none' };

/** Termos, avisos e base do `pessoal.txt` de uma camada lida (tetos aplicados). */
function buildLayer(layer: DictionaryLayer, raw: RawLayer): LayerData {
  const terms = new Set<string>();
  let overflow = false;
  for (const file of raw.files) {
    for (const term of parseWordList(file.text)) {
      if (terms.has(term)) continue;
      if (terms.size === DICTIONARY_LIMITS.layerMaxTerms) {
        overflow = true;
        break;
      }
      terms.add(term);
    }
    if (overflow) break;
  }
  const where = LAYER_NAMES[layer];
  const warnings: DictionaryWarning[] = raw.errors.map(({ name, code }) => ({
    id: `${layer}:file:${name}`,
    layer,
    text: `o arquivo “${name.replace(/[\p{Cc}\p{Cf}]/gu, '\uFFFD')}” do dicionário ${where} ficou de fora: ${fileProblem(code)}.`,
  }));
  if (raw.skipped > 0)
    warnings.push({
      id: `${layer}:skipped`,
      layer,
      text: `o dicionário ${where} passa de ${DICTIONARY_LIMITS.layerMaxFiles} arquivos ou ${DICTIONARY_LIMITS.layerMaxBytes / MIB} MiB: ${raw.skipped === 1 ? '1 arquivo ficou' : `${raw.skipped} arquivos ficaram`} de fora.`,
    });
  if (overflow)
    warnings.push({
      id: `${layer}:terms`,
      layer,
      text: `o dicionário ${where} passa de ${DICTIONARY_LIMITS.layerMaxTerms.toLocaleString('pt-BR')} palavras: as que sobraram ficaram de fora.`,
    });
  const file = raw.files.find((f) => f.name === PERSONAL_DICTIONARY);
  const error = raw.errors.find((e) => e.name === PERSONAL_DICTIONARY);
  return {
    status: 'ready',
    terms,
    personal: file
      ? { ...file, bytes: utf8Length(file.text) }
      : error
        ? { error: error.code }
        : undefined,
    warnings,
  };
}

/** Camada de uma operação; a da pasta guarda a pasta e a geração em que foi pedida. */
type Target =
  | { readonly layer: 'global' }
  | { readonly layer: 'folder'; readonly handle: VaultHandle; readonly generation: number };

const GLOBAL_TARGET: Target = { layer: 'global' };

export interface DictionaryServiceDeps {
  /** Camada global (`AppPlatform.dictionaries`: `dict_global_read`/`dict_global_write`). */
  readonly port: DictionaryPort;
  /** Camada da pasta (`AppPlatform.vault`, classe `.simplemd/dictionaries/<nome>.txt`). */
  readonly vault: ContentVaultProvider;
  readonly clock: Clock;
}

export class DictionaryService implements DictionaryHost {
  readonly #deps: DictionaryServiceDeps;
  readonly #listeners = new Set<() => void>();
  /** Ids de aviso já entregues por `takeWarnings` (saem quando a causa some). */
  readonly #shown = new Set<string>();
  readonly #views = new WeakMap<LayerData, DictionaryLayerView>();
  /** Fila por camada: cargas e gravações da mesma camada nunca se intercalam. */
  readonly #queues: Record<DictionaryLayer, Promise<unknown>> = {
    global: Promise.resolve(),
    folder: Promise.resolve(),
  };
  #layers: Readonly<Record<DictionaryLayer, LayerData>> = { global: IDLE, folder: NO_FOLDER };
  #union: ReadonlySet<string> = EMPTY_TERMS;
  #snapshot: DictionarySnapshot | null = null;
  #started = false;
  #handle: VaultHandle | null = null;
  /** Muda a cada troca de pasta: o que foi pedido para a anterior não toca a camada da nova. */
  #generation = 0;
  #unwatch: (() => void) | null = null;
  #reload: unknown = null;

  constructor(deps: DictionaryServiceDeps) {
    this.#deps = deps;
  }

  /** Pasta aberta (gancho `afterOpen`): com o serviço em uso, relê as duas camadas e observa. */
  open(handle: VaultHandle): void {
    this.#detach();
    this.#handle = handle;
    this.#setLayer('folder', IDLE);
    if (!this.#started) return;
    this.#watch(handle);
    void this.#enqueue('global', () => this.#refresh(GLOBAL_TARGET));
    void this.#loadFolder();
  }

  /** Pasta fechada (gancho `beforeClose`): a camada da pasta sai da união. */
  close(): void {
    this.#detach();
    this.#handle = null;
    if (this.#layers.folder !== NO_FOLDER) this.#setLayer('folder', NO_FOLDER);
  }

  known(word: string): boolean {
    return inDictionary(this.#union, word);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    this.#start();
    return () => {
      this.#listeners.delete(listener);
    };
  }

  getSnapshot(): DictionarySnapshot {
    this.#snapshot ??= {
      global: this.#view(this.#layers.global),
      folder: this.#view(this.#layers.folder),
    };
    return this.#snapshot;
  }

  takeWarnings(): readonly DictionaryWarning[] {
    const { global, folder } = this.#layers;
    const fresh = [...global.warnings, ...folder.warnings].filter((w) => !this.#shown.has(w.id));
    for (const warning of fresh) this.#shown.add(warning.id);
    return fresh;
  }

  /** Começa a carga, se preciso, e espera as cargas e gravações já pedidas. */
  async ready(): Promise<void> {
    this.#start();
    await Promise.all([this.#queues.global, this.#queues.folder]);
  }

  add(word: string, layer: DictionaryLayer): Promise<DictionaryWriteResult> {
    const term = normalizeWord(word);
    return term === null ? Promise.resolve({ status: 'invalid' }) : this.#append(layer, [term]);
  }

  async addAll(
    words: readonly string[],
    layer: DictionaryLayer,
  ): Promise<DictionaryWriteResult & { readonly rejected: readonly string[] }> {
    const terms: string[] = [];
    const rejected: string[] = [];
    for (const word of words) {
      const term = normalizeWord(word);
      if (term === null) rejected.push(word);
      else terms.push(term);
    }
    const result: DictionaryWriteResult =
      terms.length === 0 ? { status: 'exists' } : await this.#append(layer, terms);
    return { ...result, rejected };
  }

  /**
   * Tira o termo de todos os arquivos lidos da camada (D-R32-6), relendo-a antes; os comentários e
   * as outras linhas ficam. Nunca rejeita.
   */
  remove(word: string, layer: DictionaryLayer): Promise<DictionaryRemoveResult> {
    const term = normalizeWord(word);
    if (term === null) return Promise.resolve({ status: 'invalid' });
    this.#start();
    const target = this.#target(layer);
    if (target === null) return Promise.resolve({ status: 'no-folder' });
    return this.#enqueue(layer, async (): Promise<DictionaryRemoveResult> => {
      for (let attempt = 0; ; attempt++) {
        if (this.#stale(target)) return { status: 'no-folder' };
        let raw: RawLayer;
        try {
          raw =
            target.layer === 'global'
              ? await this.#readGlobal()
              : await this.#readFolder(target.handle);
        } catch (error) {
          return { status: 'failed', message: messageOf(error) };
        }
        if (this.#stale(target)) return { status: 'no-folder' };
        const edits = raw.files.flatMap((file) => {
          const text = withoutTerm(file.text, term);
          return text === null ? [] : [{ file, text }];
        });
        if (edits.length === 0) {
          this.#setLayer(layer, buildLayer(layer, raw));
          return { status: 'absent' };
        }
        try {
          for (const { file, text } of edits) await this.#writeFile(target, file.name, text, file);
        } catch (error) {
          if (attempt === 0 && isStale(error)) continue;
          await this.#refresh(target);
          return { status: 'failed', message: messageOf(error) };
        }
        await this.#refresh(target);
        return { status: 'removed' };
      }
    }).catch((error: unknown) => ({ status: 'failed' as const, message: messageOf(error) }));
  }

  // --- interno ---------------------------------------------------------------------------------

  #start(): void {
    if (this.#started) return;
    this.#started = true;
    void this.#enqueue('global', () => this.#refresh(GLOBAL_TARGET));
    const handle = this.#handle;
    if (handle === null) return;
    this.#watch(handle);
    void this.#loadFolder();
  }

  #detach(): void {
    this.#generation++;
    this.#unwatch?.();
    this.#unwatch = null;
    if (this.#reload !== null) this.#deps.clock.clearTimeout(this.#reload);
    this.#reload = null;
  }

  /** `.txt` da pasta mudou por fora (outro programa, sincronização): relê a camada da pasta. */
  #watch(handle: VaultHandle): void {
    const { vault, clock } = this.#deps;
    if (!vault.watch) return;
    const prefix = `${FOLDER_DICTIONARY_DIR}/`;
    this.#unwatch = vault.watch(handle, (event) => {
      if (handle !== this.#handle || event.kind !== 'change') return;
      if (!event.paths.some((path) => path.startsWith(prefix))) return;
      if (this.#reload !== null) clock.clearTimeout(this.#reload);
      this.#reload = clock.setTimeout(() => {
        this.#reload = null;
        void this.#loadFolder();
      }, DICTIONARY_RELOAD_DEBOUNCE_MS);
    });
  }

  #enqueue<T>(layer: DictionaryLayer, task: () => Promise<T>): Promise<T> {
    const run = this.#queues[layer].then(task);
    this.#queues[layer] = run.catch(() => undefined);
    return run;
  }

  #target(layer: DictionaryLayer): Target | null {
    if (layer === 'global') return GLOBAL_TARGET;
    const handle = this.#handle;
    return handle === null ? null : { layer, handle, generation: this.#generation };
  }

  #stale(target: Target): boolean {
    return target.layer === 'folder' && target.generation !== this.#generation;
  }

  #loadFolder(): Promise<unknown> {
    const target = this.#target('folder');
    return target === null
      ? Promise.resolve()
      : this.#enqueue('folder', () => this.#refresh(target));
  }

  /** Relê a camada e publica; devolve a mensagem do erro de leitura (ou `null`). */
  async #refresh(target: Target): Promise<string | null> {
    if (this.#stale(target)) return null;
    const { layer } = target;
    const before = this.#layers[layer];
    if (before.status === 'idle') this.#setLayer(layer, { ...before, status: 'loading' });
    try {
      const raw =
        target.layer === 'global'
          ? await this.#readGlobal()
          : await this.#readFolder(target.handle);
      if (!this.#stale(target)) this.#setLayer(layer, buildLayer(layer, raw));
      return null;
    } catch (error) {
      if (!this.#stale(target))
        this.#setLayer(layer, {
          ...this.#layers[layer],
          status: 'error',
          warnings: [
            {
              id: `${layer}:read`,
              layer,
              text: `não foi possível ler o dicionário ${LAYER_NAMES[layer]} (${codeOf(error)}).`,
            },
          ],
        });
      return messageOf(error);
    }
  }

  async #readGlobal(): Promise<RawLayer> {
    const layer = await this.#deps.port.readGlobal();
    const files: RawFile[] = [];
    const errors: { name: string; code: string }[] = [];
    for (const file of layer.files) {
      if ('error' in file) errors.push({ name: file.name, code: file.error });
      else files.push({ name: file.name, text: file.text, sha256: file.sha256, mtime: 0 });
    }
    return { files, errors, skipped: layer.skipped };
  }

  /**
   * Os `.txt` da pasta com a semântica da leitura global do Rust: link → `OUTSIDE_VAULT`; acima de
   * 10 MiB → `TOO_LARGE` (0 leituras); 16 entradas (as com erro contam) e 20 MiB pelo `stat` antes
   * de ler — o que passa fica em `skipped`.
   */
  async #readFolder(handle: VaultHandle): Promise<RawLayer> {
    const { vault } = this.#deps;
    let items: FsDirItem[];
    try {
      items = await vault.listChildren(handle, FOLDER_DICTIONARY_DIR);
    } catch (error) {
      if (isVaultError(error, 'NOT_FOUND')) return EMPTY_RAW;
      throw error;
    }
    const files: RawFile[] = [];
    const errors: { name: string; code: string }[] = [];
    let skipped = 0;
    let budget: number = DICTIONARY_LIMITS.layerMaxBytes;
    const candidates = items
      .filter((item) => isDictionaryName(item.name))
      .sort((a, b) => layerOrder(a.name, b.name));
    for (const { name, kind } of candidates) {
      if (files.length + errors.length === DICTIONARY_LIMITS.layerMaxFiles) {
        skipped++;
        continue;
      }
      if (kind === 'symlink') {
        errors.push({ name, code: 'OUTSIDE_VAULT' });
        continue;
      }
      if (kind !== 'file') continue;
      const path = `${FOLDER_DICTIONARY_DIR}/${name}`;
      try {
        const stat = await vault.stat(handle, path);
        if (stat === null || stat.kind !== 'file') continue; // sumiu ou virou pasta
        if (stat.size > DICTIONARY_LIMITS.fileMaxBytes) {
          errors.push({ name, code: 'TOO_LARGE' });
          continue;
        }
        if (stat.size > budget) {
          skipped++;
          continue;
        }
        budget -= stat.size;
        const { text, mtime } = await vault.read(handle, path);
        files.push({ name, text, sha256: null, mtime });
      } catch (error) {
        if (!isVaultError(error, 'NOT_FOUND')) errors.push({ name, code: codeOf(error) });
      }
    }
    return { files, errors, skipped };
  }

  /** Grava `name` na camada: sem base só cria; com base, só se o arquivo ainda for o lido. */
  async #writeFile(
    target: Target,
    name: string,
    text: string,
    base: RawFile | undefined,
  ): Promise<RawFile> {
    if (target.layer === 'global') {
      const expected =
        base === undefined ? null : (base.sha256 ?? sha256Hex(encoder.encode(base.text)));
      await this.#deps.port.writeGlobal(name, text, expected);
      return { name, text, sha256: sha256Hex(encoder.encode(text)), mtime: 0 };
    }
    const { vault } = this.#deps;
    const path = `${FOLDER_DICTIONARY_DIR}/${name}`;
    const { mtime } =
      base === undefined
        ? await vault.write(target.handle, path, text)
        : await vault.writeIfUnchanged(target.handle, path, text, {
            mtime: base.mtime,
            text: base.text,
          });
    return { name, text, sha256: null, mtime };
  }

  /** Acrescenta os termos (já normalizados) ao `pessoal.txt` da camada, numa gravação só. */
  #append(layer: DictionaryLayer, terms: readonly string[]): Promise<DictionaryWriteResult> {
    this.#start();
    const target = this.#target(layer);
    if (target === null) return Promise.resolve({ status: 'no-folder' });
    return this.#enqueue(layer, async (): Promise<DictionaryWriteResult> => {
      for (let attempt = 0; ; attempt++) {
        if (this.#stale(target)) return { status: 'no-folder' };
        if (this.#layers[layer].status !== 'ready') {
          const failure = await this.#refresh(target);
          if (failure !== null) return { status: 'failed', message: failure };
          if (this.#stale(target)) return { status: 'no-folder' };
        }
        const data = this.#layers[layer];
        const fresh = [...new Set(terms)].filter((term) => !data.terms.has(term));
        if (fresh.length === 0) return { status: 'exists' };
        if (data.terms.size + fresh.length > DICTIONARY_LIMITS.layerMaxTerms)
          return { status: 'full' };
        const { personal } = data;
        if (personal !== undefined && 'error' in personal)
          return {
            status: 'failed',
            message: `o ${PERSONAL_DICTIONARY} ${fileProblem(personal.error)}`,
          };
        const before = personal?.text ?? '';
        const addition = `${before === '' || before.endsWith('\n') ? '' : '\n'}${fresh.join('\n')}\n`;
        const bytes = (personal?.bytes ?? 0) + utf8Length(addition);
        if (bytes > DICTIONARY_LIMITS.fileMaxBytes) return { status: 'full' };
        let written: RawFile;
        try {
          written = await this.#writeFile(target, PERSONAL_DICTIONARY, before + addition, personal);
        } catch (error) {
          if (attempt === 0 && isStale(error) && (await this.#refresh(target)) === null) continue;
          return { status: 'failed', message: messageOf(error) };
        }
        if (!this.#stale(target)) {
          const current = this.#layers[layer];
          const next = new Set(current.terms);
          for (const term of fresh) next.add(term);
          this.#setLayer(layer, { ...current, terms: next, personal: { ...written, bytes } });
        }
        return { status: 'added' };
      }
    }).catch((error: unknown) => ({ status: 'failed' as const, message: messageOf(error) }));
  }

  #setLayer(layer: DictionaryLayer, data: LayerData): void {
    const before = this.#layers[layer];
    this.#layers = { ...this.#layers, [layer]: data };
    if (data.terms !== before.terms) {
      const { global, folder } = this.#layers;
      if (folder.terms.size === 0) this.#union = global.terms;
      else if (global.terms.size === 0) this.#union = folder.terms;
      else {
        const union = new Set(global.terms);
        for (const term of folder.terms) union.add(term);
        this.#union = union;
      }
    }
    const live = new Set(
      [...this.#layers.global.warnings, ...this.#layers.folder.warnings].map((w) => w.id),
    );
    for (const id of this.#shown) if (!live.has(id)) this.#shown.delete(id);
    this.#snapshot = null;
    for (const listener of [...this.#listeners]) listener();
  }

  #view(data: LayerData): DictionaryLayerView {
    let view = this.#views.get(data);
    if (view === undefined) {
      view = { status: data.status, terms: [...data.terms], warnings: data.warnings };
      this.#views.set(data, view);
    }
    return view;
  }
}
