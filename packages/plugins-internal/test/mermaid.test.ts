import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mermaidExtension, mermaidField, MERMAID_DEBOUNCE_MS } from '../src/mermaid/decorate';
import { loadMermaid, mermaidRenderCounts } from '../src/mermaid/render';
import { destroyViews, flatten, mountView, tick } from './helpers';

const FLOW = '```mermaid\nflowchart TD\n  A[Início] --> B{Decisão}\n  B -->|sim| C[Fim]\n```';
const DOC = `# Nota\n\nantes\n\n${FLOW}\n\ndepois\n`;

/** Espera o widget aparecer (render assíncrono fora das transações). */
async function rendered(view: { contentDOM: HTMLElement }, selector = '.cm-mermaid svg') {
  await expect
    .poll(() => view.contentDOM.querySelector(selector), { timeout: 5000 })
    .not.toBeNull();
  return view.contentDOM.querySelector(selector)!;
}

beforeAll(async () => {
  await loadMermaid();
}, 20_000);
afterEach(destroyViews);

describe('Mermaid (AC-7.3, AC-7.4)', () => {
  it('cursor fora → SVG role=img com nome e rótulos dos nós; antes do render, fonte crua', async () => {
    const view = mountView(DOC, mermaidExtension, { anchor: 0, focus: false });
    expect(flatten(view.state.field(mermaidField).decorations)).toEqual([]);
    const svg = await rendered(view);
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Diagrama Mermaid: flowchart TD');
    expect(svg.hasAttribute('aria-labelledby')).toBe(false);
    expect(svg.hasAttribute('aria-describedby')).toBe(false);
    for (const label of ['Início', 'Decisão', 'Fim']) expect(svg.textContent).toContain(label);
    const [deco] = flatten(view.state.field(mermaidField).decorations);
    expect(deco?.block).toBe(true);
    expect(DOC.slice(deco!.from, deco!.to)).toBe(FLOW);
  });

  it('cursor dentro (com foco) → fonte crua, 0 widgets; visitar cada linha não muda o texto', async () => {
    const view = mountView(DOC, mermaidExtension, { anchor: 0, focus: false });
    await rendered(view);
    view.focus();
    view.dispatch({ selection: { anchor: DOC.indexOf('A[Início]') } });
    await expect.poll(() => view.state.field(mermaidField).touched).toEqual([0]);
    expect(flatten(view.state.field(mermaidField).decorations)).toEqual([]);
    for (let n = 1; n <= view.state.doc.lines; n++) {
      view.dispatch({ selection: { anchor: view.state.doc.line(n).from } });
      await tick();
    }
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it('fonte inválida → widget "Diagrama inválido: <mensagem>"; clique revela a fonte', async () => {
    const doc = 'x\n\n```mermaid\nflowchart TD\n  A[ -->\n```\n';
    const view = mountView(doc, mermaidExtension, { anchor: 0, focus: false });
    const error = await rendered(view, '[data-testid="mermaid-error"]');
    expect(error.classList.contains('cm-mermaid-error')).toBe(true);
    expect(error.textContent).toMatch(/^Diagrama inválido: .+/);
    expect(error.getAttribute('aria-hidden')).toBeNull();
    error.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(view.state.selection.main.head).toBe(doc.indexOf('```mermaid'));
  });

  it('XSS: click … call alert e <img onerror> → 0 <script>, 0 on*, 0 javascript:, 0 alert', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const doc =
      '```mermaid\nflowchart TD\n  A["<img src=x onerror=alert(1)>"] --> B[b]\n  click A call alert(1)\n  click B "javascript:alert(1)"\n```\n\nfim\n';
    const view = mountView(doc, mermaidExtension, { anchor: doc.length, focus: false });
    const svg = await rendered(view);
    const all = [svg, ...svg.querySelectorAll('*')];
    expect(svg.querySelectorAll('script')).toHaveLength(0);
    expect(all.flatMap((el) => [...el.attributes].filter((a) => /^on/i.test(a.name)))).toEqual([]);
    expect(
      all.flatMap((el) => [...el.attributes].filter((a) => /javascript:/i.test(a.value))),
    ).toEqual([]);
    for (const el of svg.querySelectorAll('g, rect, text'))
      el.dispatchEvent(new MouseEvent('click'));
    expect(alert).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it('cache: edição fora → 0 renders; edição dentro → 1 render só depois do debounce de 300 ms', async () => {
    const view = mountView(DOC, mermaidExtension, { anchor: 0, focus: false });
    await rendered(view);
    await tick(MERMAID_DEBOUNCE_MS + 50);
    const start = mermaidRenderCounts.mermaid;
    for (const char of 'abc') view.dispatch({ changes: { from: 0, insert: char } });
    await tick(MERMAID_DEBOUNCE_MS + 100);
    expect(mermaidRenderCounts.mermaid).toBe(start);

    const inside = view.state.doc.toString().indexOf('C[Fim]') + 'C[Fim'.length;
    view.dispatch({ changes: { from: inside, insert: '!' } });
    await tick(100);
    expect(mermaidRenderCounts.mermaid).toBe(start);
    await tick(MERMAID_DEBOUNCE_MS + 200);
    expect(mermaidRenderCounts.mermaid).toBe(start + 1);
    await expect
      .poll(() => view.contentDOM.querySelector('.cm-mermaid svg')?.textContent)
      .toContain('Fim!');
  });

  it('tema: trocar as cores renderiza de novo; voltar usa o cache', async () => {
    const root = document.documentElement;
    root.style.setProperty('--color-bg', '#010101');
    const view = mountView(DOC, mermaidExtension, { anchor: 0, focus: false });
    await rendered(view);
    await tick(50);
    const start = mermaidRenderCounts.mermaid;
    root.style.setProperty('--color-bg', '#020202');
    await expect.poll(() => mermaidRenderCounts.mermaid).toBe(start + 1);
    root.style.setProperty('--color-bg', '#010101');
    await tick(100);
    expect(mermaidRenderCounts.mermaid).toBe(start + 1);
    root.style.removeProperty('--color-bg');
  });
});
