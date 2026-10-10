import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  localToday,
  noteContext,
  parseTaskLine,
  sameTask,
  type ParsedTask,
  type TaskCompletionModule,
} from '@simplemd/core';
import {
  ConflictError,
  isVaultError,
  type CatalogSnapshot,
  type ContentVaultProvider,
  type IndexEntry,
  type VaultHandle,
} from '@simplemd/vault';
import type { DocumentRegistry } from '../state/documents';
import type { AppStore } from '../state/store';
import type { SyncController } from '../state/sync';
import type { CatalogController } from './catalog';

/**
 * Implementação da interface privada `TasksCatalog` do `simplemd.tasks` (r7 arch-backend §1.8,
 * arch-frontend §3.3; R-I9.1, R-I9.7; AC-I9.1, AC-I9.7, NFR-49). Só o registro
 * `plugins/internal/tasks.ts` importa este arquivo (regra de lint), dentro do `load` (pedaço sob
 * demanda, NFR-54), e confere o objeto contra o tipo `TasksCatalog` de
 * `@simplemd/plugin-api/internal/tasks-catalog` (este arquivo não pode importá-lo: a regra de lint
 * reserva o caminho ao registro e ao plugin; as formas daqui são as do índice e do core).
 */

/** Textos dos avisos (STR-177 e STR-145; arch-ux §7.2). */
export const TASKS_CATALOG_TEXT = {
  changed: 'A tarefa mudou no arquivo; a consulta foi atualizada',
  conflict: (name: string) =>
    `“${name}” está em conflito; resolva o conflito antes de marcar tarefas dela.`,
  unsupported: (rule: string) =>
    `Regra de repetição não suportada: “${rule}”. A tarefa só foi marcada.`,
  /** Lacuna de texto (C-3): falha de leitura/gravação que não é mudança nem conflito. */
  io: 'Não foi possível marcar a tarefa: o arquivo não pôde ser lido ou gravado.',
} as const;

export interface CatalogTaskRef {
  readonly path: string;
  readonly task: ParsedTask;
}

export type CatalogTaskEditResult =
  | { readonly ok: true; readonly target: 'editor' | 'disk' }
  | {
      readonly ok: false;
      readonly reason: 'changed' | 'conflict' | 'missing' | 'unchanged' | 'io';
    };

export type CatalogTaskToggleResult = CatalogTaskEditResult & { readonly unsupportedRule?: string };

export interface CatalogTasksSnapshot {
  readonly version: number;
  readonly status: CatalogSnapshot['status'];
  readonly notes: readonly IndexEntry[];
}

export interface TasksCatalogDeps {
  readonly vault: ContentVaultProvider;
  readonly store: AppStore;
  readonly registry: DocumentRegistry;
  readonly catalog: CatalogController;
  readonly sync: SyncController;
  /** O editor principal (mostra a aba ativa), ou `null` antes de montar. */
  readonly view: () => EditorView | null;
  /** Conclusão de R-I9.7, carregada sob demanda (`loadTaskCompletion` do core). */
  readonly completion: Pick<TaskCompletionModule, 'toggleTaskLine'>;
  /** Hoje no fuso local; padrão `localToday`. */
  readonly today?: () => string;
}

/** Quadros de espera até a aba recém-aberta aparecer no editor (como o serviço de links). */
const SHOW_FRAMES = 30;

const nameOf = (path: string): string =>
  path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');

/** Fronteiras das linhas do texto CRU (após o BOM): `[início, fim do conteúdo, fim com a quebra]`. */
function rawLines(body: string): Array<[number, number, number]> {
  const lines: Array<[number, number, number]> = [];
  const eol = /\r\n|\r|\n/g;
  let start = 0;
  for (let m = eol.exec(body); m; m = eol.exec(body)) {
    lines.push([start, m.index, m.index + m[0].length]);
    start = m.index + m[0].length;
  }
  lines.push([start, body.length, body.length]);
  return lines;
}

/** Uma troca mínima entre `before` e `after` (prefixo e sufixo comuns preservados). */
function minimalChange(
  before: string,
  after: string,
): { from: number; to: number; insert: string } {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let end = 0;
  while (
    end < max - start &&
    before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)
  )
    end++;
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) };
}

export interface AppTasksCatalog {
  getSnapshot(): CatalogTasksSnapshot;
  subscribe(listener: () => void): () => void;
  resolveWikilink(fromPath: string, target: string): string | null;
  backlinks(path: string): readonly string[];
  parseTaskLine(rawLine: string): ParsedTask | null;
  editTask(
    ref: CatalogTaskRef,
    transform: (rawLine: string) => readonly string[] | null,
  ): Promise<CatalogTaskEditResult>;
  toggleTask(
    ref: CatalogTaskRef,
    options: { readonly recordDoneDate: boolean },
  ): Promise<CatalogTaskToggleResult>;
  openSource(ref: CatalogTaskRef): void;
  openNote(path: string): void;
}

export function createTasksCatalog(deps: TasksCatalogDeps): AppTasksCatalog {
  const { vault, store, registry, catalog, sync } = deps;
  const today = deps.today ?? (() => localToday());
  /** Escritas em voo por nota (um clique repetido enquanto a anterior grava é ignorado). */
  const inflight = new Set<string>();
  let memo: { source: CatalogSnapshot; snapshot: CatalogTasksSnapshot } | null = null;

  const notice = (level: 'warn' | 'error', text: string, detail?: string) =>
    store.getState().pushNotice({
      kind: level === 'error' ? 'error' : 'info',
      ...(level === 'warn' ? { level: 'warn' as const } : {}),
      notice: 'query',
      text,
      ...(detail === undefined ? {} : { detail }),
      key: 'query',
    });

  /** A linha `line` (0-based) é a tarefa esperada? (identidade de D-R7-B11b). */
  const expected = (raw: string, ref: CatalogTaskRef): boolean => {
    const current = parseTaskLine(raw, ref.task.line);
    return current !== null && sameTask(current, ref.task);
  };

  const stale = (path: string): CatalogTaskEditResult => {
    catalog.changed([path]);
    return { ok: false, reason: 'changed' };
  };

  /** Nota aberta numa aba: uma transação no editor dela (desfazível lá; o autosave grava). */
  const editInTab = (
    ref: CatalogTaskRef,
    transform: (rawLine: string) => readonly string[] | null,
  ): CatalogTaskEditResult => {
    const { path } = ref;
    const status = store.getState().docs[path];
    if (status === 'conflict') return { ok: false, reason: 'conflict' };
    if (status === 'loading') return stale(path);
    const view = deps.view();
    const active = view !== null && view.state.facet(noteContext).path === path;
    const state: EditorState | undefined = active ? view.state : registry.get(path)?.state;
    if (!state) return { ok: false, reason: 'io' };
    if (ref.task.line + 1 > state.doc.lines) return stale(path);
    const line = state.doc.line(ref.task.line + 1);
    if (!expected(line.text, ref)) return stale(path);
    const lines = transform(line.text);
    if (lines === null) return { ok: false, reason: 'unchanged' };
    const next = lines.join('\n');
    if (next === line.text) return { ok: false, reason: 'unchanged' };
    const change = minimalChange(line.text, next);
    const spec = {
      changes: { from: line.from + change.from, to: line.from + change.to, insert: change.insert },
      userEvent: 'input.task',
    };
    if (active) view.dispatch(spec);
    else sync.onEditorChange(path, state.update(spec).state);
    return { ok: true, target: 'editor' };
  };

  /** Nota fechada: leitura, conferência da linha e UMA gravação com base de conteúdo. */
  const editOnDisk = async (
    handle: VaultHandle,
    ref: CatalogTaskRef,
    transform: (rawLine: string) => readonly string[] | null,
  ): Promise<CatalogTaskEditResult> => {
    const { path } = ref;
    let text: string;
    let mtime: number;
    try {
      ({ text, mtime } = await vault.read(handle, path));
    } catch (error) {
      if (isVaultError(error, 'NOT_FOUND')) {
        catalog.changed([path]);
        return { ok: false, reason: 'missing' };
      }
      return { ok: false, reason: 'io' };
    }
    // Uma aba pode ter aberto a nota durante a leitura: o editor dela passa a ser o dono.
    if (store.getState().docs[path] !== undefined) return editInTab(ref, transform);
    const bom = text.startsWith('\uFEFF') ? 1 : 0;
    const body = text.slice(bom);
    const bounds = rawLines(body)[ref.task.line];
    if (!bounds) return stale(path);
    const [from, to, end] = bounds;
    const current = body.slice(from, to);
    if (!expected(current, ref)) return stale(path);
    const lines = transform(current);
    if (lines === null) return { ok: false, reason: 'unchanged' };
    // A quebra da própria linha (CRLF, LF ou CR) separa as linhas novas; o resto do arquivo não muda.
    const eol = body.slice(to, end) || (/\r\n|\r|\n/.exec(body)?.[0] ?? '\n');
    const replaced = lines.join(eol);
    if (replaced === current) return { ok: false, reason: 'unchanged' };
    const next = text.slice(0, bom + from) + replaced + text.slice(bom + to);
    try {
      const written = await vault.writeIfUnchanged(handle, path, next, { mtime, text });
      catalog.saved(path, next, written.mtime);
      return { ok: true, target: 'disk' };
    } catch (error) {
      if (error instanceof ConflictError) return stale(path);
      if (isVaultError(error, 'NOT_FOUND')) {
        catalog.changed([path]);
        return { ok: false, reason: 'missing' };
      }
      return { ok: false, reason: 'io' };
    }
  };

  const editTask: AppTasksCatalog['editTask'] = async (ref, transform) => {
    const handle = store.getState().handle;
    if (!handle) return { ok: false, reason: 'io' };
    const key = `${ref.path}\n${ref.task.line}`;
    if (inflight.has(key)) return { ok: false, reason: 'unchanged' };
    inflight.add(key);
    try {
      if (store.getState().docs[ref.path] !== undefined) return editInTab(ref, transform);
      return await editOnDisk(handle, ref, transform);
    } finally {
      inflight.delete(key);
    }
  };

  /** Leva o cursor à linha depois que a aba aparece no editor principal. */
  const reveal = (path: string, line: number | null, frames: number) => {
    const view = deps.view();
    if (!view || view.state.facet(noteContext).path !== path) {
      if (frames > 0) requestAnimationFrame(() => reveal(path, line, frames - 1));
      return;
    }
    if (line !== null) {
      const target = view.state.doc.line(Math.min(line + 1, view.state.doc.lines));
      view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
    }
    view.focus();
  };

  const open = (path: string, line: number | null) => {
    void sync.openFile(path).then((opened) => {
      if (opened) reveal(path, line, SHOW_FRAMES);
    });
  };

  return {
    getSnapshot() {
      const source = catalog.getSnapshot();
      if (memo?.source !== source) {
        const notes = [...source.entries].sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        );
        memo = { source, snapshot: { version: source.version, status: source.status, notes } };
      }
      return memo.snapshot;
    },
    subscribe: (listener) => catalog.subscribe(listener),
    resolveWikilink(fromPath, target) {
      const resolution = catalog.links.resolve(target, fromPath);
      return resolution.kind === 'resolved' ? resolution.path : null;
    },
    backlinks(path) {
      return catalog.links
        .backlinks(path)
        .groups.map((group) => group.path)
        .filter((source) => source !== path)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    },
    parseTaskLine: (rawLine) => parseTaskLine(rawLine, -1),
    editTask,
    async toggleTask(ref, options) {
      let unsupportedRule: string | undefined;
      const result = await editTask(ref, (raw) => {
        const toggle = deps.completion.toggleTaskLine(raw, {
          today: today(),
          recordDoneDate: options.recordDoneDate,
        });
        unsupportedRule = toggle?.unsupportedRule;
        return toggle ? toggle.lines : null;
      });
      if (result.ok) {
        if (unsupportedRule === undefined) return result;
        notice('warn', TASKS_CATALOG_TEXT.unsupported(unsupportedRule));
        return { ...result, unsupportedRule };
      }
      if (result.reason === 'changed' || result.reason === 'missing')
        notice('warn', TASKS_CATALOG_TEXT.changed);
      else if (result.reason === 'conflict')
        notice('warn', TASKS_CATALOG_TEXT.conflict(nameOf(ref.path)));
      else if (result.reason === 'io') notice('error', TASKS_CATALOG_TEXT.io, ref.path);
      return result;
    },
    openSource: (ref) => open(ref.path, ref.task.line),
    openNote: (path) => open(path, null),
  };
}
