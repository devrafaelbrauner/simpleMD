import { runScopeHandlers } from '@codemirror/view';
import { GLOBAL_KEY_SCOPE } from '@simplemd/plugin-api/runtime';
import { hasMod, type CodeMirrorEditorHandle } from '@simplemd/ui';
import { useEffect, type RefObject } from 'react';
import { closeTab, toggleSidePanel } from './focus';
import type { AppController } from './controller';

/** Algum modal (L1–L7) está aberto: os atalhos de janela não agem (arch-ux r2 §6.1). */
function modalOpen(app: AppController): boolean {
  const s = app.store.getState();
  return s.conflict !== null || s.unsavedClose !== null || s.settingsOpen || s.paletteOpen;
}

/**
 * Atalhos de janela (arch-frontend §4.3 e r2 §4.3), num único `keydown` em captura para
 * funcionarem também com o foco no explorador. Ignorados enquanto um modal (L1–L7) está aberto.
 * - `Mod-W`: fecha a aba ativa (flush antes); sem abas não faz nada e NUNCA fecha a janela.
 * - `Mod-O`: "Abrir pasta…".
 * - `Mod-,`: "Configurações" (L2, seção "Aparência").
 * - `Ctrl-Tab` / `Ctrl-Shift-Tab`: próxima / anterior aba, com volta.
 * - `Mod-Shift-P`: paleta de comandos (L5), também nas boas-vindas.
 * - `Mod-Shift-L`: mostra/esconde o painel lateral (com uma pasta aberta).
 *
 * Os atalhos de plugin rodam numa segunda escuta, em bolha, pelo escopo `simplemd-global` do
 * editor principal: nunca antecipam um atalho do editor e funcionam com o foco em qualquer lugar.
 */
export function useGlobalKeys(
  app: AppController,
  editor: RefObject<CodeMirrorEditorHandle | null>,
): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (modalOpen(app)) return;
      const state = app.store.getState();
      const key = event.key.toLowerCase();
      if (hasMod(event) && event.shiftKey && key === 'p') {
        event.preventDefault();
        app.store.setState({ paletteOpen: true, palettePrefill: '' });
      } else if (hasMod(event) && event.shiftKey && key === 'l') {
        if (state.vaultStatus !== 'open') return;
        event.preventDefault();
        toggleSidePanel(app, editor, 'key');
      } else if (hasMod(event) && event.shiftKey && key === 'a') {
        // UX-R2-D18: no editor principal, abre a paleta já filtrada em "IA: " (a seleção fica).
        const target = event.target instanceof Element ? event.target : null;
        if (!target?.closest('.cm-editor')) return;
        event.preventDefault();
        app.store.setState({ paletteOpen: true, palettePrefill: 'IA: ' });
      } else if (hasMod(event) && !event.shiftKey && key === 'w') {
        event.preventDefault();
        if (state.activeId) void closeTab(app, editor, state.activeId);
      } else if (hasMod(event) && !event.shiftKey && key === 'o') {
        event.preventDefault();
        void app.sync.openVault(state.vaultStatus === 'open' ? 'shell' : 'welcome');
      } else if (hasMod(event) && !event.shiftKey && event.key === ',') {
        event.preventDefault();
        app.store.setState({ settingsOpen: true, settingsSection: 'appearance' });
      } else if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'Tab') {
        if (state.tabs.length === 0) return;
        event.preventDefault();
        state.activateSibling(event.shiftKey ? -1 : 1);
        requestAnimationFrame(() => editor.current?.focus());
      }
    };
    const onPluginKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || modalOpen(app)) return;
      const handle = editor.current;
      if (!handle) return;
      if (runScopeHandlers(handle.view, event, GLOBAL_KEY_SCOPE)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keydown', onPluginKey);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keydown', onPluginKey);
    };
  }, [app, editor]);
}
