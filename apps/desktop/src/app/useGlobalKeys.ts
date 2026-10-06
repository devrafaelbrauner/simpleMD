import { hasMod, type CodeMirrorEditorHandle } from '@simplemd/ui';
import { useEffect, type RefObject } from 'react';
import { closeTab } from './focus';
import type { AppController } from './controller';

/**
 * Atalhos de janela (arch-frontend §4.3), num único `keydown` em captura para funcionarem também
 * com o foco no explorador. Ignorados enquanto um modal (L1–L4) está aberto.
 * - `Mod-W`: fecha a aba ativa (flush antes); sem abas não faz nada e NUNCA fecha a janela.
 * - `Mod-O`: "Abrir pasta…".
 * - `Mod-,`: "Configurações" (L2).
 * - `Ctrl-Tab` / `Ctrl-Shift-Tab`: próxima / anterior aba, com volta.
 */
export function useGlobalKeys(
  app: AppController,
  editor: RefObject<CodeMirrorEditorHandle | null>,
): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const state = app.store.getState();
      if (state.conflict || state.unsavedClose || state.settingsOpen) return;
      const key = event.key.toLowerCase();
      if (hasMod(event) && !event.shiftKey && key === 'w') {
        event.preventDefault();
        if (state.activeId) void closeTab(app, editor, state.activeId);
      } else if (hasMod(event) && !event.shiftKey && key === 'o') {
        event.preventDefault();
        void app.sync.openVault(state.vaultStatus === 'open' ? 'shell' : 'welcome');
      } else if (hasMod(event) && !event.shiftKey && event.key === ',') {
        event.preventDefault();
        app.store.setState({ settingsOpen: true });
      } else if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'Tab') {
        if (state.tabs.length === 0) return;
        event.preventDefault();
        state.activateSibling(event.shiftKey ? -1 : 1);
        requestAnimationFrame(() => editor.current?.focus());
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [app, editor]);
}
