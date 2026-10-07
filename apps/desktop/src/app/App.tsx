import type { StateEffect } from '@codemirror/state';
import themePreviewDoc from '@simplemd/core/samples/theme-preview.md?raw';
import {
  CodeMirrorEditor,
  CommandPalette,
  ConflictDialog,
  EditorPanel,
  Explorer,
  hotkeyAria,
  hotkeyLabel,
  Notices,
  PluginManager,
  PluginWarning,
  SettingsDialog,
  SidePanel,
  TabBar,
  ThemeEditorDialog,
  Toolbar,
  UnsavedCloseDialog,
  Welcome,
  tabDomId,
  type CodeMirrorEditorHandle,
  type PaletteItem,
  type SidePanelPluginTab,
  type TabView,
} from '@simplemd/ui';
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
import { closeTab, focusEditorOrExplorer, toggleSidePanel } from './focus';
import { useBuiltinCommands } from './useBuiltinCommands';
import { useGlobalKeys } from './useGlobalKeys';

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
  const editor = useRef<CodeMirrorEditorHandle>(null);

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
          // "Voltar" leva à primeira aba que não pôde ser gravada (arch-ux §5.3).
          const failing = store
            .getState()
            .tabs.find((tab) => store.getState().docs[tab.id] === 'error');
          if (failing) store.getState().activate(failing.id);
          requestAnimationFrame(() =>
            document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus(),
          );
        }}
        onDiscard={() => void app.sync.discardAndClose()}
      />
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
      commands.getSnapshot().map((command) => {
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
    })),
  );
  // Cada abertura do L3 começa um rascunho novo (descartado ao fechar; OQ-2).
  const [editorSession, setEditorSession] = useState(0);
  // `userThemes` (no seletor acima) re-renderiza esta vista quando a lista muda.
  const themes = settings.themes();
  const pickFile = platform.pickFile;
  const host = app.plugins.host;
  const plugins = useSyncExternalStore(host.subscribe, host.getSnapshot);
  // L6 devolve o foco ao interruptor que o abriu (arch-ux r2 §6.3).
  const warningOpener = useRef<HTMLElement | null>(null);
  const pluginsReload = useRef<HTMLButtonElement>(null);
  const warningOpen = plugins.warning !== null;
  useLayoutEffect(() => {
    if (!warningOpen) return;
    const active = document.activeElement;
    warningOpener.current = active instanceof HTMLElement ? active : null;
  }, [warningOpen]);
  const closeWarning = (action: () => Promise<void> | void) => {
    const opener = warningOpener.current;
    void action();
    requestAnimationFrame(() => {
      if (opener?.isConnected) opener.focus();
    });
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
        liveMessage={s.open ? (plugins.announcement?.text ?? '') : ''}
        pluginsInitialFocus={pluginsReload}
        plugins={
          <PluginManager
            reloadRef={pluginsReload}
            vaultOpen={plugins.vault === 'open'}
            scan={plugins.scan}
            internal={plugins.internal}
            external={plugins.external}
            onReload={() => void host.reload()}
            onToggle={(key, on) => void host.setEnabled(key, on)}
          />
        }
      />
      <PluginWarning
        warning={s.open ? plugins.warning : null}
        onCancel={() => closeWarning(() => host.cancelWarning())}
        onActivate={() => closeWarning(() => host.confirmWarning())}
      />
      <ThemeEditorDialog
        key={editorSession}
        open={s.open && s.editorOpen}
        onClose={() => store.setState({ themeEditorOpen: false })}
        themes={themes}
        initialThemeId={s.themeId}
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

function Shell({
  app,
  editor,
}: {
  app: AppController;
  editor: RefObject<CodeMirrorEditorHandle | null>;
}) {
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
      docs: state.docs,
      sidePanelOpen: state.sidePanelOpen,
      sidePanelTab: state.sidePanelTab,
    })),
  );
  const { editor: assembly, panels } = app.plugins;
  const panelList = useSyncExternalStore(panels.subscribe, panels.getSnapshot);
  const sideTabs = useMemo<SidePanelPluginTab[]>(
    () =>
      panelList.map((panel) => ({
        id: panel.id,
        title: panel.title,
        pluginName: panel.pluginName,
        el: panel.el,
        failed: panel.failed,
        ensureRendered: () => panels.ensureRendered(panel.id),
      })),
    [panelList, panels],
  );
  // O view montado recebe as contribuições dos plugins por `reconfigure` (regra 5).
  useLayoutEffect(() => {
    assembly.attach(editor.current?.view ?? null);
    return () => assembly.attach(null);
  }, [assembly, editor]);
  /** Aba cujo estado está no editor agora: a origem de cada `onChange`. */
  const shownId = useRef<string | null>(null);
  const scrolls = useRef(new Map<string, StateEffect<unknown>>());
  const activeStatus = s.activeId === null ? undefined : s.docs[s.activeId];

  const showTab = useCallback(
    (id: string | null) => {
      const handle = editor.current;
      if (!handle) return;
      const previous = shownId.current;
      const left = previous === null || previous === id ? undefined : registry.get(previous);
      if (previous !== null && left) {
        // arch-frontend F-3, passo 1: guarda o estado inteiro da aba que sai (cursor, seleção,
        // foco), não só o que veio de transações que mudaram o documento (CR-04). Só quando o
        // documento é o mesmo: uma recarga do disco já trocou o estado do registro.
        if (left.state.doc.eq(handle.view.state.doc))
          registry.updateState(previous, handle.view.state);
        scrolls.current.set(previous, handle.view.scrollSnapshot());
      }
      const record = id === null ? undefined : registry.get(id);
      shownId.current = record ? id : null;
      handle.setState(assembly.refresh(record ? record.state : assembly.emptyState()));
      const scroll = id === null ? undefined : scrolls.current.get(id);
      if (record && scroll) handle.dispatch({ effects: scroll });
      if (record) requestAnimationFrame(() => performance.mark('simplemd:file-visible'));
    },
    [editor, registry, assembly],
  );

  // Troca de aba (ou fim da leitura): um único EditorView, estado por aba (arch-frontend F-3).
  useLayoutEffect(() => {
    const wanted = activeStatus === undefined || activeStatus === 'loading' ? null : s.activeId;
    if (wanted !== shownId.current) showTab(wanted);
  }, [s.activeId, activeStatus, showTab]);

  // Recarga do disco (aba limpa ou conflito resolvido): o estado novo entra sem `onChange`.
  useEffect(
    () =>
      registry.onReplace((id) => {
        scrolls.current.delete(id);
        if (id === store.getState().activeId && store.getState().docs[id] !== 'loading')
          showTab(id);
      }),
    [registry, store, showTab],
  );

  const tabViews = useMemo<TabView[]>(() => {
    const counts = new Map<string, number>();
    for (const tab of s.tabs) counts.set(tab.name, (counts.get(tab.name) ?? 0) + 1);
    return s.tabs.map((tab) => {
      const status = s.docs[tab.id];
      const folder = tab.path.includes('/') ? tab.path.slice(0, tab.path.lastIndexOf('/')) : '';
      return {
        id: tab.id,
        path: tab.path,
        name: tab.name,
        ...((counts.get(tab.name) ?? 0) > 1 ? { folder: nameOf(folder) || '/' } : {}),
        saveState: status === undefined || status === 'loading' ? 'clean' : status,
      };
    });
  }, [s.tabs, s.docs]);

  const activeIndex = s.tabs.findIndex((tab) => tab.id === s.activeId);
  const activeTab = s.tabs[activeIndex];

  const openFile = async (path: string) => {
    if (await sync.openFile(path)) requestAnimationFrame(() => editor.current?.focus());
  };

  return (
    <div className="smd-shell" data-side-panel={s.sidePanelOpen ? 'open' : 'closed'}>
      <Toolbar
        vaultName={s.vaultName}
        onOpenVault={() => void sync.openVault('shell')}
        onOpenSettings={() => store.setState({ settingsOpen: true, settingsSection: 'appearance' })}
        onOpenPalette={() => store.setState({ paletteOpen: true, palettePrefill: '' })}
        sidePanelOpen={s.sidePanelOpen}
        onToggleSidePanel={() => toggleSidePanel(app, editor, 'button')}
      />
      <Explorer
        status={s.listStatus}
        entries={s.entries}
        expanded={s.expanded}
        activePath={s.activeId}
        focusedPath={s.focusedPath}
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
      />
      <main className="smd-main">
        {/* Dentro de um marco, para a regra `region` do axe (a11y F-2 / EC F-9). */}
        <h1 className="sr-only">simpleMD</h1>
        <TabBar
          tabs={tabViews}
          activeId={s.activeId}
          onActivate={(id, { focusEditor }) => {
            store.getState().activate(id);
            if (focusEditor) requestAnimationFrame(() => editor.current?.focus());
          }}
          onClose={(id) => void closeTab(app, editor, id)}
        />
        <EditorPanel
          labelledBy={activeIndex === -1 ? null : tabDomId(activeIndex)}
          openingName={activeTab && activeStatus === 'loading' ? activeTab.name : null}
        >
          <CodeMirrorEditor
            ref={editor}
            className="smd-panel-host"
            initialState={assembly.emptyState()}
            onChange={(update) => {
              if (shownId.current !== null) sync.onEditorChange(shownId.current, update.state);
            }}
          />
        </EditorPanel>
      </main>
      <SidePanel
        open={s.sidePanelOpen}
        panels={sideTabs}
        activeId={s.sidePanelTab}
        onActivate={(id) => store.setState({ sidePanelTab: id })}
      />
    </div>
  );
}
