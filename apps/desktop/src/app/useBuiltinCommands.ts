import { AI_COMMAND_LABELS, AI_COMMANDS, AI_LANGUAGES } from '@simplemd/ai';
import type { CodeMirrorEditorHandle } from '@simplemd/ui';
import { useEffect, type RefObject } from 'react';
import { useStore } from 'zustand';
import type { AppController } from './controller';
import { closeTab, toggleSidePanel } from './focus';

/**
 * Comandos embutidos da paleta (arch-ux r2 §3.6; ids = `data-command-id`). A exportação chega com
 * a etapa 10. "IA: Traduzir seleção" mostra o idioma configurado (re-registrado quando muda).
 */
export function useBuiltinCommands(
  app: AppController,
  editor: RefObject<CodeMirrorEditorHandle | null>,
): void {
  const language = useStore(app.store, (s) => s.ai.language);
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
      ...(
        [
          ['app:show-catalog', 'Mostrar catálogo', 'catalog'],
          ['app:show-toc', 'Mostrar sumário', 'toc'],
          ['app:show-properties', 'Mostrar propriedades', 'properties'],
          ['app:show-chat', 'Abrir chat IA', 'chat'],
        ] as const
      ).map(([id, title, panel]) =>
        commands.register({
          id,
          title,
          source: 'builtin',
          isEnabled: vaultOpen,
          // SPN-PALETTE-OPEN: abre o painel nessa aba e leva o foco até ela.
          run: () => {
            app.store.setState({ sidePanelOpen: true, sidePanelTab: panel });
            requestAnimationFrame(() =>
              document
                .querySelector<HTMLElement>('#side-panel [role="tab"][aria-selected="true"]')
                ?.focus(),
            );
          },
        }),
      ),
      // Comandos sobre a seleção (R-11.8, STR-132): o resultado vai para o cartão C5.
      ...AI_COMMANDS.map((command) =>
        commands.register({
          id: `ai:${command}`,
          title: AI_COMMAND_LABELS[command],
          source: 'builtin',
          ...(command === 'translate'
            ? { detail: `para ${AI_LANGUAGES.find((l) => l.id === language)?.label ?? 'English'}` }
            : {}),
          isEnabled: () => app.ai.commandEnabled(),
          run: () => void app.ai.runCommand(command),
        }),
      ),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [app, editor, language]);
}
