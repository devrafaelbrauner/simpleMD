import type { StateEffect } from '@codemirror/state';
import { createMarkdownState } from '@simplemd/core';
import {
  CodeMirrorEditor,
  ConflictDialog,
  EditorPanel,
  Explorer,
  Notices,
  SettingsDialog,
  TabBar,
  Toolbar,
  UnsavedCloseDialog,
  Welcome,
  tabDomId,
  type CodeMirrorEditorHandle,
  type TabView,
} from '@simplemd/ui';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { AppController } from './controller';
import { closeTab, focusEditorOrExplorer } from './focus';
import { useGlobalKeys } from './useGlobalKeys';

/** Estado mostrado quando nenhuma aba existe (o painel fica escondido). */
const EMPTY_STATE = createMarkdownState('', { ariaLabel: 'Editor de markdown' });

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

  const afterConflict = async (action: () => Promise<void>) => {
    await action();
    // Foco no editor da aba ativa (UX-D13: a cópia; Recarregar: a própria aba).
    focusEditorOrExplorer(app, editor);
  };

  return (
    <>
      {vaultOpen ? <Shell app={app} editor={editor} /> : <WelcomeView app={app} />}
      <Notices items={shared.notices} onDismiss={shared.dismissNotice} />
      <SettingsView app={app} />
      <ConflictDialog
        conflict={conflictView}
        failed={shared.conflictFailed}
        busy={shared.conflictBusy}
        onKeepBoth={() => void afterConflict(() => app.sync.keepBoth())}
        onReload={() => void afterConflict(() => app.sync.reloadFromDisk())}
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
      onOpenSettings={() => app.store.setState({ settingsOpen: true })}
    />
  );
}

/** L2 CONFIGURAÇÕES ligado ao store e ao `SettingsController` (R-4.7). */
function SettingsView({ app }: { app: AppController }) {
  const { settings } = app;
  const s = useStore(
    app.store,
    useShallow((state) => ({
      open: state.settingsOpen,
      themeId: state.themeId,
      prefs: state.prefs,
      persistence: state.persistence,
    })),
  );
  const themes = settings.themes();
  return (
    <SettingsDialog
      open={s.open}
      onClose={() => app.store.setState({ settingsOpen: false })}
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
    />
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
    })),
  );
  /** Aba cujo estado está no editor agora: a origem de cada `onChange`. */
  const shownId = useRef<string | null>(null);
  const scrolls = useRef(new Map<string, StateEffect<unknown>>());
  const activeStatus = s.activeId === null ? undefined : s.docs[s.activeId];

  const showTab = useCallback(
    (id: string | null) => {
      const handle = editor.current;
      if (!handle) return;
      const previous = shownId.current;
      if (previous !== null && previous !== id && registry.get(previous)) {
        scrolls.current.set(previous, handle.view.scrollSnapshot());
      }
      const record = id === null ? undefined : registry.get(id);
      shownId.current = record ? id : null;
      handle.setState(record ? record.state : EMPTY_STATE);
      const scroll = id === null ? undefined : scrolls.current.get(id);
      if (record && scroll) handle.dispatch({ effects: scroll });
      if (record) requestAnimationFrame(() => performance.mark('simplemd:file-visible'));
    },
    [editor, registry],
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
    <div className="smd-shell">
      <h1 className="sr-only">simpleMD</h1>
      <Toolbar
        vaultName={s.vaultName}
        onOpenVault={() => void sync.openVault('shell')}
        onOpenSettings={() => store.setState({ settingsOpen: true })}
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
            initialState={EMPTY_STATE}
            onChange={(update) => {
              if (shownId.current !== null) sync.onEditorChange(shownId.current, update.state);
            }}
          />
        </EditorPanel>
      </main>
    </div>
  );
}
