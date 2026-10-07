import { ConflictError, VaultError } from './errors';
import { sha256Hex } from './hash';
import { toVaultPath } from './path';
import type { FsDirItem, FsKind, FsPort, FsStat } from './port';
import type {
  ContentBase,
  ContentVaultProvider,
  Entry,
  NoteStat,
  Unsubscribe,
  VaultHandle,
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

/** Versões guardadas por caminho no registro de versões servidas; a mais antiga sai primeiro. */
const SERVED_CAP = 16;

/** NFR-4: leituras de diretório em paralelo, no máximo 16 de cada vez. */
const LIST_CONCURRENCY = 16;
const CONFIG_PREFIX = '.simplemd/';
const MD_FILE = /\.md$/i;
const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function byName(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Código de plugin: `.simplemd/plugins/<id>/**\/*.js`, só leitura (arch-backend r2 §1.2). */
const PLUGIN_CODE = /^\.simplemd\/plugins\/[^/]+\/(?:[^/]+\/)*[^/]+\.js$/;

/**
 * Classes de caminho legíveis/graváveis (defesa em profundidade sobre a guarda): `*.md` fora de
 * pastas ocultas e `.simplemd/**\/*.json`; o código de plugin (`.js`) só é legível. Qualquer outro
 * caminho falha antes de tocar a porta.
 */
function assertFileClass(rel: string, access: 'read' | 'write' = 'write'): void {
  const ok = rel.startsWith(CONFIG_PREFIX)
    ? rel.endsWith('.json') || (access === 'read' && PLUGIN_CODE.test(rel))
    : MD_FILE.test(rel);
  if (!ok) throw new VaultError('INVALID_PATH', 'Tipo de arquivo não permitido.', { path: rel });
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
  #nextHandle = 0;

  constructor(port: FsPort, options: LocalFsProviderOptions = {}) {
    this.#port = port;
    this.#readLimits = options.readLimits ?? [];
  }

  async open(): Promise<VaultHandle> {
    const root = await this.#port.pickDirectory();
    if (root === null) throw new VaultError('CANCELLED', 'Seleção de pasta cancelada.');
    const name = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
    return { id: `vault-${++this.#nextHandle}`, name, root };
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

  async listNotes(handle: VaultHandle): Promise<NoteStat[]> {
    const notes: NoteStat[] = [];
    await this.#notesIn(handle, '', limiter(LIST_CONCURRENCY), notes);
    return notes;
  }

  /**
   * Escrita §4.3. Sem `expectedMtime` só cria. Com ele, a base vem do registro de versões servidas
   * com esse `mtime`: se a mais recente veio de uma escrita deste provider, ela é a base (o chamador
   * recebeu esse `mtime` dela; regra do r1 para gravações seguidas no mesmo tique); senão todas
   * precisam ter o mesmo hash — duas versões lidas no mesmo tique = base ambígua → conflito (RR-03).
   * Um `mtime` que o provider nunca serviu não autoriza nada. Só um caminho sem nenhum histórico
   * neste provider cai na regra do r1 (`mtime` igual → grava). O app grava por `writeIfUnchanged`.
   */
  async write(
    handle: VaultHandle,
    path: string,
    text: string,
    expectedMtime?: number,
  ): Promise<{ mtime: number }> {
    const rel = toVaultPath(path);
    assertFileClass(rel);
    return this.#locked(handle, rel, async () => {
      const port = this.#port;
      const key = this.#key(handle, rel);
      const stat = await this.#walk(handle, rel);
      const bytes = encoder.encode(text);
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
        await port.writeFile(abs, bytes, 'overwrite');
        return this.#afterWrite(key, rel, abs, bytes);
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
    const rel = toVaultPath(path);
    assertFileClass(rel);
    return this.#locked(handle, rel, async () => {
      const stat = await this.#walk(handle, rel);
      return this.#writeIfBase(handle, rel, stat, encoder.encode(text), {
        mtime: base.mtime,
        expected: 'text' in base ? encoder.encode(base.text) : base.sha256,
      });
    });
  }

  /**
   * Núcleo da escrita por base de conteúdo (D-B1), já dentro do mutex e depois do `#walk`. Autoriza
   * só se o disco tem exatamente os bytes da base (`Uint8Array`) ou o sha256 dela (`string`);
   * `null` = base desconhecida ou ambígua, que nunca autoriza. O `mtime` da base só preenche o
   * `ConflictError`.
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
    const port = this.#port;
    const abs = port.join(handle.root, rel);
    const key = this.#key(handle, rel);
    const disk = await port.readFile(abs);
    const { expected } = base;
    const unchanged =
      expected !== null &&
      (typeof expected === 'string' ? sha256Hex(disk) === expected : bytesEqual(disk, expected));
    if (!unchanged) throw new ConflictError(rel, base.mtime, stat.mtime, 'modified');
    if (bytesEqual(disk, bytes)) {
      // Nada a gravar (D-4 / AC-2.6): a versão no disco já é a nova.
      this.#record(key, stat.mtime, bytes, 'write');
      return { mtime: stat.mtime };
    }
    await port.writeFile(abs, bytes, 'overwrite');
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

  watch(handle: VaultHandle, cb: (event: VaultWatchEvent) => void): Unsubscribe {
    const port = this.#port;
    if (!port.watch) {
      queueMicrotask(() => cb({ kind: 'unavailable', reason: 'sem observação de arquivos' }));
      return () => {};
    }
    let cancelled = false;
    let stop: (() => void) | null = null;
    const root = handle.root.replace(/\\/g, '/').replace(/\/+$/, '');
    const onPaths = (absPaths: string[]) => {
      if (cancelled) return;
      const paths = new Set<string>();
      for (const abs of absPaths) {
        const norm = abs.replace(/\\/g, '/');
        if (!norm.startsWith(`${root}/`)) continue;
        const rel = norm.slice(root.length + 1);
        if (rel === '' || rel.split('/').some((s) => s === '' || s.startsWith('.'))) continue;
        paths.add(rel);
      }
      if (paths.size > 0) cb({ kind: 'change', paths: [...paths] });
    };
    const onError = (reason: string) => {
      if (!cancelled) cb({ kind: 'unavailable', reason });
    };
    port.watch(handle.root, onPaths, onError).then(
      (unwatch) => {
        if (cancelled) unwatch();
        else stop = unwatch;
      },
      (error: unknown) => onError(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      cancelled = true;
      stop?.();
    };
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

  /** Percorre como `#listDir`, guardando só as notas com tamanho e mtime (sem ordenar). */
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
        out.push({ path, size: item.size, mtime: item.mtime });
      } else {
        // Porta sem stat na listagem (Node): um `lstat` por arquivo.
        const stat = await port.lstat(port.join(handle.root, path));
        if (stat?.kind === 'file') out.push({ path, size: stat.size, mtime: stat.mtime });
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
