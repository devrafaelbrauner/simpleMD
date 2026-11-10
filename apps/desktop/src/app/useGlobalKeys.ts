import { runScopeHandlers } from '@codemirror/view';
import { GLOBAL_KEY_SCOPE } from '@simplemd/plugin-api/runtime';
import { isMac, type CodeMirrorEditorHandle } from '@simplemd/ui';
import { useEffect, type RefObject } from 'react';
import { closeGroup, closeTab, splitEnabled, toggleSidePanel, toggleSplit } from './focus';
import type { AppController } from './controller';
import { matchGlobalKey } from './global-keys';
import { sidePreviewEnabled, toggleSidePreview } from './useBuiltinCommands';

/** Algum modal (L1–L8) está aberto: os atalhos de janela não agem (arch-ux r2 §6.1). */
function modalOpen(app: AppController): boolean {
  const s = app.store.getState();
  return (
    s.conflict !== null ||
    s.unsavedClose !== null ||
    s.settingsOpen ||
    s.paletteOpen ||
    s.exportOptions !== null ||
    s.newNote !== null
  );
}

/**
 * Atalhos de janela (tabela `GLOBAL_KEYS` em `global-keys.ts`; arch-frontend §4.3 e r2 §4.3), num
 * único `keydown` em captura para funcionarem também com o foco no explorador. Ignorados enquanto
 * um modal (L1–L8) está aberto.
 * - `Mod-W`: fecha a aba ativa (flush antes); sem abas não faz nada e NUNCA fecha a janela. Num grupo
 *   vazio do editor dividido, fecha o grupo (r39b).
 * - `Mod-O`: "Abrir pasta…".
 * - `Mod-N`: "Nova nota…" (L8; só com uma pasta aberta).
 * - `Mod-,`: "Configurações" (L2, seção "Aparência").
 * - `Ctrl-Tab` / `Ctrl-Shift-Tab`: próxima / anterior aba do grupo com foco, com volta.
 * - `Mod-Shift-P`: paleta de comandos (L5), também nas boas-vindas.
 * - `Mod-Shift-L`: mostra/esconde o painel lateral (com uma pasta aberta).
 * - `Mod-Shift-A`: paleta filtrada em "IA: " (só com o foco no editor).
 * - `Mod-P`: "Exportar como PDF…" (etapa 10); sem aba, só o aviso STR-115 (nunca a impressão do
 *   navegador).
 * - `Mod-E`: alterna o live preview da nota mostrada (r27); sem nota, a tecla segue adiante.
 * - `Mod-Shift-D`: abre/fecha a prévia lado a lado (r38b); sem nota ou sem 900 px no editor (960
 *   com o editor dividido), só o aviso com o motivo; sob um modal não faz nada (a tecla nunca chega
 *   ao WebView).
 * - `Mod-\`: divide o editor ou junta os grupos (r39b); sem nota ou sem 640 px no editor, só o aviso
 *   com o motivo; como o `Mod-Shift-D`, nunca chega ao WebView.
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
      // `Mod-P` nunca abre a impressão do WebView com a janela inteira, nem sob um modal; `Mod-N`,
      // `Mod-Shift-D` e `Mod-\` também não chegam ao WebView (D-R9-S07), mesmo quando não agem.
      if (
        id === 'export-pdf' ||
        id === 'new-note' ||
        id === 'toggle-side-preview' ||
        id === 'toggle-split'
      ) {
        event.preventDefault();
      }
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
          else if (state.split) closeGroup(app, editor, state.focusedGroup);
          return;
        case 'open-vault':
          event.preventDefault();
          void app.sync.openVault(state.vaultStatus === 'open' ? 'shell' : 'welcome');
          return;
        case 'new-note':
          app.sync.openNewNote();
          return;
        case 'settings':
          event.preventDefault();
          app.store.setState({ settingsOpen: true, settingsSection: 'appearance' });
          return;
        case 'next-tab':
        case 'prev-tab':
          if (!state.tabs.some((tab) => tab.group === state.focusedGroup)) return;
          event.preventDefault();
          state.activateSibling(id === 'prev-tab' ? -1 : 1);
          requestAnimationFrame(() => editor.current?.focus());
          return;
        case 'toggle-live-preview':
          if (app.plugins.editor.toggleLivePreview()) event.preventDefault();
          return;
        case 'toggle-side-preview': {
          const enabled = sidePreviewEnabled(app);
          if (enabled === true) toggleSidePreview(app);
          else
            state.pushNotice({
              kind: 'info',
              notice: 'preview',
              key: 'preview',
              text: enabled.reason,
            });
          return;
        }
        case 'toggle-split': {
          const enabled = splitEnabled(app);
          if (enabled === true) toggleSplit(app, editor);
          else
            state.pushNotice({
              kind: 'info',
              notice: 'split',
              key: 'split',
              text: enabled.reason,
            });
          return;
        }
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
