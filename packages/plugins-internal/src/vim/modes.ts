import type { VimStatus } from '@simplemd/plugin-api/internal/host';

/** Modo do indicador (R-I4.3): os 6 da barra de status. */
export type VimMode = VimStatus['mode'];

/** Evento `vim-mode-change` do `@replit/codemirror-vim-core` 0.1.0. */
export interface VimModeChange {
  readonly mode?: string;
  readonly subMode?: string;
}

/** Estado do Vim no adaptador (`cm.state.vim`), só o que o indicador lê. */
export interface VimStateLike {
  readonly insertMode?: boolean;
  readonly visualMode?: boolean;
  readonly visualLine?: boolean;
  readonly visualBlock?: boolean;
}

/** Evento da biblioteca → modo do indicador (`null` = evento sem modo conhecido). */
export function modeFromEvent(event: VimModeChange): VimMode | null {
  switch (event.mode) {
    case 'normal':
    case 'insert':
    case 'replace':
      return event.mode;
    case 'visual':
      return event.subMode === 'linewise'
        ? 'visual-line'
        : event.subMode === 'blockwise'
          ? 'visual-block'
          : 'visual';
    default:
      return null;
  }
}

/** Modo atual lido do estado (plugin recriado numa troca de aba, ou ligado agora). */
export function modeFromState(vim: VimStateLike | null | undefined, overwrite: boolean): VimMode {
  if (!vim) return 'normal';
  if (vim.insertMode) return overwrite ? 'replace' : 'insert';
  if (vim.visualMode)
    return vim.visualLine ? 'visual-line' : vim.visualBlock ? 'visual-block' : 'visual';
  return 'normal';
}

/** Nome falado do modo (STR-160, minúsculas para o leitor não soletrar; CF-R7-1). */
const SPOKEN: Readonly<Record<VimMode, string>> = {
  normal: 'normal',
  insert: 'inserção',
  visual: 'visual',
  'visual-line': 'visual linha',
  'visual-block': 'visual bloco',
  replace: 'substituir',
};

/** Anúncio da mudança de modo (STR-160): "Modo Vim: <modo em minúsculas>". */
export function modeAnnouncement(mode: VimMode): string {
  return `Modo Vim: ${SPOKEN[mode]}`;
}

/** Espera do anúncio depois da última mudança (arch-ux §7.2: só a última). */
export const MODE_ANNOUNCE_DELAY_MS = 300;

export interface ModeReporter {
  /** Modo novo (evento ou plugin recriado): indicador na hora, anúncio depois da espera. */
  report(mode: VimMode): void;
  /** Cancela o anúncio pendente e limpa o indicador (plugin desligado); depois, `report` é ignorado. */
  dispose(): void;
}

/**
 * Indicador e anúncio do modo (DA-R7-16, D-R7-S4-02): o indicador muda a cada modo; o anúncio sai
 * 300 ms depois da última mudança, só se o modo final for diferente do último anunciado (nunca ao
 * ligar: a base é "normal", o modo em que o Vim começa).
 */
export function createModeReporter(deps: {
  readonly status?: { set(value: VimStatus): void; clear(): void } | undefined;
  readonly announce: (text: string) => void;
}): ModeReporter {
  let shown: VimMode | null = null;
  let announced: VimMode = 'normal';
  let timer: number | undefined;
  let disposed = false;
  return {
    report(mode) {
      // O descarte do plugin pode vir antes da reconfiguração que tira a extensão do editor.
      if (disposed) return;
      if (mode !== shown) {
        shown = mode;
        deps.status?.set({ mode });
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        if (shown === null || shown === announced) return;
        announced = shown;
        deps.announce(modeAnnouncement(shown));
      }, MODE_ANNOUNCE_DELAY_MS);
    },
    dispose() {
      disposed = true;
      window.clearTimeout(timer);
      timer = undefined;
      deps.status?.clear();
    },
  };
}
