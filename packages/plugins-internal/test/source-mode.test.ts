import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  createMarkdownExtensions,
  createMarkdownState,
  EDITOR_MODE_ATTRIBUTE,
  isLivePreview,
  setLivePreview,
} from '@simplemd/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { calcExtension } from '../src/calc/decorate';
import { katexExtension } from '../src/katex/decorate';
import { loadKatex } from '../src/katex/render';
import { isTouched, sourceMode } from '../src/shared/reveal';
import { QueryController, queryWidgetExtension } from '../src/tasks/widget';
import { tick } from './helpers';
import { fakeCatalog, indexNote } from './tasks-fixture';

/**
 * r27a (D-R27-01/D-R27-05, AC-R27A-2): no modo fonte do núcleo (`data-smd-mode="source"` em
 * `.cm-editor`) os plugins internos mostram a fonte — calc, KaTeX, Mermaid e consultas — e
 * Mermaid/KaTeX nem carregam; ao voltar à prévia, a renderização volta. A API v1 não muda: o plugin
 * lê o atributo pelos módulos do host.
 */
const views: EditorView[] = [];

afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.innerHTML = '';
});

/** Editor do app (núcleo + plugin) com a árvore completa, sem foco, no modo pedido. */
function mount(doc: string, extension: Extension, live = true): EditorView {
  const base = EditorState.create({
    doc,
    extensions: [createMarkdownExtensions({ livePreview: live }), extension],
  });
  if (!ensureSyntaxTree(base, base.doc.length, 5000)) throw new Error('parse incompleto');
  const parent = document.body.appendChild(document.createElement('div'));
  const view = new EditorView({ state: base.update({ selection: { anchor: 0 } }).state, parent });
  views.push(view);
  return view;
}

const found = (view: EditorView, selector: string) =>
  view.contentDOM.querySelectorAll(selector).length;

describe('r27a: plugins internos no modo fonte', () => {
  it('Mermaid e KaTeX não carregam no modo fonte; ligar a prévia carrega e renderiza; desligar mostra a fonte', async () => {
    // Módulos novos: o "já pedi a biblioteca" é estado do módulo (independe da ordem, TA-R2-1).
    vi.resetModules();
    const mermaid = await import('../src/mermaid/decorate');
    const mermaidRender = await import('../src/mermaid/render');
    const katex = await import('../src/katex/decorate');
    const katexRender = await import('../src/katex/render');
    const doc =
      '# Nota\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nÁrea $x^2$.\n\n$$\n\\int_0^1 x\\,dx\n$$\n';
    const view = mount(doc, [mermaid.mermaidExtension, katex.katexExtension], false);
    await tick(400);
    expect(mermaidRender.mermaidRequested()).toBe(false);
    expect(katexRender.katexRequested()).toBe(false);
    expect(found(view, '.cm-mermaid, .cm-math, .cm-math-block')).toBe(0);
    expect(view.contentDOM.textContent).toContain('flowchart TD');

    view.dispatch({ effects: setLivePreview(true) });
    await expect
      .poll(() => view.contentDOM.querySelector('.cm-mermaid svg'), { timeout: 15_000 })
      .not.toBeNull();
    await expect.poll(() => found(view, '.cm-math') + found(view, '.cm-math-block')).toBe(2);
    expect(mermaidRender.mermaidRequested()).toBe(true);
    expect(katexRender.katexRequested()).toBe(true);

    view.dispatch({ effects: setLivePreview(false) });
    expect(found(view, '.cm-mermaid, .cm-math, .cm-math-block')).toBe(0);
    expect(view.contentDOM.textContent).toContain('$x^2$');
    expect(view.state.doc.toString()).toBe(doc);
  }, 30_000);

  it('contrato do atributo: `sourceMode` do plugin = modo do núcleo; no modo fonte tudo está tocado', () => {
    expect(EDITOR_MODE_ATTRIBUTE).toBe('data-smd-mode');
    const live = createMarkdownState('x');
    const source = createMarkdownState('x', { livePreview: false });
    const toggled = live.update({ effects: setLivePreview(false) }).state;
    for (const state of [live, source, toggled])
      expect(sourceMode(state)).toBe(!isLivePreview(state));
    expect([sourceMode(live), sourceMode(source), sourceMode(toggled)]).toEqual([
      false,
      true,
      true,
    ]);
    // Outro host (sem o atributo): prévia, como antes do r27.
    expect(sourceMode(EditorState.create({ doc: 'x' }))).toBe(false);
    expect(isTouched(source, 0, 0)).toBe(true);
    expect(isTouched(live, 0, 0)).toBe(false);
  });

  it('calc: o resultado vira fonte no modo fonte e volta na prévia', () => {
    const view = mount('Soma =2+3 e produto =2*(3+4)\n', calcExtension);
    expect(found(view, '.cm-calc-result')).toBe(2);
    view.dispatch({ effects: setLivePreview(false) });
    expect(found(view, '.cm-calc-result')).toBe(0);
    expect(view.contentDOM.textContent).toContain('=2+3');
    view.dispatch({ effects: setLivePreview(true) });
    expect(found(view, '.cm-calc-result')).toBe(2);
  });

  it('KaTeX em linha e em bloco: fonte no modo fonte, fórmula na prévia', async () => {
    await loadKatex();
    const view = mount('Área $x^2$ aqui.\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nfim\n', katexExtension);
    await expect.poll(() => found(view, '.cm-math') + found(view, '.cm-math-block')).toBe(2);
    view.dispatch({ effects: setLivePreview(false) });
    expect(found(view, '.cm-math, .cm-math-block')).toBe(0);
    expect(view.contentDOM.textContent).toContain('\\int_0^1');
    view.dispatch({ effects: setLivePreview(true) });
    await expect.poll(() => found(view, '.cm-math') + found(view, '.cm-math-block')).toBe(2);
  });

  it('consultas: sem widget no modo fonte ("Interagir" não entra); a prévia devolve o widget', () => {
    const doc = 'Antes\n\n```tasks\nnot done\n```\n\nDepois\n';
    const controller = new QueryController({
      catalog: fakeCatalog([indexNote('lista.md', '- [ ] comprar pão\n')]),
      host: {
        platform: 'mac',
        options: { get: (() => true) as never, subscribe: () => () => {} },
        editor: { announce: vi.fn() } as never,
      },
      notePathOf: () => 'consulta.md',
      now: () => new Date(2026, 9, 10, 9),
    });
    const { extension } = queryWidgetExtension(controller);
    const view = mount(doc, extension);
    expect(found(view, '[data-testid="query-widget"]')).toBe(1);
    view.dispatch({ effects: setLivePreview(false) });
    expect(found(view, '[data-testid="query-widget"]')).toBe(0);
    expect(view.contentDOM.textContent).toContain('not done');
    expect(controller.interact(view, doc.indexOf('not done'))).toBe(false);
    view.dispatch({ effects: setLivePreview(true) });
    expect(found(view, '[data-testid="query-widget"]')).toBe(1);
    controller.dispose();
  });
});
