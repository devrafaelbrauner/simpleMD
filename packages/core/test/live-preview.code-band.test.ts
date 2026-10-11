// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMarkdownState, setEditorFocus } from '../src';
import { BAND_LINE_CLASSES, codeBandMarkers } from '../src/live-preview/code-band';
import { mountedCssRules, ruleBody } from './helpers/css';
import { fullyParsed } from './helpers/live-preview';

/**
 * r7 QA (UIF-02, UIF-03, UIF-01 faixa, F-A11Y-R7-02): fundo de bloco numa camada abaixo da seleção,
 * token de URL com classe estável, faixa dos painéis e anel do `<summary>`. Geometria real e pixels
 * ficam no Playwright do QA; aqui, o contrato sem layout. Glossário (EN): faixa = band; camada =
 * layer; seleção = selection; linha de bloco = code-bg line.
 */
const DOC =
  'Texto\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\nMeio\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n<https://exemplo.org/auto>\n';

const views: EditorView[] = [];
function mount(doc = DOC): EditorView {
  const parent = document.body.appendChild(document.createElement('div'));
  const view = new EditorView({ state: createMarkdownState(doc), parent });
  views.push(view);
  return fullyParsed(view);
}

afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('fundo de bloco abaixo da seleção (UIF-02)', () => {
  it('um retângulo por sequência de linhas de bloco: topo da primeira, base da última', () => {
    const view = mount();
    // Cursor na tabela: a fonte crua aparece com `cm-md-table-src` (TBL-TAB-ON).
    const inTable = view.state.doc.toString().indexOf('| 1 |') + 2;
    view.dispatch({ selection: { anchor: inTable }, effects: setEditorFocus.of(true) });
    const lines = [...view.contentDOM.children];
    const bandRuns = lines.map((l) => BAND_LINE_CLASSES.some((c) => l.classList.contains(c)));
    // 4 linhas do bloco cercado (cercas inclusive) e 3 da tabela revelada, em duas sequências.
    expect(bandRuns.filter(Boolean).length).toBe(7);
    const scroll = view.scrollDOM;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const i = lines.indexOf(this);
      const top = this === scroll ? 50 : 100 + 20 * i;
      const h = this === scroll ? 500 : 20;
      return {
        left: 10,
        right: 310,
        top,
        bottom: top + h,
        width: 300,
        height: h,
        x: 10,
        y: top,
      } as DOMRect;
    });
    const markers = codeBandMarkers(view);
    const runs: [number, number][] = [];
    for (let i = 0; i < bandRuns.length; i++) {
      if (!bandRuns[i]) continue;
      let j = i;
      while (bandRuns[j + 1]) j++;
      runs.push([i, j]);
      i = j;
    }
    expect(runs.length).toBe(2);
    expect(markers.map((m) => [m.left, m.top, m.width, m.height])).toEqual(
      runs.map(([a, b]) => [0, 100 + 20 * a - 50, 300, 20 * (b - a + 1)]),
    );
  });

  it('a camada do fundo fica abaixo da camada de seleção (z-index menor)', () => {
    const view = mount();
    const band = view.dom.querySelector<HTMLElement>('.cm-md-band-layer');
    const selection = view.dom.querySelector<HTMLElement>('.cm-selectionLayer');
    expect(band).not.toBeNull();
    expect(Number(band!.style.zIndex)).toBeLessThan(Number(selection!.style.zIndex));
  });

  it('as linhas de bloco não pintam fundo; a camada pinta `code-bg`', () => {
    mount();
    const rules = mountedCssRules();
    expect(ruleBody(rules, '.cm-md-band-layer .cm-md-band')).toBe(
      'background-color: var(--color-code-bg);',
    );
    const lineBackgrounds = rules.filter(
      (r) =>
        /\.cm-md-(codeblock|table-src|frontmatter)\b/.test(r.selector) && /background/.test(r.body),
    );
    expect(lineBackgrounds).toEqual([]);
  });
});

describe('autolink e URL GFM no `accent` (UIF-03)', () => {
  it('fora do cursor o token de URL fica dentro do link e herda a cor dele', () => {
    const view = mount();
    const url = view.contentDOM.querySelector('.cm-md-link .cm-md-url');
    expect(url?.textContent).toBe('https://exemplo.org/auto');
    const rules = mountedCssRules();
    expect(ruleBody(rules, '.cm-md-link .cm-md-url')).toBe('color: inherit;');
    expect(ruleBody(rules, '.cm-md-url')).toBe('color: var(--color-muted);');
  });

  it('com o cursor no autolink a fonte revelada mantém o URL atenuado, fora de qualquer link', () => {
    const view = mount();
    const at = view.state.doc.toString().indexOf('exemplo.org/auto');
    view.dispatch({ selection: { anchor: at }, effects: setEditorFocus.of(true) });
    const url = view.contentDOM.querySelector('.cm-md-url');
    expect(url?.textContent).toBe('https://exemplo.org/auto');
    expect(url?.closest('.cm-md-link')).toBeNull();
  });
});

describe('faixa dos painéis e anel do `<summary>` (UIF-01, F-A11Y-R7-02)', () => {
  it('a faixa `.cm-panels` usa `sidebar-bg`/`fg` e filete, nunca o cinza padrão do CM', () => {
    mount();
    const rules = mountedCssRules();
    expect(ruleBody(rules, '.cm-editor > .cm-panels')).toBe(
      'background-color: var(--color-sidebar-bg); color: var(--color-fg);',
    );
    expect(ruleBody(rules, '.cm-editor > .cm-panels-bottom')).toBe(
      'border-top: 1px solid color-mix(in srgb, var(--color-border) 45%, var(--color-bg));',
    );
  });

  it('o anel do W4 vale também em `:focus` (foco por ⌘⇧↩, sem `:focus-visible` no Chromium)', () => {
    mount();
    const rules = mountedCssRules();
    const ring = rules.find((r) => r.selector.includes('.cm-md-html summary:focus,'));
    expect(ring?.selector).toContain('.cm-md-html .cm-md-link:focus');
    expect(ring?.body).toBe(
      'outline: var(--dimension-focus-ring) solid var(--color-accent); outline-offset: calc(-1 * var(--dimension-focus-ring));',
    );
  });
});
