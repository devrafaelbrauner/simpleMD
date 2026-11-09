import { applyTheme, withThemeWindow } from '@simplemd/themes';
import type { RootTarget } from '../state/settings';

/**
 * O `<html>` do documento como alvo do tema (arch-frontend §7.1): os portais do Radix ficam em
 * `<body>`, então diálogos e a prévia do editor de temas herdam os tokens e `data-ligatures`. O
 * claro/escuro do SO vem de `prefers-color-scheme` (tema "Sistema", r28): WKWebView e WebView2
 * seguem a aparência do sistema e disparam `change` quando ela muda.
 */
export function createDomRoot(): RootTarget {
  let keys = new Set<string>();
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
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
    prefersDark() {
      return dark.matches;
    },
    onColorSchemeChange(listener) {
      dark.addEventListener('change', listener);
      return () => dark.removeEventListener('change', listener);
    },
  };
}
