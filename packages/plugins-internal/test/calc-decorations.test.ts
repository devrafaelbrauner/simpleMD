import { afterEach, describe, expect, it } from 'vitest';
import { CalcWidget, calcExtension, computeCalcDecorations } from '../src/calc/decorate';
import fixture from './fixtures/calc-fixture.md?raw';
import { destroyViews, flatten, mountView, pluginState, tick, viewDecorations } from './helpers';

const all = (doc: string) => [{ from: 0, to: doc.length }];

/** Widgets do calc no documento inteiro: `[token, texto visível, nome acessível]`. */
function chips(doc: string, anchor = 0, focus = false) {
  const state = pluginState(doc, calcExtension, { anchor, focus });
  return flatten(computeCalcDecorations(state, all(doc))).map((d) => {
    const widget = d.widget as CalcWidget;
    return [doc.slice(d.from, d.to), widget.result.text, widget.result.label];
  });
}

afterEach(destroyViews);

describe('calc no editor (AC-7.7, AC-7.8)', () => {
  it('calc-fixture.md: só os tokens válidos fora de código, matemática e front matter', () => {
    expect(chips(fixture)).toEqual([
      ['=2+3', '5', '=2+3 = 5'],
      ['=2*(3+4)', '14', '=2*(3+4) = 14'],
      ['=10/4', '2.5', '=10/4 = 2.5'],
      ['=0.1+0.2', '0.3', '=0.1+0.2 = 0.3'],
      ['=2^10', '1024', '=2^10 = 1024'],
      ['=7%3', '1', '=7%3 = 1'],
      ['=-3+5', '2', '=-3+5 = 2'],
      ['=1/0', 'divisão por zero', '=1/0: divisão por zero'],
      ['=6+1', '7', '=6+1 = 7'],
      ['=8/2', '4', '=8/2 = 4'],
    ]);
  });

  it('cursor no token (com foco) → cru; sem foco nada é revelado', () => {
    const at = fixture.indexOf('=2+3 e produto');
    const touched = chips(fixture, at + 2, true).map(([token]) => token);
    expect(touched).not.toContain('=2+3');
    expect(touched).toContain('=2*(3+4)');
    expect(chips(fixture, at + 2, false).map(([token]) => token)).toContain('=2+3');
  });

  it('widget: chip com role=img e nome "=2+3 = 5"; erro com ⚠ e texto "divisão por zero"', () => {
    const view = mountView('Total =2+3 e =1/0\n', calcExtension, { anchor: 0, focus: false });
    const ok = view.contentDOM.querySelector('.cm-calc-result');
    expect(ok?.getAttribute('role')).toBe('img');
    expect(ok?.getAttribute('aria-label')).toBe('=2+3 = 5');
    expect(ok?.textContent).toBe('5');
    const error = view.contentDOM.querySelector('.cm-calc-error');
    expect(error?.getAttribute('aria-label')).toBe('=1/0: divisão por zero');
    expect(error?.textContent).toBe('divisão por zero');
    expect(error?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  it('visitar cada linha com o cursor nunca muda o texto (regra 1)', async () => {
    const view = mountView(fixture, calcExtension, { anchor: 0, focus: true });
    for (let n = 1; n <= view.state.doc.lines; n++) {
      view.dispatch({ selection: { anchor: view.state.doc.line(n).from } });
      await tick();
    }
    expect(view.state.doc.toString()).toBe(fixture);
  });

  it('o ViewPlugin decora só as faixas visíveis (R-7.8)', () => {
    const view = mountView(fixture, calcExtension, { anchor: 0, focus: false });
    const calc = viewDecorations(view).filter((d) => d.widget instanceof CalcWidget);
    for (const deco of calc) {
      expect(view.visibleRanges.some((r) => r.from <= deco.from && r.to >= deco.to)).toBe(true);
    }
    expect(calc.length).toBeGreaterThan(0);
  });

  it('clique no chip revela o token (cursor no início)', () => {
    const doc = 'Total =2+3\n';
    const view = mountView(doc, calcExtension, { anchor: 0, focus: false });
    const chip = view.contentDOM.querySelector('.cm-calc-result')!;
    chip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(view.state.selection.main.head).toBe(doc.indexOf('='));
  });
});
