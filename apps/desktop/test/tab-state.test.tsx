// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { EditorView } from '@codemirror/view';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { App } from '../src/app/App';
import { setup } from './helpers';

// O projeto desktop não usa `globals: true`, então o RTL não registra a limpeza sozinho: sem isto, a
// árvore de um teste ficava no documento e o seguinte achava o editor errado (TA-1).
afterEach(cleanup);

/** O editor DESTA renderização (nunca o primeiro `.cm-editor` do documento). */
function editorIn(container: HTMLElement): EditorView {
  const dom = container.querySelector<HTMLElement>('.cm-editor');
  if (!dom) throw new Error('editor não montado');
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error('EditorView não encontrado');
  return view;
}

test('CR-04 (R5): cursor movido sem digitar sobrevive à troca de aba (arch-frontend F-3)', async () => {
  const h = await setup({ 'a.md': '0123456789\n', 'b.md': 'bbbb\n' });
  const { container } = render(<App app={h.app} />);
  await act(async () => {
    await h.app.sync.openFile('a.md');
  });
  const view = editorIn(container);
  expect(view.state.doc.toString()).toBe('0123456789\n');
  act(() => view.dispatch({ selection: { anchor: 7 } })); // arrow keys / click, no edit
  await act(async () => {
    await h.app.sync.openFile('b.md');
  });
  expect(view.state.doc.toString()).toBe('bbbb\n');
  act(() => h.app.store.getState().activate('a.md'));

  expect(view.state.doc.toString()).toBe('0123456789\n');
  expect(view.state.selection.main.head).toBe(7);
});

test('CR-04 controle: depois de uma edição o cursor também volta', async () => {
  const h = await setup({ 'a.md': '0123456789\n', 'b.md': 'bbbb\n' });
  const { container } = render(<App app={h.app} />);
  await act(async () => {
    await h.app.sync.openFile('a.md');
  });
  const view = editorIn(container);
  // Este teste começa com um documento limpo e só um editor montado (TA-1: antes ele editava o
  // editor deixado pelo teste anterior, que nunca trocava de aba).
  expect(document.querySelectorAll('.cm-editor')).toHaveLength(1);
  expect(view.state.doc.toString()).toBe('0123456789\n');
  act(() => view.dispatch({ changes: { from: 7, insert: 'X' }, selection: { anchor: 8 } }));
  await act(async () => {
    await h.app.sync.openFile('b.md');
  });
  expect(view.state.doc.toString()).toBe('bbbb\n');
  act(() => h.app.store.getState().activate('a.md'));

  expect(view.state.doc.toString()).toBe('0123456X789\n');
  expect(view.state.selection.main.head).toBe(8);
});
