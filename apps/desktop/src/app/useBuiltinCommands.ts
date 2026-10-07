import type { CodeMirrorEditorHandle } from '@simplemd/ui';
import { useEffect, type RefObject } from 'react';
import type { AppController } from './controller';
import { closeTab, toggleSidePanel } from './focus';

/**
 * Comandos embutidos da paleta (arch-ux r2 §3.6; ids = `data-command-id`). Os de catálogo,
 * sumário, propriedades, exportação e IA chegam com as etapas 9, 10 e 11.
 */
export function useBuiltinCommands(
  app: AppController,
  editor: RefObject<CodeMirrorEditorHandle | null>,
): void {
  useEffect(() => {
    const { commands } = app.plugins;
    const state = () => app.store.getState();
    const vaultOpen = () =>
      state().vaultStatus === 'open' ? (true as const) : { reason: 'Abra uma pasta primeiro.' };
    const offs = [
      commands.register({
        id: 'app:open-vault',
        title: 'Abrir pasta…',
        source: 'builtin',
        hotkey: 'Mod-o',
        run: () => app.sync.openVault(state().vaultStatus === 'open' ? 'shell' : 'welcome'),
      }),
      commands.register({
        id: 'app:settings',
        title: 'Configurações',
        source: 'builtin',
        hotkey: 'Mod-,',
        run: () => app.store.setState({ settingsOpen: true, settingsSection: 'appearance' }),
      }),
      commands.register({
        id: 'app:plugins',
        title: 'Plugins…',
        source: 'builtin',
        run: () => app.store.setState({ settingsOpen: true, settingsSection: 'plugins' }),
      }),
      commands.register({
        id: 'app:close-tab',
        title: 'Fechar aba',
        source: 'builtin',
        hotkey: 'Mod-w',
        isEnabled: () => (state().activeId ? true : { reason: 'Nenhuma aba aberta.' }),
        run: () => {
          const id = state().activeId;
          if (id) void closeTab(app, editor, id);
        },
      }),
      commands.register({
        id: 'app:toggle-side-panel',
        title: 'Mostrar ou ocultar o painel lateral',
        source: 'builtin',
        hotkey: 'Mod-Shift-l',
        isEnabled: vaultOpen,
        run: () => toggleSidePanel(app, editor, 'key'),
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [app, editor]);
}
