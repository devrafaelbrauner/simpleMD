import { VAULT_CONFIG_FILES, isVaultConfigFile, type VaultConfigFile } from './config-files';
import { ConflictError, VaultError, isVaultError } from './errors';
import { sha256Hex } from './hash';
import { IMAGE_MIME, imageKindOf, imageMaxBytes, sniffImage } from './image-type';
import { toVaultPath } from './path';
import type { FsDirItem, FsKind, FsPort, FsStat } from './port';
import type {
  ContentBase,
  ContentVaultProvider,
  Entry,
  NoteStat,
  Unsubscribe,
  VaultHandle,
  VaultImage,
  VaultWatchEvent,
} from './types';

/** Limite de leitura por caminho, verificado pelo `lstat` ANTES de ler (arch-backend §1.6). */
export interface ReadLimit {
  match(path: string): boolean;
  readonly maxBytes: number;
}

export interface LocalFsProviderOptions {
  readonly readLimits?: readonly ReadLimit[];
}

/**
 * Uma versão que o provider serviu: só o hash, nunca os bytes (CR-13). `origin` diz se ela veio de
 * uma leitura (pode ser uma versão externa) ou de uma escrita autorizada por este provider.
 */
interface ServedVersion {
  readonly mtime: number;
  readonly sha256: string;
  readonly origin: 'read' | 'write';
}

/**
 * Observação da porta de um vault, repartida entre os ouvintes de `watch` (r36a, D-R36-5): no Tauri
 * o Rust mantém UM observador por pasta e um 2º `vault_watch` tomaria o canal do 1º.
 */
interface SharedWatch {
  readonly listeners: Set<(event: VaultWatchEvent) => void>;
  /** A porta já respondeu: a observação começou (`stop`) ou falhou ao começar. */
  settled: boolean;
  /** Encerra a observação da porta; `null` até ela começar. */
  stop: (() => void) | null;
  /** Última falha: quem chegar depois também recebe `unavailable` com ela. */
  failure: string | null;
}

/** Versões guardadas por caminho no registro de versões servidas; a mais antiga sai primeiro. */
const SERVED_CAP = 16;

/** NFR-4: leituras de diretório em paralelo, no máximo 16 de cada vez. */
const LIST_CONCURRENCY = 16;
const CONFIG_PREFIX = '.simplemd/';
/** Dependências do npm/pnpm: listadas, nunca observadas (r36a, D-R36-3). */
const NODE_MODULES = 'node_modules';
const MD_FILE = /\.md$/i;
const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function byName(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Código de plugin: `.simplemd/plugins/<id>/**\/*.js`, só leitura (arch-backend r2 §1.2). */
const PLUGIN_CODE = /^\.simplemd\/plugins\/[^/]+\/(?:[^/]+\/)*[^/]+\.js$/;

/**
 * Dicionário da pasta (r32a): `.simplemd/dictionaries/<nome>.txt`, direto na pasta deles, legível e
 * gravável, com teto de 10 MiB na leitura e na gravação — o mesmo da camada global no Rust
 * (`policy::DICTIONARY_MAX_BYTES`). Como no Rust (`policy::file_class`), o prefixo tem a caixa exata
 * e só a extensão ignora a caixa (code review r32a, item 4).
 */
const DICTIONARY_FILE = /^\.simplemd\/dictionaries\/[^/]+\.[tT][xX][tT]$/;
const DICTIONARY_MAX_BYTES = 10 * 1024 * 1024;
/** Teto de leitura da classe, antes dos limites das opções (uma opção nunca o afrouxa). */
const DICTIONARY_LIMIT: ReadLimit = {
  match: (path) => DICTIONARY_FILE.test(path),
  maxBytes: DICTIONARY_MAX_BYTES,
};

/** Caminho de dicionário da pasta que a guarda aceitaria (sem nome oculto, reservado etc.). */
function isDictionaryFile(rel: string): boolean {
  if (!DICTIONARY_FILE.test(rel)) return false;
  try {
    return toVaultPath(rel) === rel;
  } catch {
    return false;
  }
}

/**
 * Classes de caminho legíveis/graváveis (defesa em profundidade sobre a guarda): `*.md` fora de
 * pastas ocultas, `.simplemd/**\/*.json` e os dicionários `.simplemd/dictionaries/<nome>.txt`
 * (r32a); o código de plugin (`.js`) só é legível. Qualquer outro caminho falha antes de tocar a
 * porta.
 */
function assertFileClass(rel: string, access: 'read' | 'write' = 'write'): void {
  const ok = rel.startsWith(CONFIG_PREFIX)
    ? rel.endsWith('.json') ||
      DICTIONARY_FILE.test(rel) ||
      (access === 'read' && PLUGIN_CODE.test(rel))
    : MD_FILE.test(rel);
  if (!ok) throw new VaultError('INVALID_PATH', 'Tipo de arquivo não permitido.', { path: rel });
}

/** Dicionário da pasta acima de 10 MiB (r32a) → `TOO_LARGE` antes de tocar a porta. */
function assertWriteCap(rel: string, bytes: Uint8Array): void {
  if (bytes.length > DICTIONARY_MAX_BYTES && DICTIONARY_FILE.test(rel))
    throw new VaultError('TOO_LARGE', 'Arquivo grande demais.', { path: rel });
}

/**
 * Caminhos absolutos de um lote da porta → relativos ao vault, sem repetir. Ficam de fora o que
 * está fora da raiz, a própria raiz, `node_modules/` (r36a, D-R36-3) e os ocultos, exceto os 3
 * arquivos de configuração da lista (r7 §1.13) e os dicionários da pasta (r32a). No Tauri o Rust já
 * filtra pela política (`policy::watchable`); aqui vale para toda porta.
 */
function watchedPaths(root: string, absPaths: readonly string[]): string[] {
  const paths = new Set<string>();
  for (const abs of absPaths) {
    const norm = abs.replace(/\\/g, '/');
    if (!norm.startsWith(`${root}/`)) continue;
    const rel = norm.slice(root.length + 1);
    const segments = rel.split('/');
    if (rel === '' || segments.includes(NODE_MODULES)) continue;
    const hidden = segments.some((s) => s === '' || s.startsWith('.'));
    if (hidden && !isVaultConfigFile(rel) && !isDictionaryFile(rel)) continue;
    paths.add(rel);
  }
  return [...paths];
}

/**
 * Semáforo para limitar leituras de diretório concorrentes. Ao terminar, a vaga passa direto para
 * quem espera (sem decrementar), então nunca há mais de `max` tarefas ativas (CR-15). Sem
 * `Promise.withResolvers`, que o WKWebView do macOS < 14.4 não tem (CR-08).
 */
function limiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (task) => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/**
 * `VaultProvider` sobre uma `FsPort` (arch-backend §1.5). Toda a lógica de segurança mora aqui e é
 * a mesma em produção (Tauri), nos testes (Node, memória) e no harness do Chromium.
 */
export class LocalFsProvider implements ContentVaultProvider {
  readonly #port: FsPort;
  readonly #readLimits: readonly ReadLimit[];
  /**
   * Registro de versões servidas por vault e caminho (RR-03, D-B1): toda leitura e escrita bem
   * sucedida anota `{mtime, sha256, origin}`, no máximo 16 por caminho. A escrita §4.3 com
   * `expectedMtime` resolve a base por ele.
   */
  readonly #served = new Map<string, ServedVersion[]>();
  /** Mutex por caminho: escritas, leituras de checagem e cópias nunca se intercalam no mesmo arquivo. */
  readonly #locks = new Map<string, Promise<unknown>>();
  /** Observação da porta por vault (`handle.id`), repartida entre os ouvintes (r36a, D-R36-5). */
  readonly #watches = new Map<string, SharedWatch>();
  #nextHandle = 0;

  constructor(port: FsPort, options: LocalFsProviderOptions = {}) {
    this.#port = port;
    this.#readLimits = [DICTIONARY_LIMIT, ...(options.readLimits ?? [])];
  }

  async open(): Promise<VaultHandle> {
    const root = await this.#port.pickDirectory();
    if (root === null) throw new VaultError('CANCELLED', 'Seleção de pasta cancelada.');
    const name = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
    return { id: `vault-${++this.#nextHandle}`, name, root };
  }

  activate(handle: VaultHandle): void {
    this.#port.activateDirectory?.(handle.root);
    // CR2-11: as versões servidas das pastas fechadas não servem mais para nada.
    const prefix = `${handle.id}\u0000`;
    for (const key of [...this.#served.keys()]) {
      if (!key.startsWith(prefix)) this.#served.delete(key);
    }
  }

  abandon(handle: VaultHandle): void {
    this.#port.abandonDirectory?.(handle.root);
  }

  async list(handle: VaultHandle, dir = ''): Promise<Entry[]> {
    const rel = dir === '' ? '' : toVaultPath(dir);
    if (rel !== '') {
      const stat = await this.#walk(handle, rel);
      if (stat === null) throw new VaultError('NOT_FOUND', 'Pasta não encontrada.', { path: rel });
      if (stat.kind !== 'dir')
        throw new VaultError('INVALID_PATH', 'Não é uma pasta.', { path: rel });
    }
    return this.#listDir(handle, rel, limiter(LIST_CONCURRENCY));
  }

  async read(handle: VaultHandle, path: string): Promise<{ text: string; mtime: number }> {
    const rel = toVaultPath(path);
    assertFileClass(rel);
    return this.#locked(handle, rel, async () => {
      const stat = await this.#walk(handle, rel);
      if (stat === null)
        throw new VaultError('NOT_FOUND', 'Arquivo não encontrado.', { path: rel });
      if (stat.kind !== 'file')
        throw new VaultError('INVALID_PATH', 'Não é um arquivo.', { path: rel });
      const limit = this.#readLimits.find((l) => l.match(rel));
      if (limit && stat.size > limit.maxBytes) {
        throw new VaultError('TOO_LARGE', 'Arquivo grande demais.', { path: rel });
      }
      const bytes = await this.#port.readFile(this.#port.join(handle.root, rel));
      let text: string;
      try {
        text = decoder.decode(bytes);
      } catch (cause) {
        throw new VaultError('NOT_UTF8', 'O arquivo não está em UTF-8.', { path: rel, cause });
      }
      this.#record(this.#key(handle, rel), stat.mtime, bytes, 'read');
      return { text, mtime: stat.mtime };
    });
  }

  /**
   * Bytes crus de um arquivo legível (código de plugin, manifestos; arch-backend r2 §1.2), lidos
   * UMA vez. Acima de `maxBytes` (ou do teto da classe) → `TOO_LARGE` com 0 leituras: o tamanho
   * vem do `lstat`.
   */
  async readBytes(
    handle: VaultHandle,
    path: string,
    options: { maxBytes?: number } = {},
  ): Promise<{ bytes: Uint8Array; mtime: number }> {
    const rel = toVaultPath(path);
    assertFileClass(rel, 'read');
    return this.#locked(handle, rel, async () => {
      const stat = await this.#walk(handle, rel);
      if (stat === null)
        throw new VaultError('NOT_FOUND', 'Arquivo não encontrado.', { path: rel });
      if (stat.kind !== 'file')
        throw new VaultError('INVALID_PATH', 'Não é um arquivo.', { path: rel });
      const caps = [options.maxBytes, this.#readLimits.find((l) => l.match(rel))?.maxBytes];
      if (caps.some((cap) => cap !== undefined && stat.size > cap)) {
        throw new VaultError('TOO_LARGE', 'Arquivo grande demais.', { path: rel });
      }
      const bytes = await this.#port.readFile(this.#port.join(handle.root, rel));
      return { bytes, mtime: stat.mtime };
    });
  }

  /** Guarda + caminhada: `stat` do caminho dentro do vault, `null` se não existe (0 leituras). */
  async stat(handle: VaultHandle, path: string): Promise<FsStat | null> {
    return this.#walk(handle, toVaultPath(path));
  }

  /** Filhos diretos de uma pasta (sem recursão), sem itens ocultos, na ordem de nome. */
  async listChildren(handle: VaultHandle, dir: string): Promise<FsDirItem[]> {
    const rel = toVaultPath(dir);
    const stat = await this.#walk(handle, rel);
    if (stat === null) throw new VaultError('NOT_FOUND', 'Pasta não encontrada.', { path: rel });
    if (stat.kind !== 'dir')
      throw new VaultError('INVALID_PATH', 'Não é uma pasta.', { path: rel });
    const items = await this.#port.readDir(this.#port.join(handle.root, rel));
    return items
      .filter((item) => !item.name.startsWith('.'))
      .map(({ name, kind }) => ({ name, kind }))
      .sort((a, b) => byName(a.name, b.name));
  }

  /** Notas de todo o vault ou só de `dir` (e subpastas); pasta oculta → nenhuma. */
  async listNotes(handle: VaultHandle, dir = ''): Promise<NoteStat[]> {
    const notes: NoteStat[] = [];
    const rel = dir === '' ? '' : toVaultPath(dir);
    if (rel !== '') {
      if (rel.split('/').some((segment) => segment.startsWith('.'))) return notes;
      const stat = await this.#walk(handle, rel);
      if (stat === null) throw new VaultError('NOT_FOUND', 'Pasta não encontrada.', { path: rel });
      if (stat.kind !== 'dir')
        throw new VaultError('INVALID_PATH', 'Não é uma pasta.', { path: rel });
    }
    await this.#notesIn(handle, rel, limiter(LIST_CONCURRENCY), notes);
    return notes;
  }

  /**
   * Imagem do vault (r7 §1.3, R-I1.7). Ordem: guarda de caminho → nada sob `.simplemd/`
   * (`PERMISSION_DENIED`) → tipo pela extensão (`UNSUPPORTED_IMAGE`) → caminhada sem links
   * (`OUTSIDE_VAULT`/`NOT_FOUND`/`INVALID_PATH`) → teto pelo `lstat` (`TOO_LARGE` com 0 leituras) →
   * bytes (`port.readImage` se houver; senão `readFile`) → teto de novo → bytes mágicos. Imagem não
   * é escrita: nada vai para o registro de versões servidas.
   */
  async readImage(handle: VaultHandle, path: string): Promise<VaultImage> {
    const rel = toVaultPath(path);
    if (rel.startsWith(CONFIG_PREFIX))
      throw new VaultError('PERMISSION_DENIED', 'Imagem na pasta de configuração.', { path: rel });
    const kind = imageKindOf(rel);
    if (kind === null)
      throw new VaultError('UNSUPPORTED_IMAGE', 'Tipo de imagem não suportado.', { path: rel });
    return this.#locked(handle, rel, async () => {
      const stat = await this.#walk(handle, rel);
      if (stat === null) throw new VaultError('NOT_FOUND', 'Imagem não encontrada.', { path: rel });
      if (stat.kind !== 'file')
        throw new VaultError('INVALID_PATH', 'Não é um arquivo.', { path: rel });
      const cap = imageMaxBytes(kind);
      if (stat.size > cap)
        throw new VaultError('TOO_LARGE', 'Imagem grande demais.', { path: rel });
      const port = this.#port;
      const abs = port.join(handle.root, rel);
      const bytes = port.readImage ? await port.readImage(abs) : await port.readFile(abs);
      if (bytes.length > cap)
        throw new VaultError('TOO_LARGE', 'Imagem grande demais.', { path: rel });
      if (!sniffImage(kind, bytes))
        throw new VaultError('UNSUPPORTED_IMAGE', 'Tipo de imagem não suportado.', { path: rel });
      return { bytes, kind, mime: IMAGE_MIME[kind], mtime: stat.mtime, size: bytes.length };
    });
  }

  /**
   * Arquivo de configuração da lista fechada (r7 §1.13): `null` se não existe; link →
   * `OUTSIDE_VAULT`; acima do teto → `TOO_LARGE` sem ler; não UTF-8 → `NOT_UTF8`. Os nomes são as
   * constantes da lista (fora de `toVaultPath`, que continua recusando segmentos ocultos).
   */
  async readConfigFile(
    handle: VaultHandle,
    name: VaultConfigFile,
  ): Promise<{ text: string; mtime: number } | null> {
    if (!isVaultConfigFile(name))
      throw new VaultError('PERMISSION_DENIED', 'Arquivo fora da lista.', { path: name });
    const cap = VAULT_CONFIG_FILES[name];
    return this.#locked(handle, name, async () => {
      const stat = await this.#walk(handle, name);
      if (stat === null) return null;
      if (stat.kind !== 'file')
        throw new VaultError('INVALID_PATH', 'Não é um arquivo.', { path: name });
      if (stat.size > cap)
        throw new VaultError('TOO_LARGE', 'Arquivo grande demais.', { path: name });
      const bytes = await this.#port.readFile(this.#port.join(handle.root, name));
      if (bytes.length > cap)
        throw new VaultError('TOO_LARGE', 'Arquivo grande demais.', { path: name });
      try {
        return { text: decoder.decode(bytes), mtime: stat.mtime };
      } catch (cause) {
        throw new VaultError('NOT_UTF8', 'O arquivo não está em UTF-8.', { path: name, cause });
      }
    });
  }

  /**
   * Escrita §4.3. Sem `expectedMtime` só cria. Com ele, a base vem do registro de versões servidas
   * com esse `mtime`: se a mais recente veio de uma escrita deste provider, ela é a base (o chamador
   * recebeu esse `mtime` dela; regra do r1 para gravações seguidas no mesmo tique); senão todas
   * precisam ter o mesmo hash — duas versões lidas no mesmo tique = base ambígua → conflito (RR-03).
   * Um `mtime` que o provider nunca serviu não autoriza nada. Só um caminho sem nenhum histórico
   * neste provider cai na regra do r1 (`mtime` igual → o conteúdo de agora é a base; a troca continua
   * condicional). O app grava por `writeIfUnchanged`.
   */
  async write(
    handle: VaultHandle,
    path: string,
    text: string,
    expectedMtime?: number,
  ): Promise<{ mtime: number }> {
    // r7 §1.13: os arquivos de configuração da lista são só leitura.
    if (isVaultConfigFile(path))
      throw new VaultError('PERMISSION_DENIED', 'Arquivo só de leitura.', { path });
    const rel = toVaultPath(path);
    assertFileClass(rel);
    const bytes = encoder.encode(text);
    assertWriteCap(rel, bytes);
    return this.#locked(handle, rel, async () => {
      const port = this.#port;
      const key = this.#key(handle, rel);
      const stat = await this.#walk(handle, rel);
      if (expectedMtime === undefined) {
        // Só cria: não existe caminho na API para sobrescrever às cegas (arch-backend C-3/C-12).
        if (stat !== null) {
          throw new VaultError('ALREADY_EXISTS', 'O arquivo já existe.', { path: rel });
        }
        const slash = rel.lastIndexOf('/');
        if (slash !== -1) await port.mkdirp(port.join(handle.root, rel.slice(0, slash)));
        const abs = port.join(handle.root, rel);
        await port.writeFile(abs, bytes, 'create-new');
        return this.#afterWrite(key, rel, abs, bytes);
      }
      const history = this.#served.get(key);
      if (history === undefined) {
        if (stat === null) throw new ConflictError(rel, expectedMtime, null, 'deleted');
        if (stat.kind !== 'file')
          throw new VaultError('INVALID_PATH', 'Não é um arquivo.', { path: rel });
        if (stat.mtime !== expectedMtime) {
          throw new ConflictError(rel, expectedMtime, stat.mtime, 'modified');
        }
        const abs = port.join(handle.root, rel);
        const current = sha256Hex(await port.readFile(abs));
        return this.#replace(key, rel, abs, bytes, current, expectedMtime, stat.mtime);
      }
      const atMtime = history.filter((v) => v.mtime === expectedMtime);
      const latest = atMtime.at(-1);
      const unambiguous =
        latest !== undefined &&
        (latest.origin === 'write' || atMtime.every((v) => v.sha256 === latest.sha256));
      return this.#writeIfBase(handle, rel, stat, bytes, {
        mtime: expectedMtime,
        expected: unambiguous ? latest.sha256 : null,
      });
    });
  }

  async writeIfUnchanged(
    handle: VaultHandle,
    path: string,
    text: string,
    base: ContentBase,
  ): Promise<{ mtime: number }> {
    if (isVaultConfigFile(path))
      throw new VaultError('PERMISSION_DENIED', 'Arquivo só de leitura.', { path });
    const rel = toVaultPath(path);
    assertFileClass(rel);
    const bytes = encoder.encode(text);
    assertWriteCap(rel, bytes);
    return this.#locked(handle, rel, async () => {
      const stat = await this.#walk(handle, rel);
      return this.#writeIfBase(handle, rel, stat, bytes, {
        mtime: base.mtime,
        expected: 'text' in base ? encoder.encode(base.text) : base.sha256,
      });
    });
  }

  /**
   * Núcleo da escrita por base de conteúdo (D-B1), já dentro do mutex e depois do `#walk`: uma só
   * operação condicional na porta, que confere o sha256 da base e troca o arquivo juntas (r26,
   * D-R26-2; no Tauri, no Rust). A base são os bytes (`Uint8Array`) ou o sha256 (`string`) dela;
   * `null` = base desconhecida ou ambígua, que nunca autoriza (0 chamadas à porta). O `mtime` da base
   * só preenche o `ConflictError`.
   */
  async #writeIfBase(
    handle: VaultHandle,
    rel: string,
    stat: FsStat | null,
    bytes: Uint8Array,
    base: { readonly mtime: number; readonly expected: Uint8Array | string | null },
  ): Promise<{ mtime: number }> {
    if (stat === null) throw new ConflictError(rel, base.mtime, null, 'deleted');
    if (stat.kind !== 'file')
      throw new VaultError('INVALID_PATH', 'Não é um arquivo.', { path: rel });
    const { expected } = base;
    if (expected === null) throw new ConflictError(rel, base.mtime, stat.mtime, 'modified');
    const expectedSha256 = typeof expected === 'string' ? expected : sha256Hex(expected);
    const abs = this.#port.join(handle.root, rel);
    const key = this.#key(handle, rel);
    return this.#replace(key, rel, abs, bytes, expectedSha256, base.mtime, stat.mtime);
  }

  /**
   * Sobrescrita condicional (r26): `CONFLICT` da porta → `ConflictError` "modified"; `NOT_FOUND` (o
   * arquivo sumiu depois do `#walk`) → "deleted". Bytes iguais aos do disco: a porta não grava e o
   * `lstat` devolve o mesmo `mtime` (D-4 / AC-2.6).
   */
  async #replace(
    key: string,
    rel: string,
    abs: string,
    bytes: Uint8Array,
    expectedSha256: string,
    baseMtime: number,
    statMtime: number,
  ): Promise<{ mtime: number }> {
    try {
      await this.#port.writeFile(abs, bytes, { expectedSha256 });
    } catch (error) {
      if (isVaultError(error, 'CONFLICT'))
        throw new ConflictError(rel, baseMtime, statMtime, 'modified');
      if (isVaultError(error, 'NOT_FOUND'))
        throw new ConflictError(rel, baseMtime, null, 'deleted');
      throw error;
    }
    return this.#afterWrite(key, rel, abs, bytes);
  }

  async #afterWrite(
    key: string,
    rel: string,
    abs: string,
    bytes: Uint8Array,
  ): Promise<{ mtime: number }> {
    const after = await this.#port.lstat(abs);
    if (after === null)
      throw new VaultError('IO', 'O arquivo sumiu após a gravação.', { path: rel });
    this.#record(key, after.mtime, bytes, 'write');
    return { mtime: after.mtime };
  }

  /** Anota uma versão servida; a mesma versão de novo só vai para o fim (sem duplicar). */
  #record(key: string, mtime: number, bytes: Uint8Array, origin: ServedVersion['origin']): void {
    const sha256 = sha256Hex(bytes);
    const history = (this.#served.get(key) ?? []).filter(
      (v) => v.mtime !== mtime || v.sha256 !== sha256,
    );
    history.push({ mtime, sha256, origin });
    if (history.length > SERVED_CAP) history.splice(0, history.length - SERVED_CAP);
    this.#served.set(key, history);
  }

  /**
   * Uma observação da porta por vault (`handle.id`), repartida entre os ouvintes (r36a, D-R36-5):
   * o primeiro a abre; o último a sair a encerra (se ela ainda está começando, ao começar). Falha —
   * inclusive uma porta que lança em vez de rejeitar — → `unavailable` para todos e para quem chegar
   * depois (o app passa a sondar). Cada ouvinte é isolado: um que lança não corta a entrega aos
   * outros (o erro vai para o console). Um evento vai a quem estava inscrito quando ele chegou: quem
   * entra durante a entrega de uma falha recebe `unavailable` uma vez só, pela fila.
   */
  watch(handle: VaultHandle, cb: (event: VaultWatchEvent) => void): Unsubscribe {
    const port = this.#port;
    if (!port.watch) {
      queueMicrotask(() => cb({ kind: 'unavailable', reason: 'sem observação de arquivos' }));
      return () => {};
    }
    let shared = this.#watches.get(handle.id);
    if (shared === undefined) {
      const entry: SharedWatch = {
        listeners: new Set(),
        settled: false,
        stop: null,
        failure: null,
      };
      this.#watches.set(handle.id, entry);
      const root = handle.root.replace(/\\/g, '/').replace(/\/+$/, '');
      // Os inscritos quando o evento chega (cópia do conjunto) que seguem inscritos na vez deles.
      const each = (event: () => VaultWatchEvent) => {
        for (const listener of [...entry.listeners])
          if (entry.listeners.has(listener)) listener(event());
      };
      const fail = (reason: string) => {
        entry.failure = reason;
        each(() => ({ kind: 'unavailable', reason }));
      };
      const onPaths = (absPaths: string[]) => {
        const paths = watchedPaths(root, absPaths);
        if (paths.length > 0) each(() => ({ kind: 'change', paths: [...paths] }));
      };
      let started: Promise<() => void>;
      try {
        started = port.watch(handle.root, onPaths, fail);
      } catch (error) {
        // Uma porta que lança em vez de rejeitar: a mesma falha, sem deixar a entrada presa.
        started = Promise.reject(error);
      }
      started.then(
        (unwatch) => {
          entry.settled = true;
          entry.stop = unwatch;
          if (entry.listeners.size === 0) this.#closeWatch(handle.id, entry);
        },
        (error: unknown) => {
          entry.settled = true;
          if (entry.listeners.size === 0) this.#closeWatch(handle.id, entry);
          else fail(error instanceof Error ? error.message : String(error));
        },
      );
      shared = entry;
    }
    const entry = shared;
    // Um embrulho por inscrição: a mesma função inscrita duas vezes recebe e sai duas vezes, e um
    // ouvinte que lança não impede a entrega aos outros.
    const listener = (event: VaultWatchEvent) => {
      try {
        cb(event);
      } catch (error) {
        console.error('[simplemd] um ouvinte da observação do vault lançou', error);
      }
    };
    entry.listeners.add(listener);
    if (entry.failure !== null) {
      const reason = entry.failure;
      queueMicrotask(() => {
        if (entry.listeners.has(listener)) listener({ kind: 'unavailable', reason });
      });
    }
    return () => {
      if (!entry.listeners.delete(listener)) return;
      if (entry.listeners.size === 0 && entry.settled) this.#closeWatch(handle.id, entry);
    };
  }

  /** Sem ouvintes e com a resposta da porta: a observação sai do registro e para. */
  #closeWatch(id: string, entry: SharedWatch): void {
    if (this.#watches.get(id) === entry) this.#watches.delete(id);
    entry.stop?.();
  }

  #key(handle: VaultHandle, rel: string): string {
    return `${handle.id}\u0000${rel}`;
  }

  async #locked<T>(handle: VaultHandle, rel: string, task: () => Promise<T>): Promise<T> {
    const key = this.#key(handle, rel);
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.catch(() => undefined);
    this.#locks.set(key, settled);
    try {
      return await run;
    } finally {
      if (this.#locks.get(key) === settled) this.#locks.delete(key);
    }
  }

  /**
   * Percorre cada prefixo existente com `lstat`, sempre dentro da raiz (AC-2.7: 0 chamadas fora).
   * Qualquer link simbólico (ou junção do Windows) no caminho é recusado: links nunca são seguidos.
   * Devolve o `stat` do último componente, ou `null` no primeiro componente inexistente.
   */
  async #walk(handle: VaultHandle, rel: string): Promise<FsStat | null> {
    const segments = rel.split('/');
    let stat: FsStat | null = null;
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join('/');
      stat = await this.#port.lstat(this.#port.join(handle.root, prefix));
      if (stat === null) return null;
      if (stat.kind === 'symlink') {
        throw new VaultError('OUTSIDE_VAULT', 'Links simbólicos não são seguidos.', {
          path: prefix,
        });
      }
      if (i < segments.length && stat.kind !== 'dir') {
        throw new VaultError('INVALID_PATH', 'Um componente do caminho não é pasta.', {
          path: prefix,
        });
      }
    }
    return stat;
  }

  async #listDir(
    handle: VaultHandle,
    rel: string,
    limit: <T>(task: () => Promise<T>) => Promise<T>,
  ): Promise<Entry[]> {
    const port = this.#port;
    const abs = rel === '' ? handle.root : port.join(handle.root, rel);
    const items = await limit(() => port.readDir(abs));
    const dirs: string[] = [];
    const files: string[] = [];
    for (const { name, kind } of items) {
      // Itens ocultos, links, não-.md e nomes que a guarda recusaria não aparecem (R-2.3).
      if (name.startsWith('.') || !this.#listable(rel, name, kind)) continue;
      (kind === 'dir' ? dirs : files).push(name);
    }
    dirs.sort(byName);
    files.sort(byName);
    const children = await Promise.all(
      dirs.map((name) => this.#listDir(handle, rel === '' ? name : `${rel}/${name}`, limit)),
    );
    const entries: Entry[] = [];
    dirs.forEach((name, i) => {
      entries.push({ path: rel === '' ? name : `${rel}/${name}`, name, kind: 'dir' });
      entries.push(...(children[i] ?? []));
    });
    for (const name of files) {
      entries.push({ path: rel === '' ? name : `${rel}/${name}`, name, kind: 'file' });
    }
    return entries;
  }

  /** Percorre como `#listDir`, guardando só as notas com tamanho, mtime e a marca de só na nuvem. */
  async #notesIn(
    handle: VaultHandle,
    rel: string,
    limit: <T>(task: () => Promise<T>) => Promise<T>,
    out: NoteStat[],
  ): Promise<void> {
    const port = this.#port;
    const abs = rel === '' ? handle.root : port.join(handle.root, rel);
    const items = await limit(() => port.readDir(abs));
    const dirs: Promise<void>[] = [];
    for (const item of items) {
      if (item.name.startsWith('.') || !this.#listable(rel, item.name, item.kind)) continue;
      const path = rel === '' ? item.name : `${rel}/${item.name}`;
      if (item.kind === 'dir') {
        dirs.push(this.#notesIn(handle, path, limit, out));
      } else if (item.size !== undefined && item.mtime !== undefined) {
        const cloud = item.cloudOnly ? { cloudOnly: true as const } : {};
        out.push({ path, size: item.size, mtime: item.mtime, ...cloud });
      } else {
        // Porta sem stat na listagem (Node): um `lstat` por arquivo.
        const stat = await port.lstat(port.join(handle.root, path));
        if (stat?.kind !== 'file') continue;
        const cloud = stat.cloudOnly ? { cloudOnly: true as const } : {};
        out.push({ path, size: stat.size, mtime: stat.mtime, ...cloud });
      }
    }
    await Promise.all(dirs);
  }

  #listable(rel: string, name: string, kind: FsKind): boolean {
    if (kind !== 'dir' && !(kind === 'file' && MD_FILE.test(name))) return false;
    try {
      toVaultPath(rel === '' ? name : `${rel}/${name}`);
      return true;
    } catch {
      return false;
    }
  }
}
