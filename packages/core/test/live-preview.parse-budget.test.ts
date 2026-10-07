// @vitest-environment jsdom
import { syntaxTree } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMarkdownState } from '../src';
import fixture from './fixtures/live-preview.md?raw';
import { fullyParsed } from './helpers/live-preview';

const views: EditorView[] = [];

afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/**
 * Máquina lenta (TA-R2-1, F-4): cada leitura do relógio avança 50 ms, então o orçamento do parse
 * inicial do CodeMirror (~20 ms) acaba depois do primeiro bloco, como numa suíte sob carga.
 */
function mountStarved(doc: string): EditorView {
  let now = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 50));
  const parent = document.body.appendChild(document.createElement('div'));
  const view = new EditorView({ state: createMarkdownState(doc), parent });
  clock.mockRestore();
  views.push(view);
  return view;
}

describe('live preview com o orçamento do parse inicial esgotado', () => {
  it('a montagem publica uma árvore parcial: a tabela e o link ainda não estão decorados', () => {
    const view = mountStarved(fixture);
    expect(syntaxTree(view.state).length).toBeLessThan(view.state.doc.length);
    expect(view.contentDOM.querySelector('table.cm-md-table')).toBeNull();
    expect(view.contentDOM.querySelector('.cm-md-link')).toBeNull();
  });

  it('quando a árvore completa chega, a tabela e o link aparecem sem nova edição', () => {
    const view = fullyParsed(mountStarved(fixture));
    expect(syntaxTree(view.state).length).toBe(view.state.doc.length);
    expect(view.contentDOM.querySelector('table.cm-md-table')).not.toBeNull();
    const link = view.contentDOM.querySelector('.cm-md-link');
    expect(link?.tagName).toBe('SPAN');
    expect(link?.textContent).toBe('site do CodeMirror');
    expect(view.state.doc.toString()).toBe(fixture);
  });
});
