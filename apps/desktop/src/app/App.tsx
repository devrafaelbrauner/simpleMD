import type { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { normalizeOllamaUrl, PROVIDER_NAMES } from '@simplemd/ai';
import {
  computeToc,
  fileTitle,
  readNoteProperties,
  SPOKEN_TOGGLE,
  TAB_FOCUS_HOTKEY,
  TAB_HELP_ID,
  tabModeDescription,
} from '@simplemd/core';
import themePreviewDoc from '@simplemd/core/samples/theme-preview.md?raw';
import {
  effectiveExplorer,
  rainbowColors,
  resolveFolderColor,
  type FolderColorId,
} from '@simplemd/themes';
import {
  AiConsentDialog,
  AiSettings,
  AutocompleteSection,
  ChatPanel,
  ResultCard,
  CatalogPanel,
  cloudDownloads,
  CommandPalette,
  ContentSearch,
  ConflictDialog,
  EditorSection,
  ExportOptionsDialog,
  Explorer,
  FolderSection,
  hotkeyAria,
  hotkeyLabel,
  isMac,
  NewNoteDialog,
  Notices,
  PluginManager,
  PluginWarning,
  PreviewPane,
  PropertiesPanel,
  LinksPanel,
  SettingsDialog,
  SidePanel,
  SplitPane,
  StatusBar,
  ThemeEditorDialog,
  TocPanel,
  Toolbar,
  UnsavedCloseDialog,
  Welcome,
  type CodeMirrorEditorHandle,
  type PaletteItem,
  type PluginOptionsData,
  type SidePanelTab,
  type TabView,
} from '@simplemd/ui';
import type { IndexEntry } from '@simplemd/vault';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { AppController } from './controller';
import { EditorGroup, GroupEditors, GROUP_TEXT, GROUPS_MIN_WIDTH_PX } from './EditorGroup';
import { closeGroup, closeTab, focusEditorOrExplorer, toggleSidePanel } from './focus';
import { TOGGLE_LIVE_PREVIEW_KEY, TOGGLE_SIDE_PREVIEW_KEY } from './global-keys';
import { useLinksPanel } from './useLinksPanel';
import {
  SIDE_PREVIEW_TEXT,
  sidePreviewMinWidth,
  toggleSidePreview,
  useBuiltinCommands,
} from './useBuiltinCommands';
import { useGlobalKeys } from './useGlobalKeys';
import { LANGUAGETOOL_DOCS_URL, type StatusBarSnapshot } from './status-bar';
import { textSearchOf } from '../catalog/text-search';
import { PREVIEW_REFUSED_CLASS } from '../preview/controller';

const OS = isMac ? 'mac' : 'other';

/** Arco-íris desligado: um mapa vazio de identidade fixa (r13 arch-frontend §1). */
const NO_AUTO_COLORS: ReadonlyMap<string, FolderColorId> = new Map();
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
/**
 * Raiz da UI desktop: V1 WELCOME ou V2 SHELL, mais N1/L1/L4 (arch-ux §2.1). A mesma árvore roda no
 * Tauri e no harness do Chromium; só a `AppPlatform` muda (R-2.12).
 */
export function App({ app }: { app: AppController }) {
  const { store, platform } = app;
  const vaultOpen = useStore(store, (s) => s.vaultStatus === 'open');
  const shared = useStore(
    store,
    useShallow((s) => ({
      notices: s.notices,
      dismissNotice: s.dismissNotice,
      conflict: s.conflict,
      conflictFailed: s.conflictFailed,
      conflictBusy: s.conflictBusy,
      unsavedClose: s.unsavedClose,
    })),
  );
  // r39b (design-r39 §1): o `editor` (foco, teclas, comandos, IA) é o handle do grupo com foco.
  const [editor] = useState(() => new GroupEditors(store));

  useGlobalKeys(app, editor);
  useBuiltinCommands(app, editor);

  // Atributo de ligaduras no <html> desde o primeiro quadro (o tema claro vem de tokens.css).
  useLayoutEffect(() => app.settings.init(), [app]);

  // NFR-7: primeiro quadro depois do primeiro commit da interface.
  useEffect(() => {
    const frame = requestAnimationFrame(() => platform.log('simplemd:ready'));
    return () => cancelAnimationFrame(frame);
  }, [platform]);

  useEffect(() => platform.onCloseRequested(() => app.sync.requestWindowClose()), [app, platform]);

  useEffect(() => {
    const onFocus = () => app.sync.onWindowFocus();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [app]);

  const conflictView = useMemo(
    () =>
      shared.conflict && {
        id: shared.conflict.id,
        name: nameOf(shared.conflict.path),
        reason: shared.conflict.reason,
      },
    [shared.conflict],
  );

  // Onde estava o foco quando o L1 abriu: se era dentro de um diálogo (L2/L3) que continua aberto,
  // o foco volta para lá ao resolver o conflito (arch-ux §5.3 regra 3; EC F-4). Gravado num efeito
  // de layout, antes de o Radix mover o foco para "Manter ambos".
  const focusBeforeConflict = useRef<HTMLElement | null>(null);
  const conflictOpen = shared.conflict !== null;
  useLayoutEffect(() => {
    if (!conflictOpen) return;
    const active = document.activeElement;
    focusBeforeConflict.current = active instanceof HTMLElement ? active : null;
  }, [conflictOpen]);

  /**
   * `reload`: "Recarregar do disco" devolve o foco ao elemento de antes do L1 (a aba ativa não muda;
   * EC F-5, arch-ux r2 §2.1). "Manter ambos" leva ao editor da cópia, que fica ativa (UX-D13), salvo
   * quando o L1 abriu sobre um diálogo (EC F-4).
   */
  const afterConflict = async (action: () => Promise<void>, reload = false) => {
    await action();
    if (store.getState().conflict) return; // o próximo da fila abre por cima
    const previous = focusBeforeConflict.current;
    focusBeforeConflict.current = null;
    if (
      previous?.isConnected &&
      previous !== document.body &&
      (reload || previous.closest('[role="dialog"]'))
    ) {
      requestAnimationFrame(() => previous.focus());
      return;
    }
    // Foco no editor da aba ativa (UX-D13: a cópia; Recarregar: a aba ativa).
    focusEditorOrExplorer(app, editor);
  };

  return (
    <>
      {vaultOpen ? <Shell app={app} editor={editor} /> : <WelcomeView app={app} />}
      <Notices items={shared.notices} onDismiss={shared.dismissNotice} />
      <SettingsView app={app} />
      <PaletteView app={app} />
      <ExportOptionsView app={app} />
      <NewNoteView app={app} editor={editor} />
      <ConflictDialog
        conflict={conflictView}
        failed={shared.conflictFailed}
        busy={shared.conflictBusy}
        onKeepBoth={() => void afterConflict(() => app.sync.keepBoth())}
        onReload={() => void afterConflict(() => app.sync.reloadFromDisk(), true)}
        onShown={() => platform.log('simplemd:conflict-shown')}
      />
      <UnsavedCloseDialog
        paths={shared.unsavedClose?.paths ?? null}
        onBack={() => {
          app.sync.cancelUnsavedClose();
          // "Voltar" leva à primeira aba que não pôde ser gravada (arch-ux §5.3), no grupo dela.
          const state = store.getState();
          const failing = state.tabs.find((tab) => state.docs[tab.id] === 'error');
          if (failing) state.activate(failing.id);
          const target = failing?.id ?? state.activeId;
          requestAnimationFrame(() =>
            [...document.querySelectorAll<HTMLElement>('.smd-group [role="tab"]')]
              .find((tab) => tab.dataset.tabId === target)
              ?.focus(),
          );
        }}
        onDiscard={() => void app.sync.discardAndClose()}
      />
      <AiConsentView app={app} editor={editor} />
    </>
  );
}

function WelcomeView({ app }: { app: AppController }) {
  const { opening, welcomeError } = useStore(
    app.store,
    useShallow((s) => ({ opening: s.opening, welcomeError: s.welcomeError })),
  );
  return (
    <Welcome
      opening={opening}
      error={welcomeError}
      onOpenVault={() => void app.sync.openVault('welcome')}
      onOpenSettings={() =>
        app.store.setState({ settingsOpen: true, settingsSection: 'appearance' })
      }
    />
  );
}

/** L5 PALETA (R-6.18): a lista vem do registro de comandos (embutidos e de plugin). */
function PaletteView({ app }: { app: AppController }) {
  const { open, prefill } = useStore(
    app.store,
    useShallow((s) => ({ open: s.paletteOpen, prefill: s.palettePrefill })),
  );
  const { commands } = app.plugins;
  const getItems = useCallback(
    (): PaletteItem[] =>
      commands
        .getSnapshot()
        // r12 D-R12-F3: "Pasta: …" só existem com uma pasta focada no explorador (AC-12.3).
        .filter((command) => command.isVisible?.() !== false)
        .map((command) => {
          const enabled = command.isEnabled?.() ?? true;
          return {
            id: command.id,
            label: command.title,
            ...(command.detail === undefined ? {} : { detail: command.detail }),
            ...(command.hotkey === undefined
              ? {}
              : {
                  hotkeyLabel: hotkeyLabel(command.hotkey),
                  keyshortcuts: hotkeyAria(command.hotkey),
                }),
            ...(enabled === true ? {} : { disabledReason: enabled.reason }),
            ...(command.step ? { step: command.step.bind(command) } : {}),
          };
        }),
    [commands],
  );
  return (
    <CommandPalette
      open={open}
      initialQuery={prefill}
      getItems={getItems}
      onClose={() => app.store.setState({ paletteOpen: false })}
      onRun={(id) => void commands.get(id)?.run()}
    />
  );
}

/** L7 "Exportar como Markdown" (etapa 10): o estado vem do store; as ações, do `ExportController`. */
function ExportOptionsView({ app }: { app: AppController }) {
  const options = useStore(app.store, (s) => s.exportOptions);
  return (
    <ExportOptionsDialog
      options={options}
      onCancel={() => app.exporter.closeMarkdownOptions()}
      onChoose={(strip) => void app.exporter.chooseMarkdown(strip)}
    />
  );
}

/**
 * r30: "Enviar para …?" antes do 1º envio de texto da pasta a um provedor de nuvem. Ao fechar por
 * "Enviar", "Cancelar" ou Esc, o foco volta para onde o envio começou: o campo do chat ou o editor
 * (no "Enviar" de um comando, o cartão de resultado pega o foco no quadro seguinte). Fechado pelo
 * app (pasta trocada), o foco fica com quem fechou.
 */
function AiConsentView({
  app,
  editor,
}: {
  app: AppController;
  editor: RefObject<CodeMirrorEditorHandle | null>;
}) {
  const consent = useSyncExternalStore(app.ai.subscribe, () => app.ai.getSnapshot().consent);
  const origin = useRef<'chat' | 'command' | null>(null);
  const close = (action: () => void) => {
    origin.current = consent?.kind ?? null;
    action();
  };
  return (
    <AiConsentDialog
      request={consent}
      onConfirm={() => close(() => void app.ai.confirmConsent())}
      onCancel={() => close(() => app.ai.cancelConsent())}
      onClosed={() => {
        const from = origin.current;
        origin.current = null;
        if (from === 'chat') document.getElementById('ai-input')?.focus();
        else if (from === 'command') focusEditorOrExplorer(app, editor);
      }}
    />
  );
}

/** L8 "Nova nota": o estado vem do store; a criação, do `SyncController` (depois, foco na nota). */
function NewNoteView({
  app,
  editor,
}: {
  app: AppController;
  editor: RefObject<CodeMirrorEditorHandle | null>;
}) {
  const { newNote, entries, vaultName } = useStore(
    app.store,
    useShallow((s) => ({ newNote: s.newNote, entries: s.entries, vaultName: s.vaultName })),
  );
  const open = newNote !== null;
  const folders = useMemo(
    () => (open ? entries.filter((e) => e.kind === 'dir').map((e) => e.path) : []),
    [open, entries],
  );
  return (
    <NewNoteDialog
      state={newNote}
      vaultName={vaultName}
      folders={folders}
      onCancel={() => app.sync.cancelNewNote()}
      onCreate={(folder, name) => {
        void app.sync.createNote(folder, name).then((opened) => {
          if (opened) focusEditorOrExplorer(app, editor);
        });
      }}
    />
  );
}

/** L2 CONFIGURAÇÕES e L3 EDITOR DE TEMAS ligados ao store e ao `SettingsController` (R-4.7, R-5.x). */
function SettingsView({ app }: { app: AppController }) {
  const { settings, platform, store } = app;
  const s = useStore(
    store,
    useShallow((state) => ({
      open: state.settingsOpen,
      themeId: state.themeId,
      prefs: state.prefs,
      persistence: state.persistence,
      userThemes: state.userThemes,
      editorOpen: state.themeEditorOpen,
      importError: state.importError,
      vaultOpen: state.handle !== null,
      section: state.settingsSection,
      autocomplete: state.autocomplete,
      ai: state.ai,
      captureTab: state.captureTab,
      defaultMode: state.editorDefaultMode,
      explorer: state.explorerAppearance,
      indexCloudOnly: state.indexCloudOnly,
    })),
  );
  const captureTabInvalid = useSyncExternalStore(
    app.captureTabInvalid.subscribe,
    app.captureTabInvalid.getSnapshot,
  );
  const defaultModeInvalid = useSyncExternalStore(
    app.defaultModeInvalid.subscribe,
    app.defaultModeInvalid.getSnapshot,
  );
  /** Região viva do L2 na seção "Editor" (STR-158). */
  const [editorLive, setEditorLive] = useState('');
  /** Região viva do L2 na seção "Pasta" (r36c). */
  const [folderLive, setFolderLive] = useState('');
  // Cada abertura do L3 começa um rascunho novo (descartado ao fechar; OQ-2).
  const [editorSession, setEditorSession] = useState(0);
  // `userThemes` (no seletor acima) re-renderiza esta vista quando a lista muda.
  const themes = settings.themes();
  const pickFile = platform.pickFile;
  const host = app.plugins.host;
  const plugins = useSyncExternalStore(host.subscribe, host.getSnapshot);
  // L6 devolve o foco ao interruptor que o abriu (arch-ux r2 §6.3).
  const warningOpener = useRef<HTMLElement | null>(null);
  /** Invocador a focar quando o L6 sair por "Cancelar"/"Ativar mesmo assim"/Esc. */
  const restoreFocus = useRef<HTMLElement | null>(null);
  const pluginsReload = useRef<HTMLButtonElement>(null);
  const autocompleteSwitch = useRef<HTMLButtonElement>(null);
  const editorSwitch = useRef<HTMLButtonElement>(null);
  const folderSwitch = useRef<HTMLButtonElement>(null);
  const aiProvider = useRef<HTMLSelectElement>(null);
  const aiSnap = useSyncExternalStore(app.ai.subscribe, app.ai.getSnapshot);
  const aiOpen = s.open && s.section === 'ai';
  // r36c: com "Indexar notas só na nuvem" ligado, quantas notas o índice ainda vai ler (baixar); o
  // catálogo fica em "N de N" durante a releitura do fim da construção, então a seção "Pasta" diz.
  // Um número: a vista só renderiza de novo quando a conta muda.
  const cloudDownloading = useSyncExternalStore(app.catalog.subscribe, () =>
    cloudDownloads(app.catalog.getSnapshot(), s.indexCloudOnly),
  );
  // Estado das chaves ao abrir "IA" (só `has_key`; 0 pedidos de rede, AC-11.14).
  useEffect(() => {
    if (aiOpen) void app.ai.refreshKeys();
  }, [aiOpen, app]);
  const warningOpen = plugins.warning !== null;
  useLayoutEffect(() => {
    if (!warningOpen) return;
    const active = document.activeElement;
    warningOpener.current = active instanceof HTMLElement ? active : null;
  }, [warningOpen]);
  const closeWarning = (action: () => Promise<void> | void) => {
    restoreFocus.current = warningOpener.current;
    void action();
  };
  // O foco volta ao invocador quando o L6 sai do DOM, no mesmo tique (r7 B1): esperar um quadro
  // deixava o foco no <body> nesse intervalo.
  const warningClosed = () => {
    const opener = restoreFocus.current;
    restoreFocus.current = null;
    if (opener?.isConnected) opener.focus();
  };
  // Fechar o L2 descarta um aviso pendente (nenhum byte é executado).
  useEffect(() => {
    if (!s.open && warningOpen) host.cancelWarning();
  }, [s.open, warningOpen, host]);
  return (
    <>
      <SettingsDialog
        open={s.open}
        onClose={() => store.setState({ settingsOpen: false, importError: null })}
        themes={themes}
        themeId={s.themeId}
        onThemeChange={(id) => settings.setTheme(id)}
        fontFamily={s.prefs.fontFamily}
        onFontFamilyChange={(name) => settings.setFontFamily(name)}
        fontSize={s.prefs.fontSize}
        onFontSizeChange={(size) => settings.setFontSize(size)}
        ligatures={s.prefs.fontLigatures}
        onLigaturesChange={(on) => settings.setLigatures(on)}
        persistence={s.persistence}
        onOpenThemeEditor={() => {
          setEditorSession((n) => n + 1);
          store.setState({ themeEditorOpen: true });
        }}
        canImport={s.vaultOpen}
        {...(pickFile ? { onImport: () => void settings.importFromDialog() } : {})}
        onImportFile={(file) =>
          void settings.importFile({
            name: file.name,
            size: file.size,
            read: async () => new Uint8Array(await file.arrayBuffer()),
          })
        }
        importError={s.importError}
        onExport={() => void settings.exportTheme()}
        section={s.section}
        onSectionChange={(section) => store.setState({ settingsSection: section })}
        explorer={s.explorer}
        onExplorerChange={(patch) => settings.setExplorerAppearance(patch)}
        liveMessage={
          !s.open
            ? ''
            : aiOpen
              ? aiSnap.live
              : s.section === 'editor'
                ? editorLive
                : s.section === 'folder'
                  ? folderLive
                  : (plugins.announcement?.text ?? '')
        }
        pluginsInitialFocus={pluginsReload}
        editorInitialFocus={editorSwitch}
        autocompleteInitialFocus={autocompleteSwitch}
        aiInitialFocus={aiProvider}
        folderInitialFocus={folderSwitch}
        editor={
          <EditorSection
            captureTab={s.captureTab}
            captureTabInvalid={captureTabInvalid}
            switchRef={editorSwitch}
            onCaptureTabChange={(on) => {
              settings.setCaptureTab(on);
              setEditorLive(
                on
                  ? `Tecla Tab no editor ligada. Para sair do editor: Esc e depois Tab, ou ${SPOKEN_TOGGLE[OS]}.`
                  : 'Tecla Tab no editor desligada.',
              );
            }}
            defaultMode={s.defaultMode}
            defaultModeInvalid={defaultModeInvalid}
            onDefaultModeChange={(mode) => {
              // r28 NB-1: escolher "Fonte" sobre um valor inválido grava e apaga o aviso.
              settings.setDefaultMode(mode);
              app.defaultModeInvalid.set(false);
            }}
          />
        }
        ai={
          <AiSettings
            provider={s.ai.provider}
            model={s.ai.provider === null ? '' : (s.ai.models[s.ai.provider] ?? '')}
            models={
              aiSnap.models.provider === s.ai.provider
                ? aiSnap.models
                : { state: 'idle', list: [], message: '' }
            }
            keys={aiSnap.keys}
            keyErrors={aiSnap.keyErrors}
            ollamaUrl={s.ai.ollamaUrl}
            language={s.ai.language}
            providerRef={aiProvider}
            onProviderChange={(provider) => settings.setAi({ provider })}
            onModelChange={(model) => {
              const provider = store.getState().ai.provider;
              if (provider)
                settings.setAi({ models: { ...store.getState().ai.models, [provider]: model } });
            }}
            onRefreshModels={() => void app.ai.refreshModels()}
            onSaveKey={(provider, value) => void app.ai.saveKey(provider, value)}
            onRemoveKey={(provider) => void app.ai.removeKey(provider)}
            onOllamaUrlChange={(url) => {
              const normalized = normalizeOllamaUrl(url);
              if (normalized === null) return false;
              settings.setAi({ ollamaUrl: normalized });
              return true;
            }}
            onLanguageChange={(language) => settings.setAi({ language })}
            consent={s.ai.consent}
            onRevokeConsent={(provider) => app.ai.revokeConsent(provider)}
          />
        }
        autocomplete={
          <AutocompleteSection
            settings={s.autocomplete}
            switchRef={autocompleteSwitch}
            onChange={(patch) => settings.setAutocomplete(patch)}
          />
        }
        plugins={
          <PluginManager
            reloadRef={pluginsReload}
            vaultOpen={plugins.vault === 'open'}
            scan={plugins.scan}
            internal={plugins.internal}
            external={plugins.external}
            onReload={() => void host.reload()}
            onToggle={(key, on) => void host.setEnabled(key, on)}
            optionsOf={(key): PluginOptionsData | null => {
              const options = host.internalOptions(key);
              if (!options) return null;
              return {
                fields: options.specs,
                values: options.values,
                info: async (field) => {
                  const spec = options.specs.find((candidate) => candidate.key === field);
                  if (!spec?.info) return '';
                  return spec.info({
                    values: options.values,
                    readFile: (name) => app.plugins.readConfigFile(name),
                  });
                },
                // r32c: a opção `dictionary` (lista do LanguageTool) usa o serviço do app, com o
                // plugin ligado ou não (D-R32-1).
                dictionary: app.dictionary,
              };
            }}
            onOptionChange={async (key, option, value) => {
              const result = await host.setInternalOption(key, option, value);
              return result.ok ? { ok: true } : { ok: false, message: result.message };
            }}
          />
        }
        folder={
          <FolderSection
            cloudOnly={s.indexCloudOnly}
            vaultOpen={s.vaultOpen}
            downloading={cloudDownloading}
            switchRef={folderSwitch}
            onCloudOnlyChange={(on) => {
              // Só promete download se há nota só na nuvem a baixar (code-review r36c NB-1).
              const toDownload = on && cloudDownloads(app.catalog.getSnapshot(), true) > 0;
              settings.setIndexCloudOnly(on);
              setFolderLive(
                !on
                  ? 'Indexar notas só na nuvem desligado.'
                  : toDownload
                    ? 'Indexar notas só na nuvem ligado. As notas desta pasta que estão só na nuvem vão ser baixadas para indexar.'
                    : 'Indexar notas só na nuvem ligado.',
              );
            }}
          />
        }
      />
      <PluginWarning
        warning={s.open ? plugins.warning : null}
        onCancel={() => closeWarning(() => host.cancelWarning())}
        onActivate={() => closeWarning(() => host.confirmWarning())}
        onClosed={warningClosed}
      />
      <ThemeEditorDialog
        key={editorSession}
        open={s.open && s.editorOpen}
        onClose={() => store.setState({ themeEditorOpen: false })}
        themes={themes}
        initialThemeId={settings.effectiveThemeId()}
        previewDoc={themePreviewDoc}
        canSave={s.vaultOpen}
        onSave={async (draft) => {
          const ok = await settings.saveNewTheme(draft);
          if (ok) store.setState({ themeEditorOpen: false });
          return ok;
        }}
      />
    </>
  );
}

function Shell({ app, editor }: { app: AppController; editor: GroupEditors }) {
  const { store, sync, registry } = app;
  const s = useStore(
    store,
    useShallow((state) => ({
      vaultName: state.vaultName,
      listStatus: state.listStatus,
      entries: state.entries,
      expanded: state.expanded,
      focusedPath: state.focusedPath,
      tabs: state.tabs,
      activeId: state.activeId,
      groupActive: state.groupActive,
      split: state.split,
      focusedGroup: state.focusedGroup,
      docs: state.docs,
      sidePanelOpen: state.sidePanelOpen,
      sidePanelTab: state.sidePanelTab,
      catalogMode: state.catalogMode,
      exportBusy: state.exportBusy,
      captureTab: state.captureTab,
      folderColors: state.folderColors,
      explorerLive: state.explorerLive,
      explorerAppearance: state.explorerAppearance,
      layoutPreview: state.layoutPreview,
    })),
  );
  const { editor: assembly, panels } = app.plugins;
  const panelList = useSyncExternalStore(panels.subscribe, panels.getSnapshot);
  const pluginTabs = useMemo<SidePanelTab[]>(
    () =>
      panelList.map((panel) => ({
        kind: 'plugin' as const,
        id: panel.id,
        title: panel.title,
        pluginName: panel.pluginName,
        el: panel.el,
        failed: panel.failed,
        ensureRendered: () => panels.ensureRendered(panel.id),
      })),
    [panelList, panels],
  );
  const catalog = useSyncExternalStore(app.catalog.subscribe, app.catalog.getSnapshot);
  const ai = useSyncExternalStore(app.ai.subscribe, app.ai.getSnapshot);
  // A prontidão (STR-131) depende do provedor/modelo (store; esta assinatura re-renderiza) e do
  // estado das chaves (snapshot acima). Cálculo barato, feito a cada render.
  useStore(store, (state) => state.ai);
  const readiness = app.ai.readiness();
  const statusBar = app.plugins.statusBar;
  const status = useSyncExternalStore(statusBar.subscribe, statusBar.getSnapshot);
  const focusEditor = () => requestAnimationFrame(() => editor.current?.focus());
  /**
   * Sumário e Propriedades: recalculados 300 ms depois da última mudança do documento (NFR-31),
   * nunca por tecla; só enquanto um desses painéis está à vista.
   */
  const [docTick, setDocTick] = useState(0);
  const docTimer = useRef<number | undefined>(undefined);
  const docPanelVisible =
    s.sidePanelOpen && (s.sidePanelTab === 'toc' || s.sidePanelTab === 'properties');
  useEffect(() => {
    const timer = docTimer;
    return () => window.clearTimeout(timer.current);
  }, []);
  /** Rolagem de cada aba que saiu da tela, dos dois grupos (uma nota fica num grupo só). */
  const scrolls = useRef(new Map<string, StateEffect<unknown>>());
  const activeStatus = s.activeId === null ? undefined : s.docs[s.activeId];
  // r38b (design-r38 §1): a prévia lado a lado aparece com uma aba, `layout.preview.open` e 900 px
  // na área do editor (r39b: 960 com o editor dividido); escondida, o motor não faz nada. Ela
  // mostra a aba ativa do grupo com foco.
  const previewFits = useStore(
    store,
    (state) => state.editorWidth === null || state.editorWidth >= sidePreviewMinWidth(state.split),
  );
  const previewWanted = s.layoutPreview.open && s.activeId !== null;
  const previewVisible = previewWanted && previewFits;
  useEffect(() => {
    app.preview.setVisible(previewVisible);
    return () => app.preview.setVisible(false);
  }, [app, previewVisible]);
  // Pedida e sem espaço (janela estreita, painel lateral aberto): o editor diz por quê.
  useEffect(() => {
    if (!previewWanted || previewFits) return;
    const { editorWidth, split } = store.getState();
    const text = SIDE_PREVIEW_TEXT.hidden(editorWidth ?? 0, sidePreviewMinWidth(split));
    assembly.view?.dispatch({ effects: EditorView.announce.of(text) });
  }, [previewWanted, previewFits, store, assembly]);

  // r39c (evidência r39b, achado 1): com o editor dividido, a troca do grupo com foco anuncia pelo
  // canal do app (região polida do editor com foco). Uma vez por quadro, com o grupo final: a
  // devolução de foco da paleta seguida da reafirmação do ⌘\ não fala. Dividir e juntar têm o
  // anúncio deles.
  useEffect(() => {
    let { split, focusedGroup } = store.getState();
    let spoken = focusedGroup;
    let frame = 0;
    const off = store.subscribe((state) => {
      const wasSplit = split;
      split = state.split;
      if (state.focusedGroup === focusedGroup && split === wasSplit) return;
      focusedGroup = state.focusedGroup;
      if (!split || !wasSplit) {
        spoken = focusedGroup;
        return;
      }
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const now = store.getState();
        if (!now.split || now.focusedGroup === spoken) return;
        spoken = now.focusedGroup;
        assembly.view?.dispatch({ effects: EditorView.announce.of(GROUP_TEXT.focused[spoken]) });
      });
    });
    return () => {
      off();
      cancelAnimationFrame(frame);
    };
  }, [store, assembly]);

  // Recarga do disco da aba ativa: Sumário e Propriedades recalculam (o grupo dela troca o estado).
  useEffect(
    () =>
      registry.onReplace((id) => {
        if (id === store.getState().activeId && store.getState().docs[id] !== 'loading')
          setDocTick((tick) => tick + 1);
      }),
    [registry, store],
  );
  const onDocChange = () => {
    if (!docPanelVisible) return;
    window.clearTimeout(docTimer.current);
    docTimer.current = window.setTimeout(() => setDocTick((tick) => tick + 1), 300);
  };

  // O registro tem o estado mais recente de cada aba (toda mudança passa por `onEditorChange`).
  const docPanel = useMemo(() => {
    if (!docPanelVisible || s.activeId === null) return null;
    if (activeStatus === undefined || activeStatus === 'loading') return null;
    const state = registry.get(s.activeId)?.state;
    if (!state) return null;
    return {
      tick: docTick,
      toc: s.sidePanelTab === 'toc' ? computeToc(state) : [],
      properties: s.sidePanelTab === 'properties' ? readNoteProperties(state) : null,
    };
  }, [docPanelVisible, s.activeId, s.sidePanelTab, activeStatus, registry, docTick]);

  /** Cursor no início da linha, rolagem até ela e foco no editor (TOC-GO, PRP-GO). */
  const goTo = (pos: number) => {
    const handle = editor.current;
    if (!handle) return;
    handle.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'start' }),
    });
    handle.focus();
  };

  // r12 (D-R12-F1): a cor efetiva entra aqui; trocar de aba muda só a ativa, então este memo
  // mantém a referência e nada é recalculado por troca (NFR-12.5). r39b: as abas de cada grupo.
  const tabViews = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tab of s.tabs) counts.set(tab.name, (counts.get(tab.name) ?? 0) + 1);
    const groups: [TabView[], TabView[]] = [[], []];
    for (const tab of s.tabs) {
      const status = s.docs[tab.id];
      const folder = tab.path.includes('/') ? tab.path.slice(0, tab.path.lastIndexOf('/')) : '';
      const color = resolveFolderColor(s.folderColors, tab.path);
      groups[tab.group].push({
        id: tab.id,
        path: tab.path,
        name: tab.name,
        ...((counts.get(tab.name) ?? 0) > 1 ? { folder: nameOf(folder) || '/' } : {}),
        saveState: status === undefined || status === 'loading' ? 'clean' : status,
        ...(color ? { folderColor: { id: color.id, origin: nameOf(color.folder) } } : {}),
      });
    }
    return groups;
  }, [s.tabs, s.docs, s.folderColors]);

  // r13 (D-R13-B2): o arco-íris é derivado aqui, nunca guardado nem visto pelas abas (`tabViews`
  // acima lê só `folderColors`, D-R13-P2). Recalcula só com a listagem, as cores próprias ou `auto`.
  const autoColors = useMemo(
    () =>
      s.explorerAppearance.auto === 'rainbow'
        ? rainbowColors(s.entries, s.folderColors)
        : NO_AUTO_COLORS,
    [s.entries, s.folderColors, s.explorerAppearance.auto],
  );
  const explorerStyle = useMemo(
    () => effectiveExplorer(s.explorerAppearance),
    [s.explorerAppearance],
  );

  const activeTab = s.tabs.find((tab) => tab.id === s.activeId);

  const openFile = async (path: string) => {
    if (await sync.openFile(path)) requestAnimationFrame(() => editor.current?.focus());
  };

  const hasTab = docPanel !== null;
  // r7 S2: painel "Links" (backlinks da nota ativa; R-I2.7).
  const linksPanel = useLinksPanel(
    app,
    catalog,
    activeStatus === undefined || activeStatus === 'loading' ? null : s.activeId,
    s.sidePanelOpen && s.sidePanelTab === 'links',
    () => editor.current?.view ?? null,
  );
  // Recalculado a cada render (abas/status do store): sem aba → STR-115 nos itens do M1.
  const exportReady = app.exporter.enabled();
  const sidePanels: SidePanelTab[] = [
    {
      kind: 'builtin',
      id: 'catalog',
      title: 'Catálogo',
      content: (
        <CatalogPanel
          snapshot={catalog}
          activePath={s.activeId}
          onOpen={(path) => void openFile(path)}
          onShown={() => app.platform.log('simplemd:catalog-shown')}
          mode={s.catalogMode}
          onModeChange={(mode) => store.setState({ catalogMode: mode })}
          content={<ContentSearchView app={app} entries={catalog.entries} />}
        />
      ),
    },
    {
      kind: 'builtin',
      id: 'toc',
      title: 'Sumário',
      content: <TocPanel hasTab={hasTab} entries={docPanel?.toc ?? []} onGo={goTo} />,
    },
    {
      kind: 'builtin',
      id: 'properties',
      title: 'Propriedades',
      content: (
        <PropertiesPanel
          hasTab={hasTab}
          properties={docPanel?.properties ?? { kind: 'none' }}
          onGo={goTo}
        />
      ),
    },
    {
      kind: 'builtin',
      id: 'links',
      title: 'Links',
      content: <LinksPanel {...linksPanel} />,
    },
    {
      kind: 'builtin',
      id: 'chat',
      title: 'Chat IA',
      content: (
        <ChatPanel
          banner={readiness.ok ? null : readiness.message}
          emptyText={
            readiness.ok
              ? `Pergunte algo. Só o que você digitar aqui é enviado para ${PROVIDER_NAMES[readiness.provider]} (${readiness.model}).`
              : ''
          }
          messages={ai.messages}
          streaming={ai.streaming}
          status={ai.chatStatus}
          announcement={ai.chatAnnouncement}
          canInsert={s.activeId !== null}
          onMount={() => void app.ai.refreshKeys()}
          onOpenSettings={() => store.setState({ settingsOpen: true, settingsSection: 'ai' })}
          onSend={(text) => void app.ai.send(text)}
          onStop={() => app.ai.stop()}
          onClear={() => app.ai.clear()}
          onInsert={(id) => app.ai.insertAnswer(id)}
          onCopy={(id) => void app.ai.copyAnswer(id)}
          restore={ai.chatRestore}
        />
      ),
    },
    ...pluginTabs,
  ];

  return (
    <div className="smd-shell" data-side-panel={s.sidePanelOpen ? 'open' : 'closed'}>
      <Toolbar
        vaultName={s.vaultName}
        onOpenVault={() => void sync.openVault('shell')}
        onNewNote={() => sync.openNewNote()}
        onOpenSettings={() => store.setState({ settingsOpen: true, settingsSection: 'appearance' })}
        onOpenPalette={() => store.setState({ paletteOpen: true, palettePrefill: '' })}
        sidePanelOpen={s.sidePanelOpen}
        onToggleSidePanel={() => toggleSidePanel(app, editor, 'button')}
        exportMenu={{
          disabledReason: exportReady === true ? null : exportReady.reason,
          busy: s.exportBusy,
          onSelect: (kind) => app.exporter.start(kind),
        }}
      />
      <Explorer
        status={s.listStatus}
        entries={s.entries}
        expanded={s.expanded}
        activePath={s.activeId}
        focusedPath={s.focusedPath}
        folderColors={s.folderColors}
        autoColors={autoColors}
        appearance={explorerStyle}
        live={s.explorerLive}
        onToggle={(path) => {
          store.getState().toggleFolder(path);
          store.getState().setFocused(path);
        }}
        onOpen={(path) => {
          store.getState().setFocused(path);
          void openFile(path);
        }}
        onFocusPath={(path) => store.getState().setFocused(path)}
        onRetry={() => {
          store.setState({ listStatus: 'loading' });
          void sync.refreshList();
        }}
        onPickOther={() => void sync.openVault('shell')}
        onOpenVault={() => void sync.openVault('shell')}
        onNewNote={() => sync.openNewNote()}
      />
      <main className="smd-main">
        {/* Dentro de um marco, para a regra `region` do axe (a11y F-2 / EC F-9). */}
        <h1 className="sr-only">simpleMD</h1>
        {/* r39b (design-r39 §1): os grupos do editor são o lado inicial do divisor da prévia; o
            grupo 0 é sempre o 1º filho (o EditorView dele nunca é recriado). */}
        <SplitPane
          startId="editor-split-start"
          start={
            <div className="smd-groups">
              {([0, 1] as const).slice(0, s.split ? 2 : 1).map((group) => {
                const active = s.groupActive[group];
                return (
                  <EditorGroup
                    key={group}
                    app={app}
                    group={group}
                    split={s.split}
                    focused={s.focusedGroup === group}
                    tabs={tabViews[group]}
                    activeId={active}
                    activeStatus={active === null ? undefined : s.docs[active]}
                    editors={editor}
                    scrolls={scrolls}
                    onCloseTab={(id) => void closeTab(app, editor, id)}
                    onCloseGroup={() => closeGroup(app, editor, group)}
                    onDocChange={onDocChange}
                  />
                );
              })}
            </div>
          }
          end={
            previewVisible && activeTab ? (
              <PreviewView
                app={app}
                name={activeTab.name}
                onFocusExit={() => focusEditorOrExplorer(app, editor)}
              />
            ) : null
          }
          ratio={s.layoutPreview.ratio}
          onRatioChange={(ratio) => app.settings.setPreviewLayout({ ratio })}
          onFitChange={(_fits, width) => store.setState({ editorWidth: width })}
          {...(s.split ? { minStart: GROUPS_MIN_WIDTH_PX } : {})}
          separatorLabel={SIDE_PREVIEW_TEXT.separator}
          startLabel={SIDE_PREVIEW_TEXT.start}
          endLabel={SIDE_PREVIEW_TEXT.end}
        />
        <ResultCard
          card={ai.card}
          blocks={{
            replace: app.ai.cardBlock('replace'),
            insert: app.ai.cardBlock('insert'),
            copy: app.ai.cardBlock('copy'),
          }}
          announcement={ai.card?.status === 'done' ? ai.cardAnnouncement : ''}
          onReplace={() => {
            if (app.ai.replaceSelection()) focusEditor();
          }}
          onInsertBelow={() => {
            if (app.ai.insertBelow()) focusEditor();
          }}
          onCopy={() => void app.ai.copyCard()}
          onDiscard={() => {
            app.ai.discardCard();
            focusEditor();
          }}
        />
        {/* Descrição `aria-describedby` do `.cm-content` com a chave ligada (STR-158, DA-R7-11). */}
        {s.captureTab && (
          <p id={TAB_HELP_ID} className="sr-only" data-testid="editor-tab-help">
            {tabModeDescription(status.tab?.mode ?? 'indent', OS)}
          </p>
        )}
        <ShellStatusBar
          app={app}
          captureTab={s.captureTab}
          tabOpen={s.activeId !== null}
          editorOpen={s.tabs.length > 0}
          status={status}
        />
      </main>
      <SidePanel
        open={s.sidePanelOpen}
        panels={sidePanels}
        activeId={s.sidePanelTab}
        onActivate={(id) => store.setState({ sidePanelTab: id })}
      />
    </div>
  );
}

/**
 * r37c: o modo "Conteúdo" do Catálogo (design-r37 §4). Só ele assina a busca no texto, então cada
 * lote de resultados re-renderiza este painel e não a casca. O título de cada nota vem do índice
 * (sem ele, o nome do arquivo).
 */
function ContentSearchView({
  app,
  entries,
}: {
  app: AppController;
  entries: readonly IndexEntry[];
}) {
  const search = textSearchOf(app);
  const state = useSyncExternalStore(search.subscribe, search.getSnapshot);
  const titles = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry.title])),
    [entries],
  );
  const titleOf = useCallback((path: string) => titles.get(path) || fileTitle(path), [titles]);
  return (
    <ContentSearch
      state={state}
      titleOf={titleOf}
      onQueryChange={(query) => search.setQuery(query)}
      onCancel={() => search.cancel()}
      onRetry={() => search.retry()}
      onOpen={(path, hit) => void search.open(path, hit)}
    />
  );
}

/**
 * r38b: o painel da prévia lado a lado (design-r38 §1). Só ele assina o status do motor, então cada
 * renderização re-renderiza este painel e não a casca. O host vazio vai para o motor (`attach`).
 */
function PreviewView({
  app,
  name,
  onFocusExit,
}: {
  app: AppController;
  name: string;
  onFocusExit: () => void;
}) {
  const { preview } = app;
  const status = useSyncExternalStore(preview.status.subscribe, preview.status.getSnapshot);
  const host = useRef<HTMLDivElement | null>(null);
  const [refused, setRefused] = useState(0);
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      host.current = el;
      preview.attach(el);
    },
    [preview],
  );
  // Blocos recusados (r38a2 F3), contados no host a cada renderização inserida: a região de status
  // do painel diz quantos quando a conta muda.
  useEffect(
    () =>
      preview.status.subscribe(() => {
        if (preview.status.getSnapshot().kind !== 'ready') return;
        setRefused(host.current?.querySelectorAll(`.${PREVIEW_REFUSED_CLASS}`).length ?? 0);
      }),
    [preview],
  );
  return (
    <PreviewPane
      name={name}
      hostRef={attach}
      busy={status.kind === 'rendering'}
      error={status.kind === 'error' ? status.reason : null}
      refused={status.kind === 'ready' || status.kind === 'rendering' ? refused : 0}
      closeKey={TOGGLE_SIDE_PREVIEW_KEY}
      onClose={() => toggleSidePreview(app)}
      onFocusExit={onFocusExit}
    />
  );
}

/**
 * Barra de status C6 da casca (r7 §3.5, UX-R7-D11; r27 D-R27-03): existe com uma aba aberta (item
 * "Fonte"/"Prévia" da nota mostrada), quando a "Tecla Tab no editor", o Vim ou o LanguageTool
 * estão ligados POR CONFIGURAÇÃO (alternar T1↔T2 ou o modo nunca a faz aparecer ou sumir) ou depois
 * do 1º pedido de IA da sessão (contador, r31). O item Tab aparece com a chave; modo e LT, com uma
 * aba aberta no grupo com o foco (o modo só depois da carga); o Vim, com uma aba aberta em qualquer
 * grupo — logo depois de dividir (⌘\), com o grupo novo vazio, ele segue com o modo do último editor
 * (evidence r39c NB-2).
 */
function ShellStatusBar({
  app,
  captureTab,
  tabOpen,
  editorOpen,
  status,
}: {
  app: AppController;
  captureTab: boolean;
  tabOpen: boolean;
  /** Há aba aberta em algum grupo (r39): existe um editor com o Vim. */
  editorOpen: boolean;
  status: StatusBarSnapshot;
}) {
  // Ligar/desligar um plugin publica no host: esta barra re-renderiza e relê a configuração.
  useSyncExternalStore(app.plugins.host.subscribe, app.plugins.host.getSnapshot);
  const { editor } = app.plugins;
  const mode = useSyncExternalStore(editor.mode.subscribe, editor.mode.getSnapshot);
  const vimOn = app.settings.internalPluginEnabled('simplemd.vim');
  const ltOn = app.settings.internalPluginEnabled('simplemd.languagetool');
  const ai = status.ai ?? null;
  if (!captureTab && !vimOn && !ltOn && !tabOpen && ai === null) return null;
  return (
    <StatusBar
      mode={tabOpen ? mode : null}
      modeToggleKey={TOGGLE_LIVE_PREVIEW_KEY}
      onModeToggle={() => editor.toggleLivePreview()}
      vim={vimOn && editorOpen ? (status.vim?.mode ?? null) : null}
      tab={captureTab ? (status.tab?.mode ?? 'indent') : null}
      tabToggleKey={TAB_FOCUS_HOTKEY[OS]}
      lt={ltOn && tabOpen ? status.lt : null}
      ltCheckKey="Mod-Shift-o"
      onLtAction={(action) => {
        if (action === 'install') {
          app.platform.openUrl(LANGUAGETOOL_DOCS_URL).catch(() =>
            app.store.getState().pushNotice({
              kind: 'error',
              notice: 'link',
              text: 'Não foi possível abrir o link no navegador.',
            }),
          );
          return;
        }
        app.plugins.statusBar.runLtAction(action);
      }}
      ai={ai}
    />
  );
}
