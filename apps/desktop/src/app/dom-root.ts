import { applyTheme, withThemeWindow } from '@simplemd/themes';
import type { RootTarget } from '../state/settings';

/**
 * O `<html>` do documento como alvo do tema (arch-frontend §7.1): os portais do Radix ficam em
 * `<body>`, então diálogos e a prévia do editor de temas herdam os tokens e `data-ligatures`.
 */
export function createDomRoot(): RootTarget {
  let keys = new Set<string>();
  return {
    applyTheme(tokens, base, mark) {
      keys = applyTheme(document.documentElement, tokens, keys, { base, mark });
    },
    setLigatures(on) {
      const html = document.documentElement;
      withThemeWindow(
        html,
        () => {
          html.dataset.ligatures = on ? 'on' : 'off';
        },
        { mark: 'simplemd:font-applied' },
      );
    },
    async loadFont(family, sizePx) {
      await document.fonts.load(`${sizePx}px "${family}"`);
    },
  };
}
