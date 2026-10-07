import { afterEach, describe, expect, it } from 'vitest';
import {
  blockMathField,
  computeInlineMath,
  katexExtension,
  MathErrorDescription,
  MathWidget,
} from '../src/katex/decorate';
import { katexRenderCounts, katexRequested, loadKatex } from '../src/katex/render';
import { blockMathIn, excludedSpans, inlineMathIn } from '../src/shared/scan';
import { destroyViews, flatten, mountView, pluginState, tick } from './helpers';

const all = (doc: string) => [{ from: 0, to: doc.length }];

/** Fórmulas em linha reconhecidas (texto entre os `$`). */
function inlineTex(doc: string): string[] {
  const state = pluginState(doc, katexExtension, { anchor: 0, focus: false });
  const blocked = [...excludedSpans(state, 0, doc.length), ...blockMathIn(state, 0, doc.length)];
  blocked.sort((a, b) => a.from - b.from);
  return inlineMathIn(state, 0, doc.length, blocked).map((m) => m.tex);
}

afterEach(destroyViews);

describe('KaTeX: regras do Pandoc (AC-7.5)', () => {
  it('antes da carga: fonte crua, nenhuma decoração e a biblioteca é pedida só com fórmula', () => {
    const plain = pluginState('Sem fórmulas aqui.\n', katexExtension);
    expect(computeInlineMath(plain, all('Sem fórmulas aqui.\n')).missing).toBe(false);
    expect(katexRequested()).toBe(false);
    const doc = 'Área $x^2$.\n';
    const result = computeInlineMath(pluginState(doc, katexExtension, { focus: false }), all(doc));
    expect(result.missing).toBe(true);
    expect(flatten(result.decorations)).toEqual([]);
  });

  it('reconhece $x^2$ e $\\frac{1}{$; recusa \\$5, $ 5 e $ 6, `$x$`, $20 e $30', () => {
    expect(inlineTex('Área $x^2$ e erro $\\frac{1}{$ fim')).toEqual(['x^2', '\\frac{1}{']);
    expect(inlineTex('Preço \\$5 e \\$6')).toEqual([]);
    expect(inlineTex('Valores $ 5 e $ 6')).toEqual([]);
    expect(inlineTex('Código `$x$` aqui')).toEqual([]);
    expect(inlineTex('Custa $20 e $30 hoje')).toEqual([]);
    // `$` seguido de dígito não fecha: a busca continua até um fechamento válido.
    expect(inlineTex('Fecha antes de dígito $a$1 não, $b$ sim')).toEqual(['a$1 não, $b']);
  });

  it('nada de matemática em código cercado, código indentado ou front matter', () => {
    const doc = '---\nt: $x$\n---\n\n```\n$y$\n```\n\n    $z$\n\nfora $w$\n';
    expect(inlineTex(doc)).toEqual(['w']);
  });

  it('bloco $$ em linhas próprias; $$ no meio de parágrafo não é bloco', () => {
    const doc = 'a\n\n$$\nx^2\n$$\n\nb $$ c\n';
    const state = pluginState(doc, katexExtension);
    expect(blockMathIn(state, 0, doc.length).map((b) => [b.tex, doc.slice(b.from, b.to)])).toEqual([
      ['x^2', '$$\nx^2\n$$'],
    ]);
  });

  it('com a biblioteca: .katex com MathML; erro com sublinhado, title e descrição oculta', async () => {
    await loadKatex();
    const doc = 'Área $x^2$ e $\\frac{1}{$ e $\\href{javascript:alert(1)}{x}$\n';
    const state = pluginState(doc, katexExtension, { anchor: 0, focus: false });
    const decos = flatten(computeInlineMath(state, all(doc)).decorations);
    const widgets = decos.filter((d) => d.widget instanceof MathWidget);
    expect(widgets.map((d) => doc.slice(d.from, d.to))).toEqual([
      '$x^2$',
      '$\\href{javascript:alert(1)}{x}$',
    ]);
    const host = document.createElement('div');
    host.innerHTML = (widgets[0]!.widget as MathWidget).html;
    expect(host.querySelector('.katex math')).not.toBeNull();
    host.innerHTML = (widgets[1]!.widget as MathWidget).html;
    expect(host.querySelector('a')).toBeNull();
    const error = decos.find((d) => d.class === 'cm-math-error');
    expect(doc.slice(error!.from, error!.to)).toBe('$\\frac{1}{$');
    expect(error!.title).toMatch(/^Fórmula inválida: .+/);
    const description = decos.find((d) => d.widget instanceof MathErrorDescription);
    expect(description?.from).toBe(error!.to);
    expect((description!.widget as MathErrorDescription).text).toBe(error!.title);
  });

  it('cursor na fórmula (com foco) → cru, nó a nó', async () => {
    await loadKatex();
    const doc = 'A $a$ e B $b$\n';
    const state = pluginState(doc, katexExtension, { anchor: doc.indexOf('$a$') + 1 });
    const decos = flatten(computeInlineMath(state, all(doc)).decorations);
    expect(decos.map((d) => doc.slice(d.from, d.to))).toEqual(['$b$']);
  });

  it('bloco $$: widget só depois do render no cache; cursor dentro → cru; erro marcado', async () => {
    await loadKatex();
    const doc = 'texto\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nfim\n';
    const view = mountView(doc, katexExtension, { anchor: 0, focus: false });
    await tick(10);
    const block = view.contentDOM.querySelector('.cm-math-block');
    expect(block?.querySelector('.katex-display math')).not.toBeNull();
    view.dispatch({ selection: { anchor: doc.indexOf('\\int') } });
    view.focus();
    view.dispatch({ effects: [] });
    await tick();
    const field = view.state.field(blockMathField);
    expect(field.touched).toEqual([0]);
    expect(flatten(field.decorations)).toEqual([]);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('edição fora da fórmula não renderiza de novo (espião do NFR-21)', async () => {
    await loadKatex();
    const doc = 'Área $x^3$ aqui\n\nprosa\n';
    const view = mountView(doc, katexExtension, { anchor: 0, focus: false });
    await tick();
    const before = katexRenderCounts.katex;
    for (const char of 'abc') {
      view.dispatch({ changes: { from: view.state.doc.length, insert: char } });
    }
    expect(katexRenderCounts.katex).toBe(before);
  });
});
