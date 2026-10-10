import { runScopeHandlers } from '@codemirror/view';
import { GLOBAL_KEY_SCOPE } from '@simplemd/plugin-api/runtime';
import { isMac, type CodeMirrorEditorHandle } from '@simplemd/ui';
import { useEffect, type RefObject } from 'react';
import { closeTab, toggleSidePanel } from './focus';
import type { AppController } from './controller';
import { matchGlobalKey } from './global-keys';

/** Algum modal (L1–L7) está aberto: os atalhos de janela não agem (arch-ux r2 §6.1). */
function modalOpen(app: AppController): boolean {
  const s = app.store.getState();
  return (
    s.conflict !== null ||
    s.unsavedClose !== null ||
    s.settingsOpen ||
    s.paletteOpen ||
    s.exportOptions !== null
  );
}

/**
 * Atalhos de janela (tabela `GLOBAL_KEYS` em `global-keys.ts`; arch-frontend §4.3 e r2 §4.3), num
 * único `keydown` em captura para funcionarem também com o foco no explorador. Ignorados enquanto
 * um modal (L1–L7) está aberto.
 * - `Mod-W`: fecha a aba ativa (flush antes); sem abas não faz nada e NUNCA fecha a janela.
 * - `Mod-O`: "Abrir pasta…".
 * - `Mod-,`: "Configurações" (L2, seção "Aparência").
 * - `Ctrl-Tab` / `Ctrl-Shift-Tab`: próxima / anterior aba, com volta.
 * - `Mod-Shift-P`: paleta de comandos (L5), também nas boas-vindas.
 * - `Mod-Shift-L`: mostra/esconde o painel lateral (com uma pasta aberta).
 * - `Mod-Shift-A`: paleta filtrada em "IA: " (só com o foco no editor).
 * - `Mod-P`: "Exportar como PDF…" (etapa 10); sem aba, só o aviso STR-115 (nunca a impressão do
 *   navegador).
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
      const id = matchGlobalKey(event, isMac ? 'mac' : 'other');
      // `Mod-P` nunca abre a impressão do WebView com a janela inteira, nem sob um modal.
      if (id === 'export-pdf') event.preventDefault();
      if (id === null || modalOpen(app)) return;
      const state = app.store.getState();
      switch (id) {
        case 'palette':
          event.preventDefault();
          app.store.setState({ paletteOpen: true, palettePrefill: '' });
          return;
        case 'side-panel':
          if (state.vaultStatus !== 'open') return;
          event.preventDefault();
          toggleSidePanel(app, editor, 'key');
          return;
        case 'ai-palette': {
          // UX-R2-D18: no editor principal, abre a paleta já filtrada em "IA: " (a seleção fica).
          const target = event.target instanceof Element ? event.target : null;
          if (!target?.closest('.cm-editor')) return;
          event.preventDefault();
          app.store.setState({ paletteOpen: true, palettePrefill: 'IA: ' });
          return;
        }
        case 'export-pdf':
          app.exporter.start('pdf');
          return;
        case 'close-tab':
          event.preventDefault();
          if (state.activeId) void closeTab(app, editor, state.activeId);
          return;
        case 'open-vault':
          event.preventDefault();
          void app.sync.openVault(state.vaultStatus === 'open' ? 'shell' : 'welcome');
          return;
        case 'settings':
          event.preventDefault();
          app.store.setState({ settingsOpen: true, settingsSection: 'appearance' });
          return;
        case 'next-tab':
        case 'prev-tab':
          if (state.tabs.length === 0) return;
          event.preventDefault();
          state.activateSibling(id === 'prev-tab' ? -1 : 1);
          requestAnimationFrame(() => editor.current?.focus());
          return;
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
