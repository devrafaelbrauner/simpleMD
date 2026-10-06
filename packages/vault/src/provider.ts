import { ConflictError, VaultError } from './errors';
import { toVaultPath } from './path';
import type { FsKind, FsPort, FsStat } from './port';
import type { Entry, Unsubscribe, VaultHandle, VaultProvider, VaultWatchEvent } from './types';

/** Limite de leitura por caminho, verificado pelo `lstat` ANTES de ler (arch-backend §1.6). */
export interface ReadLimit {
  match(path: string): boolean;
  readonly maxBytes: number;
}

export interface LocalFsProviderOptions {
  readonly readLimits?: readonly ReadLimit[];
}

interface Known {
  readonly mtime: number;
  readonly bytes: Uint8Array;
}

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

/**
 * Classes de caminho legíveis/graváveis (defesa em profundidade sobre a guarda): `*.md` fora de
 * pastas ocultas e `.simplemd/**\/*.json`. Qualquer outro caminho falha antes de tocar a porta.
 */
function assertFileClass(rel: string): void {
  const ok = rel.startsWith(CONFIG_PREFIX) ? rel.endsWith('.json') : MD_FILE.test(rel);
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
export class LocalFsProvider implements VaultProvider {
  readonly #port: FsPort;
  readonly #readLimits: readonly ReadLimit[];
  /** Bytes e mtime que o app leu ou gravou por último, por vault e caminho (verificação de conflito). */
  readonly #lastKnown = new Map<string, Known>();
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
      this.#lastKnown.set(this.#key(handle, rel), { mtime: stat.mtime, bytes });
      return { text, mtime: stat.mtime };
    });
  }

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
      const abs = port.join(handle.root, rel);
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
        await port.writeFile(abs, bytes, 'create-new');
      } else {
        if (stat === null) throw new ConflictError(rel, expectedMtime, null, 'deleted');
        if (stat.kind !== 'file')
          throw new VaultError('INVALID_PATH', 'Não é um arquivo.', { path: rel });
        const known = this.#lastKnown.get(key);
        if (known) {
          // O conteúdo é a verificação autoritativa: pega edições externas no mesmo tique de mtime
          // e ignora toques só de metadados (R-2.6, D-4).
          const disk = await port.readFile(abs);
          if (!bytesEqual(disk, known.bytes)) {
            throw new ConflictError(rel, expectedMtime, stat.mtime, 'modified');
          }
          if (bytesEqual(disk, bytes)) {
            this.#lastKnown.set(key, { mtime: stat.mtime, bytes });
            return { mtime: stat.mtime };
          }
          // A última versão vista (por qualquer leitor) não é a base de quem grava: alguém leu uma
          // versão mais nova que o chamador ainda não viu. Sobrescrever perderia essa versão (CR-06).
          if (known.mtime !== expectedMtime) {
            throw new ConflictError(rel, expectedMtime, stat.mtime, 'modified');
          }
        } else if (stat.mtime !== expectedMtime) {
          throw new ConflictError(rel, expectedMtime, stat.mtime, 'modified');
        }
        await port.writeFile(abs, bytes, 'overwrite');
      }
      const after = await port.lstat(abs);
      if (after === null)
        throw new VaultError('IO', 'O arquivo sumiu após a gravação.', { path: rel });
      this.#lastKnown.set(key, { mtime: after.mtime, bytes });
      return { mtime: after.mtime };
    });
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
