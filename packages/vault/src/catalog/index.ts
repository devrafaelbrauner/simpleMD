import { ConflictError, isVaultError } from '../errors';
import { toVaultPath } from '../path';
import type { ContentVaultProvider, NoteStat, Unsubscribe, VaultHandle } from '../types';

/**
 * Índice do vault em `<vault>/.simplemd/index.json` (R-9.7; arch-backend r2 §1.4). É um CACHE de
 * metadados (título, tags, data, `fmError`), nunca de texto: pode ser apagado a qualquer hora e é
 * refeito sem bloquear a interface. A única escrita deste módulo é `INDEX_PATH` (regra 1: nenhum
 * `.md` é gravado). A extração dos metadados vem injetada pelo app (o vault não conhece o core).
 */
export const INDEX_PATH = '.simplemd/index.json';
/** Índice maior que isto é ignorado sem ser lido (AC-9.8). */
export const INDEX_MAX_BYTES = 20 * 1024 * 1024;
/** Nota maior que isto não é lida: entra com o nome do arquivo como título. */
const NOTE_READ_MAX = 2 * 1024 * 1024;
/** Escrita do índice: 2 s depois da última mudança de metadados (R-9.7). */
export const INDEX_WRITE_DEBOUNCE_MS = 2000;
const READ_CONCURRENCY = 8;
/** Notas processadas por fatia antes de devolver a vez à interface (NFR-27: 0 tarefas longas). */
const SLICE_SIZE = 25;
const TITLE_MAX = 1000;
const TAGS_MAX = 50;
const MD_FILE = /\.md$/i;

/** Metadados de uma nota (o `NoteMeta` do core, sem depender dele). */
export interface CatalogNoteMeta {
  readonly title: string;
  readonly tags: readonly string[];
  readonly date: string | null;
  readonly fmError: boolean;
  readonly fmErrorLine?: number;
}

export interface IndexEntry extends CatalogNoteMeta {
  readonly path: string;
  readonly mtime: number;
  readonly size: number;
}

/** `loading` = lendo índice e listagem; `building` = relendo notas mudadas; `ready` = em dia. */
export type CatalogStatus = 'loading' | 'building' | 'ready';

export interface CatalogSnapshot {
  readonly status: CatalogStatus;
  /** "Indexando… done de total" (STR-107); `total` = notas listadas. */
  readonly done: number;
  readonly total: number;
  readonly entries: readonly IndexEntry[];
  /** Muda a cada publicação (identidade para memorização na interface). */
  readonly version: number;
}

export interface CatalogClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface VaultIndexDeps {
  readonly provider: ContentVaultProvider;
  readonly handle: VaultHandle;
  readonly extract: (text: string, path: string) => CatalogNoteMeta;
  readonly clock: CatalogClock;
  /** Falhas que não bloqueiam nada (registro para diagnóstico). */
  readonly warn?: (message: string, detail?: unknown) => void;
}

export interface VaultIndex {
  /** Carrega, lista e revalida. Nunca lança; cada fase publica um snapshot. */
  start(): Promise<void>;
  getSnapshot(): CatalogSnapshot;
  subscribe(listener: () => void): Unsubscribe;
  /** Caminhos que mudaram fora do app (observador): `stat` de cada um, sem listar pastas. */
  applyChanges(paths: readonly string[]): Promise<void>;
  /** Gravação feita pelo app: metadados do texto gravado, 0 leituras. */
  applySaved(path: string, text: string, mtime: number): void;
  /** Grava agora uma mudança de metadados pendente (fechar janela, trocar de pasta). */
  flush(): Promise<void>;
  /** Para tudo sem gravar (a pasta saiu; o `flush` já rodou antes). */
  dispose(): void;
}

type StoredEntry = Omit<IndexEntry, 'path' | 'fmErrorLine'>;

const encoder = new TextEncoder();

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validPath(path: string): boolean {
  try {
    return (
      toVaultPath(path) === path &&
      MD_FILE.test(path) &&
      !path.split('/').some((segment) => segment.startsWith('.'))
    );
  } catch {
    return false;
  }
}

/**
 * `index.json` → mapa, ou `null` se qualquer coisa estiver fora do esquema v1 (o índice inteiro é
 * ignorado e refeito; R-9.7). Copia para um `Map` (sem protótipo herdado do JSON).
 */
function parseIndex(text: string): Map<string, IndexEntry> | null {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const root = data as Record<string, unknown>;
  const entries = root.entries;
  if (root.version !== 1 || typeof entries !== 'object' || entries === null) return null;
  if (Array.isArray(entries)) return null;
  const map = new Map<string, IndexEntry>();
  for (const [path, raw] of Object.entries(entries as Record<string, unknown>)) {
    if (!validPath(path) || typeof raw !== 'object' || raw === null) return null;
    const e = raw as Record<string, unknown>;
    const ok =
      typeof e.mtime === 'number' &&
      Number.isFinite(e.mtime) &&
      typeof e.size === 'number' &&
      Number.isFinite(e.size) &&
      e.size >= 0 &&
      typeof e.title === 'string' &&
      e.title.length <= TITLE_MAX &&
      isStringArray(e.tags) &&
      e.tags.length <= TAGS_MAX &&
      (e.date === null || typeof e.date === 'string') &&
      typeof e.fmError === 'boolean';
    if (!ok) return null;
    map.set(path, {
      path,
      mtime: e.mtime as number,
      size: e.size as number,
      title: e.title as string,
      tags: [...(e.tags as string[])],
      date: e.date as string | null,
      fmError: e.fmError as boolean,
    });
  }
  return map;
}

/** Só os metadados (sem mtime/size): muda quando vale regravar o índice (decisão B). */
function sameMeta(a: CatalogNoteMeta, b: CatalogNoteMeta): boolean {
  return (
    a.title === b.title &&
    a.date === b.date &&
    a.fmError === b.fmError &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, i) => tag === b.tags[i])
  );
}

/** Ordem por caminho em unidades de código: a serialização é estável entre execuções. */
function sortedPaths(map: ReadonlyMap<string, unknown>): string[] {
  return [...map.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function metaSignature(map: ReadonlyMap<string, IndexEntry>): string {
  return JSON.stringify(
    sortedPaths(map).map((path) => {
      const e = map.get(path) as IndexEntry;
      return [path, e.title, e.tags, e.date, e.fmError];
    }),
  );
}

function serialize(map: ReadonlyMap<string, IndexEntry>): string {
  const entries: Record<string, StoredEntry> = {};
  for (const path of sortedPaths(map)) {
    const e = map.get(path) as IndexEntry;
    entries[path] = {
      mtime: e.mtime,
      size: e.size,
      title: e.title.slice(0, TITLE_MAX),
      tags: e.tags.slice(0, TAGS_MAX),
      date: e.date,
      fmError: e.fmError,
    };
  }
  return `${JSON.stringify({ version: 1, entries })}\n`;
}

/** Roda `task` sobre `items` com no máximo `max` em paralelo. */
async function pool<T>(items: readonly T[], max: number, task: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(max, items.length) }, worker));
}

export function createVaultIndex(deps: VaultIndexDeps): VaultIndex {
  const { provider, handle, extract, clock } = deps;
  const warn = deps.warn ?? (() => {});
  let entries = new Map<string, IndexEntry>();
  const listeners = new Set<() => void>();
  let snapshot: CatalogSnapshot = { status: 'loading', done: 0, total: 0, entries: [], version: 0 };
  let status: CatalogStatus = 'loading';
  let done = 0;
  let total = 0;
  let disposed = false;
  /** Estado do arquivo no disco: base conhecida (texto lido/gravado), ausente ou ilegível. */
  let disk:
    | { kind: 'absent' }
    | { kind: 'base'; text: string; mtime: number }
    | {
        kind: 'unknown';
      } = { kind: 'absent' };
  /** Assinatura dos metadados gravados/lidos por último: só uma diferença justifica gravar. */
  let persisted: string | null = null;
  let metaDirty = false;
  let timer: unknown = null;
  let writing: Promise<void> = Promise.resolve();
  const pending = new Set<string>();

  const publish = () => {
    if (disposed) return;
    snapshot = {
      status,
      done,
      total,
      entries: [...entries.values()],
      version: snapshot.version + 1,
    };
    for (const listener of [...listeners]) listener();
  };

  const schedule = () => {
    if (disposed || status !== 'ready' || !metaDirty) return;
    if (timer !== null) clock.clearTimeout(timer);
    timer = clock.setTimeout(() => {
      timer = null;
      void persist();
    }, INDEX_WRITE_DEBOUNCE_MS);
  };

  /** Troca uma entrada; marca para gravar só se os metadados mudaram (decisão B). */
  const put = (path: string, meta: CatalogNoteMeta, mtime: number, size: number) => {
    const before = entries.get(path);
    const entry: IndexEntry = {
      path,
      mtime,
      size,
      title: meta.title.slice(0, TITLE_MAX),
      tags: meta.tags.slice(0, TAGS_MAX),
      date: meta.date,
      fmError: meta.fmError,
      ...(meta.fmErrorLine === undefined ? {} : { fmErrorLine: meta.fmErrorLine }),
    };
    entries.set(path, entry);
    if (!before || !sameMeta(before, entry)) metaDirty = true;
  };

  const remove = (path: string) => {
    if (entries.delete(path)) metaDirty = true;
  };

  /** Lê e extrai uma nota; nota grande ou não UTF-8 entra com o nome do arquivo (R-9.7). */
  const index = async (note: NoteStat) => {
    if (note.size > NOTE_READ_MAX) {
      put(note.path, extract('', note.path), note.mtime, note.size);
      return;
    }
    try {
      const { text, mtime } = await provider.read(handle, note.path);
      if (disposed) return;
      put(note.path, extract(text, note.path), mtime, encoder.encode(text).length);
    } catch (error) {
      if (disposed) return;
      if (isVaultError(error, 'NOT_FOUND')) remove(note.path);
      else if (isVaultError(error, 'NOT_UTF8'))
        put(note.path, extract('', note.path), note.mtime, note.size);
      else {
        // Falha passageira: entra pelo nome, com mtime impossível para ser relida na próxima vez.
        put(note.path, extract('', note.path), -1, note.size);
        warn('índice: nota não lida', { path: note.path, error });
      }
    }
  };

  const load = async () => {
    let stat;
    try {
      stat = await provider.stat(handle, INDEX_PATH);
    } catch (error) {
      disk = { kind: 'unknown' };
      warn('índice: stat falhou', error);
      return;
    }
    if (stat === null) return;
    if (stat.kind !== 'file' || stat.size > INDEX_MAX_BYTES) {
      // Não é lido (AC-9.8): sem base de conteúdo, este índice não é regravado nesta sessão.
      disk = { kind: 'unknown' };
      return;
    }
    try {
      const { text, mtime } = await provider.read(handle, INDEX_PATH);
      disk = { kind: 'base', text, mtime };
      const parsed = parseIndex(text);
      if (parsed && !disposed) {
        entries = parsed;
        persisted = metaSignature(parsed);
        publish();
      }
    } catch (error) {
      disk = { kind: 'unknown' };
      warn('índice: leitura falhou', error);
    }
  };

  const write = async (text: string): Promise<boolean> => {
    if (disk.kind === 'unknown') return false;
    try {
      const { mtime } =
        disk.kind === 'absent'
          ? await provider.write(handle, INDEX_PATH, text)
          : await provider.writeIfUnchanged(handle, INDEX_PATH, text, disk);
      disk = { kind: 'base', text, mtime };
      return true;
    } catch (error) {
      if (error instanceof ConflictError || isVaultError(error, 'ALREADY_EXISTS')) {
        try {
          const current = await provider.read(handle, INDEX_PATH);
          disk = { kind: 'base', text: current.text, mtime: current.mtime };
        } catch (readError) {
          disk = isVaultError(readError, 'NOT_FOUND') ? { kind: 'absent' } : { kind: 'unknown' };
        }
        return false;
      }
      warn('índice: gravação falhou', error);
      return false;
    }
  };

  const persist = (): Promise<void> => {
    writing = writing.then(async () => {
      if (disposed || !metaDirty) return;
      const signature = metaSignature(entries);
      metaDirty = false;
      if (signature === persisted) return;
      const text = serialize(entries);
      if ((await write(text)) || (disk.kind !== 'unknown' && (await write(text)))) {
        persisted = signature;
      } else {
        // Fica pendente: a próxima mudança (ou o flush ao fechar) tenta de novo.
        metaDirty = true;
      }
    });
    return writing;
  };

  const yieldToUi = () =>
    new Promise<void>((resolve) => {
      clock.setTimeout(resolve, 0);
    });

  const refresh = async (path: string) => {
    if (!MD_FILE.test(path)) {
      // Pasta removida: as notas dela saem (nenhuma listagem; CR-07).
      let stat;
      try {
        stat = await provider.stat(handle, path);
      } catch {
        return;
      }
      if (stat === null)
        for (const key of [...entries.keys()]) if (key.startsWith(`${path}/`)) remove(key);
      return;
    }
    if (!validPath(path)) return;
    let stat;
    try {
      stat = await provider.stat(handle, path);
    } catch (error) {
      warn('índice: stat falhou', { path, error });
      return;
    }
    if (disposed) return;
    if (stat === null || stat.kind !== 'file') {
      remove(path);
      return;
    }
    const known = entries.get(path);
    if (known && known.mtime === stat.mtime && known.size === stat.size) return;
    await index({ path, size: stat.size, mtime: stat.mtime });
  };

  const start = async () => {
    await load();
    if (disposed) return;
    let listed: NoteStat[];
    try {
      listed = await provider.listNotes(handle);
    } catch (error) {
      warn('índice: listagem falhou', error);
      status = 'ready';
      publish();
      return;
    }
    if (disposed) return;
    const seen = new Set<string>();
    const queue: NoteStat[] = [];
    for (const note of listed) {
      seen.add(note.path);
      const known = entries.get(note.path);
      if (!known || known.mtime !== note.mtime || known.size !== note.size) queue.push(note);
    }
    for (const path of [...entries.keys()]) if (!seen.has(path)) remove(path);
    total = listed.length;
    done = total - queue.length;
    status = queue.length > 0 ? 'building' : 'ready';
    publish();
    for (let i = 0; i < queue.length && !disposed; i += SLICE_SIZE) {
      await pool(queue.slice(i, i + SLICE_SIZE), READ_CONCURRENCY, index);
      if (disposed) return;
      done = Math.min(total, done + SLICE_SIZE);
      publish();
      await yieldToUi();
    }
    if (disposed) return;
    status = 'ready';
    done = total;
    const later = [...pending];
    pending.clear();
    for (const path of later) await refresh(path);
    publish();
    schedule();
  };

  return {
    start,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async applyChanges(paths) {
      if (disposed) return;
      if (status !== 'ready') {
        for (const path of paths) pending.add(path);
        return;
      }
      for (const path of paths) await refresh(path);
      publish();
      schedule();
    },
    applySaved(path, text, mtime) {
      if (disposed || !validPath(path)) return;
      put(path, extract(text, path), mtime, encoder.encode(text).length);
      publish();
      schedule();
    },
    async flush() {
      if (timer !== null) {
        clock.clearTimeout(timer);
        timer = null;
      }
      if (status === 'ready') await persist();
      else await writing;
    },
    dispose() {
      disposed = true;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      listeners.clear();
    },
  };
}
