import { Prec, type Extension } from '@codemirror/state';
import { ViewPlugin } from '@codemirror/view';
import { getCM, Vim, vim } from '@replit/codemirror-vim';
import type { PluginAPI } from '@simplemd/plugin-api';
import type { InternalHostContext } from '@simplemd/plugin-api/internal/host';
import {
  createModeReporter,
  modeFromEvent,
  modeFromState,
  type ModeReporter,
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
 * traduz o painel W6 (D-R7-S4-01) e leva o modo ao indicador da barra de status (DA-R7-16).
 */
function vimBridge(reporter: ModeReporter): Extension {
  return ViewPlugin.define((view) => {
    const cm = getCM(view);
    if (!cm) return {};
    localizeDialogs(cm as unknown as VimDialogHost);
    const onModeChange = (event: VimModeChange) => {
      const mode = modeFromEvent(event);
      if (mode) reporter.report(mode);
    };
    cm.on('vim-mode-change', onModeChange);
    reporter.report(modeFromState(cm.state.vim, Boolean(cm.state.overwrite)));
    return { destroy: () => cm.off('vim-mode-change', onModeChange) };
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
