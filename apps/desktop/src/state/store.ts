import { DEFAULT_AUTOCOMPLETE, type AutocompleteSettings, type EditorMode } from '@simplemd/core';
import {
  DEFAULT_EXPLORER_APPEARANCE,
  DEFAULT_PREFERENCES,
  type ExplorerAppearance,
  type FolderColorId,
  type FontFamilyName,
  type Theme,
} from '@simplemd/themes';
import type {
  CatalogMode,
  ExplorerStatus,
  PersistenceState,
  SettingsSectionId,
  WelcomeError,
} from '@simplemd/ui';
import type { Entry, VaultHandle } from '@simplemd/vault';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { DEFAULT_AI_SETTINGS, type AiSettings } from '../ai/settings';

/**
 * Store do app (arch-frontend §4.1): uma store Zustand com fatias, só com estado serializável. O
 * `EditorState` de cada aba mora no `DocumentRegistry`, e os temporizadores do autosave no
 * `SyncController`: digitar não gera atualização de store por tecla (só transições de status).
 */
export type DocStatus = 'loading' | 'clean' | 'dirty' | 'saving' | 'error' | 'conflict';
export type ConflictReason = 'external-change' | 'save-conflict' | 'deleted';

/**
 * Grupo do editor (r39a, design-r39 §1): 0 = o da esquerda, sempre montado (o view principal); 1 = o
 * da direita, só com o editor dividido.
 */
export type EditorGroup = 0 | 1;

export interface Tab {
  /** `id === path` (um arquivo abre no máximo uma aba, num grupo só; r39a regra 2). */
  readonly id: string;
  readonly path: string;
  readonly name: string;
  /** Grupo onde a aba está (r39a; sem divisão, sempre 0). */
  readonly group: EditorGroup;
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
  | 'prefs-failed'
  | 'theme-invalid'
  | 'theme-saved'
  | 'theme-imported'
  | 'theme-exported'
  | 'theme-export-failed'
  | 'plugin'
  | 'plugin-error'
  | 'plugin-hotkey'
  | 'ai-error'
  | 'ai-too-long'
  | 'ai-copied'
  | 'export-progress'
  | 'export-done'
  | 'export-failed'
  | 'export-refused'
  | 'print-failed'
  // r7 (DA-R7-24; DESIGN §R7.6.16): emitidos por S1/S2/S3/S9/ST, declarados de uma vez aqui.
  | 'link'
  | 'note-create'
  | 'table'
  | 'query'
  | 'export-images'
  | 'editor-config'
  // r12 (STR-R12-03, D-R12-08): entradas de `folderColors` ignoradas ao abrir a pasta;
  // (STR-R12-04, AC-12.9): pasta colorida renomeada/movida/apagada fora do app.
  | 'folder-colors'
  | 'folder-colors-gone'
  // r38b: "Prévia lado a lado" pedida pela tecla sem poder abrir (sem nota, menos de 900 px).
  | 'preview'
  // r39c: ⌘\ sem poder dividir (sem nota aberta, menos de 640 px no editor).
  | 'split'
  // r35b (D-R32-7): teto ou leitura de uma camada do dicionário, pelo app (antes, pelo LanguageTool).
  | 'dictionary-limit';

/** L7 "Exportar como Markdown" aberto: se a nota tem front matter e o alerta em linha (STR-117). */
export interface ExportOptionsState {
  readonly hasFrontMatter: boolean;
  readonly error: string | null;
  /** O diálogo de salvar está aberto ("Escolher destino…" fica `aria-disabled`). */
  readonly picking: boolean;
}

/** L8 "Nova nota" aberto: pasta inicial (`''` = raiz), alerta em linha e criação em andamento. */
export interface NewNoteState {
  readonly folder: string;
  readonly error: string | null;
  readonly busy: boolean;
}

export interface Notice {
  readonly id: string;
  readonly kind: 'info' | 'error';
  /** Aviso (⚠ em `fg`, contêiner `role=status`, tempo do informativo; DESIGN §8.23). */
  readonly level?: 'warn';
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

/**
 * Prévia lado a lado (r38b; `config.json` `layout.preview`): aberta e a fração da largura útil que
 * o editor ocupa (0,1–0,9, D-R38-06). Vale para todas as abas da pasta.
 */
export interface LayoutPreview {
  readonly open: boolean;
  readonly ratio: number;
}

export const DEFAULT_LAYOUT_PREVIEW: LayoutPreview = { open: false, ratio: 0.5 };

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
  /**
   * Aba ativa do grupo com foco: espelho de `groupActive[focusedGroup]` (r39a, D-R39-01), então quem
   * lia a aba ativa antes da divisão lê a do grupo com foco.
   */
  activeId: string | null;
  /** Aba ativa de cada grupo do editor (r39a); a do grupo 1 só existe com `split`. */
  groupActive: readonly [string | null, string | null];
  /** Editor dividido em dois grupos (r39a; só a sessão, nada no `config.json`, D-R39-11). */
  split: boolean;
  /** Grupo com foco (r39a, D-R39-06): comandos, ⌘E e a barra de status seguem ele. */
  focusedGroup: EditorGroup;
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
  /** Seção ativa do L2 (a engrenagem e `Mod-,` sempre abrem "Aparência"). */
  settingsSection: SettingsSectionId;
  /** L5 Paleta de comandos aberta; `palettePrefill` = texto inicial da busca. */
  paletteOpen: boolean;
  palettePrefill: string;
  /** C4 painel lateral (fechado a cada abertura de pasta; OQ-R2-1) e a aba ativa. */
  sidePanelOpen: boolean;
  sidePanelTab: string | null;
  /**
   * O que a busca do Catálogo procura (r37c, design-r37 §4): título/caminho/tag (`notes`, padrão) ou
   * o texto das notas (`content`). Só a sessão; trocar de pasta não muda o modo.
   */
  catalogMode: CatalogMode;
  // settings (etapa 4)
  themeId: string;
  prefs: EditorPrefs;
  /** Para onde as preferências vão (linha de persistência do L2). */
  persistence: PersistenceState;
  // theme editor (etapa 5)
  /** Temas do vault (`.simplemd/themes`), em ordem de nome. */
  userThemes: Theme[];
  /** L3 Editor de temas aberto sobre o L2. */
  themeEditorOpen: boolean;
  /** Mensagem STR-32 do último erro de importação (alerta do L2). */
  importError: string | null;
  /** Autocompletar (R-8.2; `config.json` `autocomplete`; só a sessão sem pasta). */
  autocomplete: AutocompleteSettings;
  /** IA (R-11.6; `config.json` `ai`, nunca chaves; só a sessão sem pasta). */
  ai: AiSettings;
  /** Tecla Tab no editor (r7 U-1/D-40; `config.json` `editor.captureTab`; padrão desligado). */
  captureTab: boolean;
  /**
   * Modo em que as notas abrem (r27b, D-P26-02; `config.json` `editor.defaultMode`; padrão fonte).
   * Só vale para as notas abertas depois da mudança: cada aba guarda o próprio modo.
   */
  editorDefaultMode: EditorMode;
  /**
   * Indexar notas só na nuvem (r36b; `config.json` `index.cloudOnly`; padrão desligado): ligada, o
   * índice as lê, e o sistema as baixa. Vale por pasta; sem pasta, desligada.
   */
  indexCloudOnly: boolean;
  /**
   * Cores de pasta efetivas (r12, arch-backend §1): as válidas do `config.json` ∩ pastas que
   * existem. Referência nova só quando o conteúdo muda (memo das abas, NFR-12.5).
   */
  folderColors: ReadonlyMap<string, FolderColorId>;
  /** Anúncio polite do explorador (r12 D-R12-F4): "Pasta “b”: cor azul." / "…: sem cor própria." */
  explorerLive: string;
  /**
   * Estilo do explorador guardado (r13, `config.json` `appearance.explorer`; padrão = r12).
   * Referência nova só quando muda; o arco-íris é derivado no `Shell`, nunca guardado (D-R13-B2).
   */
  explorerAppearance: ExplorerAppearance;
  /** Uma exportação está em andamento ("Exportar" fica `aria-disabled`; XPT-PROGRESS). */
  exportBusy: boolean;
  /** L7 aberto (modal: os atalhos de janela não agem). */
  exportOptions: ExportOptionsState | null;
  /** L8 "Nova nota" aberto (modal: os atalhos de janela não agem). */
  newNote: NewNoteState | null;
  /** Prévia lado a lado (r38b; `config.json` `layout.preview`, gravada só quando o usuário muda). */
  layoutPreview: LayoutPreview;
  /**
   * Largura da área do editor medida pelo divisor (r38b, px): abaixo de 900 a prévia não cabe e o
   * comando diz quanto falta. `null` = ainda sem medida (cabe).
   */
  editorWidth: number | null;
}

export interface AppActions {
  setFocused(path: string | null): void;
  toggleFolder(path: string): void;
  expandAll(): void;
  /**
   * Abre (ou foca, se já aberta) a aba do arquivo. Devolve `true` se criou uma aba nova. A aba nova
   * entra no grupo com foco; a já aberta foca o grupo dela (r39a: a mesma nota não abre nos dois).
   */
  addTab(path: string): boolean;
  /** Ativa a aba no grupo dela, que passa a ter o foco (r39a). */
  activate(id: string): void;
  /** Ativa a próxima/anterior do grupo com foco, com volta (Ctrl-Tab / Ctrl-Shift-Tab). */
  activateSibling(step: 1 | -1): void;
  /**
   * Remove a aba; no grupo dela, a ativa passa à vizinha da direita, senão da esquerda (arch-ux
   * §5.3). Com o editor dividido, fechar a última aba de um grupo junta os grupos no outro (r39a).
   */
  removeTab(id: string): void;
  /**
   * Divide o editor (r39a, D-R39-03): o grupo da direita nasce vazio e com o foco. Só com uma aba
   * aberta e sem divisão; devolve `true` se dividiu.
   */
  splitEditor(): boolean;
  /**
   * Junta os grupos (r39a, D-R39-04): as abas de `keep` e depois as do outro, todas no grupo 0, que
   * fica com o foco; ativa = a de `keep` ou, sem ela, a do outro. Sem divisão, nada muda.
   */
  mergeGroups(keep: EditorGroup): void;
  /** Foca o grupo (r39a): `activeId` passa à ativa dele. Sem divisão, só existe o grupo 0. */
  focusGroup(group: EditorGroup): void;
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
  groupActive: [null, null],
  split: false,
  focusedGroup: 0,
  docs: {},
  conflict: null,
  conflictQueue: [],
  conflictFailed: false,
  conflictBusy: false,
  notices: [],
  unsavedClose: null,
  settingsOpen: false,
  settingsSection: 'appearance',
  paletteOpen: false,
  palettePrefill: '',
  sidePanelOpen: false,
  sidePanelTab: null,
  catalogMode: 'notes',
  themeId: DEFAULT_PREFERENCES.theme,
  prefs: {
    fontFamily: DEFAULT_PREFERENCES.fontFamily,
    fontSize: DEFAULT_PREFERENCES.fontSize,
    fontLigatures: DEFAULT_PREFERENCES.fontLigatures,
  },
  persistence: 'session',
  userThemes: [],
  themeEditorOpen: false,
  importError: null,
  autocomplete: DEFAULT_AUTOCOMPLETE,
  ai: DEFAULT_AI_SETTINGS,
  captureTab: false,
  editorDefaultMode: 'source',
  indexCloudOnly: false,
  folderColors: new Map(),
  explorerLive: '',
  explorerAppearance: DEFAULT_EXPLORER_APPEARANCE,
  exportBusy: false,
  exportOptions: null,
  newNote: null,
  layoutPreview: DEFAULT_LAYOUT_PREVIEW,
  editorWidth: null,
};

/** `groupActive` com a ativa de `group` trocada por `id` (r39a). */
function withActive(
  groupActive: AppData['groupActive'],
  group: EditorGroup,
  id: string | null,
): AppData['groupActive'] {
  return group === 0 ? [id, groupActive[1]] : [groupActive[0], id];
}

/** Os dois grupos num só (r39a, `mergeGroups`): as abas de `keep` primeiro, todas no grupo 0. */
function joined(
  tabs: readonly Tab[],
  groupActive: AppData['groupActive'],
  keep: EditorGroup,
): Pick<AppData, 'tabs' | 'groupActive' | 'split' | 'focusedGroup' | 'activeId'> {
  const active = groupActive[keep] ?? groupActive[keep === 0 ? 1 : 0];
  const ordered = [
    ...tabs.filter((tab) => tab.group === keep),
    ...tabs.filter((tab) => tab.group !== keep),
  ];
  return {
    tabs: ordered.map((tab): Tab => (tab.group === 0 ? tab : { ...tab, group: 0 })),
    groupActive: [active, null],
    split: false,
    focusedGroup: 0,
    activeId: active,
  };
}

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
        get().activate(path);
        return false;
      }
      const name = path.slice(path.lastIndexOf('/') + 1);
      set(({ tabs, docs, groupActive, focusedGroup }) => ({
        tabs: [...tabs, { id: path, path, name, group: focusedGroup }],
        groupActive: withActive(groupActive, focusedGroup, path),
        activeId: path,
        docs: { ...docs, [path]: 'loading' },
      }));
      return true;
    },

    activate: (id) => {
      const tab = get().tabs.find((candidate) => candidate.id === id);
      if (!tab) return;
      set(({ groupActive }) => ({
        focusedGroup: tab.group,
        groupActive: withActive(groupActive, tab.group, id),
        activeId: id,
      }));
    },

    activateSibling: (step) => {
      const { tabs, groupActive, focusedGroup } = get();
      const group = tabs.filter((tab) => tab.group === focusedGroup);
      if (group.length === 0) return;
      const index = group.findIndex((tab) => tab.id === groupActive[focusedGroup]);
      const next = group[(index + step + group.length) % group.length];
      if (next)
        set({ groupActive: withActive(groupActive, focusedGroup, next.id), activeId: next.id });
    },

    removeTab: (id) =>
      set(({ tabs, groupActive, focusedGroup, split, docs }) => {
        const tab = tabs.find((candidate) => candidate.id === id);
        if (!tab) return {};
        const siblings = tabs.filter((candidate) => candidate.group === tab.group);
        const index = siblings.indexOf(tab);
        const remaining = siblings.filter((candidate) => candidate !== tab);
        const active = groupActive[tab.group];
        const nextActive =
          active !== id ? active : (remaining[index]?.id ?? remaining[index - 1]?.id ?? null);
        const restTabs = tabs.filter((candidate) => candidate !== tab);
        const restActive = withActive(groupActive, tab.group, nextActive);
        const restDocs = { ...docs };
        delete restDocs[id];
        // r39a: dividido, o grupo que perde a última aba fecha e as abas ficam no outro.
        if (split && remaining.length === 0)
          return { ...joined(restTabs, restActive, tab.group === 0 ? 1 : 0), docs: restDocs };
        return {
          tabs: restTabs,
          groupActive: restActive,
          activeId: restActive[focusedGroup],
          docs: restDocs,
        };
      }),

    splitEditor: () => {
      const { split, tabs } = get();
      if (split || tabs.length === 0) return false;
      set(({ groupActive }) => ({
        split: true,
        focusedGroup: 1,
        groupActive: [groupActive[0], null],
        activeId: null,
      }));
      return true;
    },

    mergeGroups: (keep) => {
      if (get().split) set(({ tabs, groupActive }) => joined(tabs, groupActive, keep));
    },

    focusGroup: (group) => {
      const { split, focusedGroup, groupActive } = get();
      if (group === focusedGroup || (group === 1 && !split)) return;
      set({ focusedGroup: group, activeId: groupActive[group] });
    },

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
