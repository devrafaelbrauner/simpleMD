import { Prec, type Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView } from '@codemirror/view';
import { getCM, Vim, vim } from '@replit/codemirror-vim';
import type { PluginAPI } from '@simplemd/plugin-api';
import type { InternalHostContext } from '@simplemd/plugin-api/internal/host';
import {
  createModeReporter,
  modeFromEvent,
  modeFromState,
  type ModeReporter,
  type VimMode,
  type VimModeChange,
} from './modes';
import { localizeDialogs, type VimDialogHost } from './panel';
import { vimTheme } from './theme';

/**
 * Comandos ex que o simpleMD define sem efeito e sem mensagem (D-44 = D-R7-P22 C; D-R7-F15b): o
 * salvamento automático continua o mesmo, nada fecha e nenhuma notificação aparece.
 */
export const SILENT_EX_COMMANDS: ReadonlyArray<readonly [name: string, prefix: string]> = [
  ['write', 'w'],
  ['quit', 'q'],
  ['wq', 'wq'],
  ['xit', 'x'],
];

/** `Vim` é global na biblioteca: definir de novo é idempotente (mesmo nome → mesma entrada). */
function defineSilentEx(): void {
  for (const [name, prefix] of SILENT_EX_COMMANDS) Vim.defineEx(name, prefix, () => {});
}

/**
 * Ponte por editor, criada logo depois do plugin do Vim (mesmo `Prec.highest`, ordem da lista):
 * traduz o painel W6 (D-R7-S4-01) e leva o modo ao indicador da barra de status (DA-R7-16). Com o
 * editor dividido (r39a), o indicador é do view com foco: ao nascer e a cada modo, um view só fala
 * se tem o foco ou se nenhum view com o Vim tem; ao ganhar o foco, fala se outro falou por último.
 * Com um view só, igual a antes.
 */
function vimBridge(reporter: ModeReporter): Extension {
  const views = new Set<EditorView>();
  let speaker: EditorView | null = null;
  return ViewPlugin.define((view) => {
    const cm = getCM(view);
    if (!cm) return {};
    localizeDialogs(cm as unknown as VimDialogHost);
    views.add(view);
    const speaks = () => view.hasFocus || ![...views].some((other) => other.hasFocus);
    const report = (mode: VimMode) => {
      speaker = view;
      reporter.report(mode);
    };
    const onModeChange = (event: VimModeChange) => {
      const mode = modeFromEvent(event);
      if (mode && speaks()) report(mode);
    };
    cm.on('vim-mode-change', onModeChange);
    if (speaks()) report(modeFromState(cm.state.vim, Boolean(cm.state.overwrite)));
    return {
      update(update) {
        if (update.focusChanged && view.hasFocus && speaker !== view)
          report(modeFromState(cm.state.vim, Boolean(cm.state.overwrite)));
      },
      destroy() {
        views.delete(view);
        if (speaker === view) speaker = null;
        cm.off('vim-mode-change', onModeChange);
      },
    };
  });
}

/**
 * Extensão do Vim no editor (arch-frontend §4.2 camada 4, §4.3): `Prec.highest` — o `keydown` do
 * Vim roda depois do árbitro do Escape e do alternador do núcleo (mesma precedência, configuração
 * anterior) e antes de todo keymap. Status da biblioteca desligado: o indicador é o da barra C6.
 */
export function vimExtension(reporter: ModeReporter): Extension {
  return Prec.highest([vim({ status: false }), vimBridge(reporter), vimTheme]);
}

/** Módulo do plugin interno: o mesmo `activate` (um argumento) dos plugins externos. */
export interface VimPluginModule {
  readonly default: (api: PluginAPI) => () => void;
}

/**
 * Plugin interno "Modo Vim" (I-4, `simplemd.vim`, desligado por padrão). Ligar e desligar trocam
 * só o compartimento de plugins (0 `EditorView` novos, AC-I4.1); ao desligar, o indicador some.
 */
export function createVimPlugin(host: InternalHostContext): VimPluginModule {
  return {
    default(api) {
      defineSilentEx();
      const reporter = createModeReporter({
        status: host.vimStatus,
        announce: (text) => host.editor.announce(text),
      });
      api.registerEditorExtension({ source: vimExtension(reporter) });
      return () => reporter.dispose();
    },
  };
}
