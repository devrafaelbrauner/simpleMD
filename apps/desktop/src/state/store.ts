import { DEFAULT_PREFERENCES, type FontFamilyName } from '@simplemd/themes';
import type { ExplorerStatus, PersistenceState, WelcomeError } from '@simplemd/ui';
import type { Entry, VaultHandle } from '@simplemd/vault';
import { createStore, type StoreApi } from 'zustand/vanilla';

/**
 * Store do app (arch-frontend §4.1): uma store Zustand com fatias, só com estado serializável. O
 * `EditorState` de cada aba mora no `DocumentRegistry`, e os temporizadores do autosave no
 * `SyncController`: digitar não gera atualização de store por tecla (só transições de status).
 */
export type DocStatus = 'loading' | 'clean' | 'dirty' | 'saving' | 'error' | 'conflict';
export type ConflictReason = 'external-change' | 'save-conflict' | 'deleted';

export interface Tab {
  /** `id === path` (um arquivo abre no máximo uma aba). */
  readonly id: string;
  readonly path: string;
  readonly name: string;
}

export interface Conflict {
  readonly id: string;
  readonly tabId: string;
  readonly path: string;
  readonly reason: ConflictReason;
}

export type NoticeId =
  | 'external-reload'
  | 'mixed-eol'
  | 'deleted'
  | 'save-failed'
  | 'open-failed'
  | 'not-utf8'
  | 'conflict-copy-saved'
  | 'reloaded-from-disk'
  | 'config-malformed'
  | 'config-field'
  | 'theme-missing'
  | 'prefs-failed';

export interface Notice {
  readonly id: string;
  readonly kind: 'info' | 'error';
  readonly notice: NoticeId;
  readonly text: string;
  readonly detail?: string;
  /** Avisos com a mesma chave se substituem (ex.: um "não foi possível salvar" por aba). */
  readonly key?: string;
  readonly action?: { readonly label: string; run(): void };
  /** Informativo que fica até ser fechado (STR-30). */
  readonly persistent?: boolean;
}

/** Preferências do editor (R-4.4); o tema ativo fica em `themeId`. */
export interface EditorPrefs {
  readonly fontFamily: FontFamilyName;
  readonly fontSize: number;
  readonly fontLigatures: boolean;
}

export interface UnsavedClose {
  readonly reason: 'window' | 'vault-switch';
  readonly paths: readonly string[];
}

export interface AppData {
  // vault
  vaultStatus: 'closed' | 'open';
  /** Diálogo de pasta aberto ou troca de pasta em andamento. */
  opening: boolean;
  handle: VaultHandle | null;
  vaultName: string;
  listStatus: ExplorerStatus;
  entries: Entry[];
  expanded: Record<string, true>;
  focusedPath: string | null;
  welcomeError: WelcomeError | null;
  // tabs + docs
  tabs: Tab[];
  activeId: string | null;
  docs: Record<string, DocStatus>;
  // conflicts
  conflict: Conflict | null;
  conflictQueue: Conflict[];
  conflictFailed: boolean;
  conflictBusy: boolean;
  // notices
  notices: Notice[];
  // ui
  unsavedClose: UnsavedClose | null;
  /** L2 Configurações aberto (gear / `Mod-,`). */
  settingsOpen: boolean;
  // settings (etapa 4)
  themeId: string;
  prefs: EditorPrefs;
  /** Para onde as preferências vão (linha de persistência do L2). */
  persistence: PersistenceState;
}

export interface AppActions {
  setFocused(path: string | null): void;
  toggleFolder(path: string): void;
  expandAll(): void;
  /** Abre (ou foca, se já aberta) a aba do arquivo. Devolve `true` se criou uma aba nova. */
  addTab(path: string): boolean;
  activate(id: string): void;
  /** Ativa a próxima/anterior, com volta (Ctrl-Tab / Ctrl-Shift-Tab). */
  activateSibling(step: 1 | -1): void;
  /** Remove a aba; a ativa passa à vizinha da direita, senão da esquerda (arch-ux §5.3). */
  removeTab(id: string): void;
  setDocStatus(id: string, status: DocStatus): void;
  /** clean/error → dirty; não faz nada nos demais (sem atualização por tecla). */
  markDirty(id: string): void;
  raiseConflict(conflict: Omit<Conflict, 'id'>): void;
  /** Fecha o conflito ativo e abre o próximo da fila (FIFO). */
  resolveConflict(): void;
  pushNotice(notice: Omit<Notice, 'id'>): void;
  dismissNotice(id: string): void;
  /** Remove os avisos com esta chave (ex.: os do `config.json` ao trocar de pasta). */
  dismissNoticeKey(key: string): void;
}

export type AppState = AppData & AppActions;
export type AppStore = StoreApi<AppState>;

/** No máximo 3 avisos visíveis; sai primeiro o informativo mais antigo (UX-D18). */
const MAX_NOTICES = 3;

export const INITIAL_DATA: AppData = {
  vaultStatus: 'closed',
  opening: false,
  handle: null,
  vaultName: '',
  listStatus: 'loading',
  entries: [],
  expanded: {},
  focusedPath: null,
  welcomeError: null,
  tabs: [],
  activeId: null,
  docs: {},
  conflict: null,
  conflictQueue: [],
  conflictFailed: false,
  conflictBusy: false,
  notices: [],
  unsavedClose: null,
  settingsOpen: false,
  themeId: DEFAULT_PREFERENCES.theme,
  prefs: {
    fontFamily: DEFAULT_PREFERENCES.fontFamily,
    fontSize: DEFAULT_PREFERENCES.fontSize,
    fontLigatures: DEFAULT_PREFERENCES.fontLigatures,
  },
  persistence: 'session',
};

export function createAppStore(): AppStore {
  let noticeSeq = 0;
  let conflictSeq = 0;
  return createStore<AppState>()((set, get) => ({
    ...INITIAL_DATA,

    setFocused: (path) => set({ focusedPath: path }),

    toggleFolder: (path) =>
      set(({ expanded }) => {
        const next = { ...expanded };
        if (next[path]) delete next[path];
        else next[path] = true;
        return { expanded: next };
      }),

    expandAll: () =>
      set(({ entries }) => ({
        expanded: Object.fromEntries(
          entries.filter((e) => e.kind === 'dir').map((e) => [e.path, true as const]),
        ),
      })),

    addTab: (path) => {
      if (get().tabs.some((tab) => tab.id === path)) {
        set({ activeId: path });
        return false;
      }
      const name = path.slice(path.lastIndexOf('/') + 1);
      set(({ tabs, docs }) => ({
        tabs: [...tabs, { id: path, path, name }],
        activeId: path,
        docs: { ...docs, [path]: 'loading' },
      }));
      return true;
    },

    activate: (id) => {
      if (get().tabs.some((tab) => tab.id === id)) set({ activeId: id });
    },

    activateSibling: (step) => {
      const { tabs, activeId } = get();
      if (tabs.length === 0) return;
      const index = tabs.findIndex((tab) => tab.id === activeId);
      const next = tabs[(index + step + tabs.length) % tabs.length];
      if (next) set({ activeId: next.id });
    },

    removeTab: (id) =>
      set(({ tabs, activeId, docs }) => {
        const index = tabs.findIndex((tab) => tab.id === id);
        if (index === -1) return {};
        const remaining = tabs.filter((tab) => tab.id !== id);
        const restDocs = { ...docs };
        delete restDocs[id];
        const nextActive =
          activeId !== id ? activeId : (remaining[index]?.id ?? remaining[index - 1]?.id ?? null);
        return { tabs: remaining, activeId: nextActive, docs: restDocs };
      }),

    setDocStatus: (id, status) => {
      const { docs } = get();
      if (id in docs && docs[id] !== status) set({ docs: { ...docs, [id]: status } });
    },

    markDirty: (id) => {
      const status = get().docs[id];
      if (status === 'clean' || status === 'error') get().setDocStatus(id, 'dirty');
    },

    raiseConflict: (input) => {
      const { conflict, conflictQueue } = get();
      if (conflict?.tabId === input.tabId || conflictQueue.some((c) => c.tabId === input.tabId))
        return;
      const next: Conflict = { ...input, id: `conflict-${++conflictSeq}` };
      if (conflict === null) set({ conflict: next, conflictFailed: false, conflictBusy: false });
      else set({ conflictQueue: [...conflictQueue, next] });
    },

    resolveConflict: () =>
      set(({ conflictQueue }) => ({
        conflict: conflictQueue[0] ?? null,
        conflictQueue: conflictQueue.slice(1),
        conflictFailed: false,
        conflictBusy: false,
      })),

    pushNotice: (input) =>
      set(({ notices }) => {
        const notice: Notice = { ...input, id: `notice-${++noticeSeq}` };
        let next =
          input.key === undefined ? [...notices] : notices.filter((n) => n.key !== input.key);
        next.push(notice);
        while (next.length > MAX_NOTICES) {
          const oldestInfo = next.findIndex((n) => n.kind === 'info');
          next = next.filter((_, i) => i !== (oldestInfo === -1 ? 0 : oldestInfo));
        }
        return { notices: next };
      }),

    dismissNotice: (id) => set(({ notices }) => ({ notices: notices.filter((n) => n.id !== id) })),

    dismissNoticeKey: (key) =>
      set(({ notices }) => ({ notices: notices.filter((n) => n.key !== key) })),
  }));
}
