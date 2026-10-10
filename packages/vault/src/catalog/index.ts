import { ConflictError, isVaultError } from '../errors';
import type { ContentVaultProvider, NoteStat, Unsubscribe, VaultHandle } from '../types';
import {
  EMPTY_INDEX_DATA,
  INDEX_ITAGS_MAX,
  INDEX_LINKS_MAX,
  INDEX_PROP_KEY_MAX,
  INDEX_PROPS_MAX,
  INDEX_TASK_RECURRENCE_MAX,
  INDEX_TASK_TEXT_MAX,
  INDEX_TASKS_MAX,
  indexSignature,
  parseIndex,
  propertiesFrom,
  sameIndexData,
  serializeIndex,
  TAGS_MAX,
  TITLE_MAX,
  validIndexPath,
  validPropertyValue,
  type CatalogNoteMeta,
  type IndexEntry,
  type IndexedLink,
  type IndexedTask,
  type NoteIndexData,
  type PropertyValue,
  type TruncatedField,
} from './schema';

export {
  EMPTY_INDEX_DATA,
  INDEX_ITAGS_MAX,
  INDEX_LINKS_MAX,
  INDEX_PROP_KEY_MAX,
  INDEX_PROP_VALUE_BYTES,
  INDEX_PROPS_MAX,
  INDEX_TASK_RECURRENCE_MAX,
  INDEX_TASK_TEXT_MAX,
  INDEX_TASKS_MAX,
  INDEX_VERSION,
  propertiesFrom,
  serializeIndex,
  type CatalogNoteMeta,
  type IndexedLink,
  type IndexedTask,
  type IndexEntry,
  type NoteIndexData,
  type PropertyValue,
  type TaskDateField,
  type TruncatedField,
} from './schema';

/**
 * Índice do vault em `<vault>/.simplemd/index.json` (R-9.7; arch-backend r2 §1.4, r7 §1.7). É um
 * CACHE de metadados (título, tags, data, `fmError`), dos links de saída (v2, R-I2.8) e das tarefas,
 * propriedades e tags do corpo de cada nota (v3, R-I9.3), nunca do texto inteiro: pode ser apagado
 * a qualquer hora e é refeito sem bloquear a interface. A única escrita deste módulo é `INDEX_PATH`
 * (regra 1: nenhum `.md` é gravado). A extração vem injetada pelo app (o vault não conhece o core).
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
/** Orçamento de cada fatia do trabalho de extração (arch-backend r7 §1.7.5). */
export const EXTRACTION_SLICE_MS = 8;
const MD_FILE = /\.md$/i;

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
  /** A listagem do vault falhou: nenhum dado novo de links (painel "Links" em erro; D-R7-S2-03b). */
  readonly listFailed?: true;
}

export interface CatalogClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Trabalho fatiável da extração (D-R7-B12b): `step` devolve `true` quando terminou. */
export interface ExtractionJob {
  step(budgetMs: number): boolean;
  result(): NoteIndexData;
}

/**
 * Extrator injetado (`createNoteExtractor` do core): `meta` barato e síncrono; `start` para o
 * parse Lezer e os links, rodado em fatias de {@link EXTRACTION_SLICE_MS} ms.
 */
export interface NoteExtractor {
  meta(text: string, path: string): CatalogNoteMeta;
  start(text: string, path: string): ExtractionJob;
}

export interface VaultIndexDeps {
  readonly provider: ContentVaultProvider;
  readonly handle: VaultHandle;
  readonly extract: NoteExtractor;
  readonly clock: CatalogClock;
  /** Falhas que não bloqueiam nada (registro para diagnóstico). */
  readonly warn?: (message: string, detail?: unknown) => void;
}

export interface VaultIndex {
  /** Carrega, lista e revalida. Nunca lança; cada fase publica um snapshot. */
  start(): Promise<void>;
  getSnapshot(): CatalogSnapshot;
  subscribe(listener: () => void): Unsubscribe;
  /**
   * Caminhos que mudaram fora do app (observador): `stat` de cada um. Uma pasta que existe (movida
   * ou renomeada para dentro do vault) tem as notas dela listadas e indexadas.
   */
  applyChanges(paths: readonly string[]): Promise<void>;
  /**
   * Revalidação sem observador (sondagem, CR2-03): lista o vault inteiro e indexa as notas novas ou
   * mudadas, sem ler as que não mudaram.
   */
  revalidate(): Promise<void>;
  /**
   * Gravação feita pelo app (0 leituras): metadados na hora; links pelo trabalho fatiado, publicados
   * quando ele termina (um save mais novo do mesmo caminho substitui o pendente).
   */
  applySaved(path: string, text: string, mtime: number): void;
  /** Grava agora uma mudança de metadados pendente (fechar janela, trocar de pasta). */
  flush(): Promise<void>;
  /** Para tudo sem gravar (a pasta saiu; o `flush` já rodou antes). */
  dispose(): void;
}

const encoder = new TextEncoder();

/**
 * Dados do extrator dentro dos tetos do esquema (um item inválido nunca invalida o arquivo):
 * excedentes saem e marcam `truncated` (R-I2.8, R-I9.3).
 */
function clampData(data: NoteIndexData): NoteIndexData {
  const truncated = new Set<TruncatedField>(data.truncated);
  const links: IndexedLink[] = [];
  for (const link of data.links) {
    if (link.kind !== 'wikilink' && !validIndexPath(link.target)) continue;
    if (link.target === '' || link.target.length > 1024) continue;
    if (links.length >= INDEX_LINKS_MAX) {
      truncated.add('links');
      break;
    }
    links.push(link);
  }
  const tasks: IndexedTask[] = [];
  for (const task of data.tasks) {
    if (tasks.length >= INDEX_TASKS_MAX) {
      truncated.add('tasks');
      break;
    }
    const recurrence = task.recurrence?.slice(0, INDEX_TASK_RECURRENCE_MAX);
    const { recurrence: _drop, ...rest } = task;
    tasks.push({
      ...rest,
      text: task.text.slice(0, INDEX_TASK_TEXT_MAX),
      ...(recurrence ? { recurrence } : {}),
    });
  }
  const props: [string, PropertyValue][] = [];
  for (const key of Object.keys(data.properties)) {
    const value = data.properties[key];
    if (key === '' || key.length > INDEX_PROP_KEY_MAX || !validPropertyValue(value)) {
      truncated.add('props');
      continue;
    }
    if (props.length >= INDEX_PROPS_MAX) {
      truncated.add('props');
      break;
    }
    props.push([key, value]);
  }
  const inlineTags = data.inlineTags.slice(0, INDEX_ITAGS_MAX);
  if (data.inlineTags.length > INDEX_ITAGS_MAX) truncated.add('itags');
  return {
    links,
    tasks,
    properties: propertiesFrom(props),
    inlineTags,
    truncated: (['links', 'tasks', 'props', 'itags'] as const).filter((f) => truncated.has(f)),
  };
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
  let revalidating: Promise<void> = Promise.resolve();
  let listFailed = false;
  /** Gravações do app com o trabalho de extração ainda pendente (o mais novo por caminho). */
  const savedJobs = new Map<string, { text: string; mtime: number }>();
  let savedRunner: Promise<void> | null = null;
  /** O trabalho de gravação em andamento (já fora de `savedJobs`); o `flush` o termina na hora. */
  let savedInflight: { path: string; mtime: number; job: ExtractionJob } | null = null;

  const publish = () => {
    if (disposed) return;
    snapshot = {
      status,
      done,
      total,
      entries: [...entries.values()],
      version: snapshot.version + 1,
      ...(listFailed ? { listFailed: true as const } : {}),
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

  /** Troca uma entrada; marca para gravar só se os dados persistidos mudaram (decisão B). */
  const put = (
    path: string,
    meta: CatalogNoteMeta,
    data: NoteIndexData,
    mtime: number,
    size: number,
  ) => {
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
      links: data.links,
      tasks: data.tasks,
      properties: data.properties,
      inlineTags: data.inlineTags,
      truncated: data.truncated,
    };
    entries.set(path, entry);
    if (!before || !sameIndexData(before, entry)) metaDirty = true;
  };

  /** Só o nome (nota grande, não UTF-8, ilegível): título do arquivo e nenhum link. */
  const putName = (path: string, mtime: number, size: number) =>
    put(path, extract.meta('', path), EMPTY_INDEX_DATA, mtime, size);

  /**
   * Roda o trabalho fatiável do extrator: {@link EXTRACTION_SLICE_MS} ms por fatia, cedendo a vez
   * à interface entre fatias; `null` se a pasta saiu ou o trabalho foi substituído.
   */
  const runJob = async (job: ExtractionJob, superseded: () => boolean = () => false) => {
    while (!job.step(EXTRACTION_SLICE_MS)) {
      await yieldToUi();
      if (disposed || superseded()) return null;
    }
    return clampData(job.result());
  };

  /** Links da gravação `mtime` de `path`: só valem se a entrada ainda é dessa gravação. */
  const putSaved = (path: string, mtime: number, data: NoteIndexData) => {
    const current = entries.get(path);
    if (!current || current.mtime !== mtime) return false;
    put(path, current, data, current.mtime, current.size);
    return true;
  };

  /** Fila das gravações do app: metadados já estão no índice; os links chegam aqui. */
  const runSaved = () => {
    if (savedRunner || disposed) return;
    savedRunner = (async () => {
      for (const [path, saved] of savedJobs) {
        savedJobs.delete(path);
        const job = extract.start(saved.text, path);
        savedInflight = { path, mtime: saved.mtime, job };
        const data = await runJob(job, () => savedJobs.has(path) || savedInflight?.job !== job);
        if (savedInflight?.job === job) savedInflight = null;
        if (data === null || disposed || !putSaved(path, saved.mtime, data)) continue;
        publish();
        schedule();
      }
    })().finally(() => {
      savedRunner = null;
      if (savedJobs.size > 0) runSaved();
    });
  };

  /**
   * CR-S2-01: termina AGORA, sem ceder a vez, os trabalhos de gravação pendentes (o em andamento e
   * os da fila). Sem isso, um `flush` logo depois de salvar (fechar a janela, trocar de pasta)
   * persistiria o `mtime` novo com os links da versão anterior, e a reabertura quente (0 leituras)
   * nunca os corrigiria.
   */
  const drainSaved = () => {
    const pendingJobs: Array<{ path: string; mtime: number; job: ExtractionJob }> = [];
    if (savedInflight) pendingJobs.push(savedInflight);
    savedInflight = null;
    for (const [path, saved] of savedJobs)
      pendingJobs.push({ path, mtime: saved.mtime, job: extract.start(saved.text, path) });
    savedJobs.clear();
    let changed = false;
    for (const { path, mtime, job } of pendingJobs) {
      while (!job.step(Number.POSITIVE_INFINITY));
      if (putSaved(path, mtime, clampData(job.result()))) changed = true;
    }
    if (changed) publish();
  };

  const remove = (path: string) => {
    if (entries.delete(path)) metaDirty = true;
  };

  /** Lê e extrai uma nota; nota grande ou não UTF-8 entra com o nome do arquivo (R-9.7). */
  const index = async (note: NoteStat) => {
    if (note.size > NOTE_READ_MAX) {
      putName(note.path, note.mtime, note.size);
      return;
    }
    try {
      const { text, mtime } = await provider.read(handle, note.path);
      if (disposed) return;
      const meta = extract.meta(text, note.path);
      // Nota grande cede a vez no meio do parse (mesma fatia de 25 notas / 8 leituras).
      const data = await runJob(extract.start(text, note.path));
      if (data === null || disposed) return;
      put(note.path, meta, data, mtime, encoder.encode(text).length);
    } catch (error) {
      if (disposed) return;
      if (isVaultError(error, 'NOT_FOUND')) remove(note.path);
      else if (isVaultError(error, 'NOT_UTF8')) putName(note.path, note.mtime, note.size);
      else {
        // Falha passageira: entra pelo nome, com mtime impossível para ser relida na próxima vez.
        putName(note.path, -1, note.size);
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
        persisted = indexSignature(parsed);
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
      const signature = indexSignature(entries);
      metaDirty = false;
      if (signature === persisted) return;
      const text = serializeIndex(entries);
      const bytes = encoder.encode(text).length;
      // D-R7-B15 (r2 mantido): grava mesmo acima do teto de leitura; a próxima abertura ignora o
      // arquivo e refaz o índice. CR-S2-08: o diagnóstico fica registrado.
      if (bytes > INDEX_MAX_BYTES)
        warn('índice: maior que o teto de leitura; será refeito a cada abertura', { bytes });
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

  /**
   * Listagem (do vault ou de uma pasta) → notas a reler (novas ou com tamanho/mtime diferentes);
   * as entradas sob `under` que não estão mais na listagem saem.
   */
  const reconcile = (listed: readonly NoteStat[], under: string): NoteStat[] => {
    const seen = new Set<string>();
    const queue: NoteStat[] = [];
    for (const note of listed) {
      seen.add(note.path);
      const known = entries.get(note.path);
      if (!known || known.mtime !== note.mtime || known.size !== note.size) queue.push(note);
    }
    const prefix = under === '' ? '' : `${under}/`;
    for (const path of [...entries.keys()]) {
      if (path.startsWith(prefix) && !seen.has(path)) remove(path);
    }
    return queue;
  };

  /** Lê a fila em fatias com pausas para a interface (NFR-27); `onSlice` depois de cada fatia. */
  const indexQueue = async (queue: readonly NoteStat[], onSlice: () => void = () => {}) => {
    for (let i = 0; i < queue.length && !disposed; i += SLICE_SIZE) {
      await pool(queue.slice(i, i + SLICE_SIZE), READ_CONCURRENCY, index);
      if (disposed) return;
      onSlice();
      await yieldToUi();
    }
  };

  /** Pasta que apareceu ou mudou de nome (CR2-03): as notas dela entram no catálogo. */
  const refreshDir = async (path: string) => {
    let listed: NoteStat[];
    try {
      listed = await provider.listNotes(handle, path);
    } catch (error) {
      warn('índice: listagem da pasta falhou', { path, error });
      return;
    }
    if (disposed) return;
    await indexQueue(reconcile(listed, path));
  };

  const refresh = async (path: string) => {
    if (!MD_FILE.test(path)) {
      let stat;
      try {
        stat = await provider.stat(handle, path);
      } catch {
        return;
      }
      if (disposed) return;
      if (stat === null) {
        // Pasta removida: as notas dela saem (nenhuma listagem; CR-07).
        for (const key of [...entries.keys()]) if (key.startsWith(`${path}/`)) remove(key);
      } else if (stat.kind === 'dir') {
        await refreshDir(path);
      }
      return;
    }
    if (!validIndexPath(path)) return;
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
      listFailed = true;
      status = 'ready';
      publish();
      return;
    }
    if (disposed) return;
    listFailed = false;
    const queue = reconcile(listed, '');
    total = listed.length;
    done = total - queue.length;
    status = queue.length > 0 ? 'building' : 'ready';
    publish();
    await indexQueue(queue, () => {
      done = Math.min(total, done + SLICE_SIZE);
      publish();
    });
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
    revalidate() {
      if (disposed || status !== 'ready') return revalidating;
      revalidating = revalidating.then(async () => {
        if (disposed) return;
        let listed: NoteStat[];
        try {
          listed = await provider.listNotes(handle);
        } catch (error) {
          warn('índice: listagem falhou', error);
          if (!listFailed) {
            listFailed = true;
            publish();
          }
          return;
        }
        if (disposed) return;
        listFailed = false;
        await indexQueue(reconcile(listed, ''));
        if (disposed) return;
        publish();
        schedule();
      });
      return revalidating;
    },
    applySaved(path, text, mtime) {
      if (disposed || !validIndexPath(path)) return;
      // Metadados na hora (0 leituras); os dados da versão anterior ficam até o trabalho terminar.
      const before = entries.get(path);
      const data: NoteIndexData = before ?? EMPTY_INDEX_DATA;
      put(path, extract.meta(text, path), data, mtime, encoder.encode(text).length);
      publish();
      schedule();
      savedJobs.delete(path);
      savedJobs.set(path, { text, mtime });
      runSaved();
    },
    async flush() {
      if (timer !== null) {
        clock.clearTimeout(timer);
        timer = null;
      }
      // Links das gravações do app que ainda estavam em fatias entram antes de persistir.
      if (!disposed) drainSaved();
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
