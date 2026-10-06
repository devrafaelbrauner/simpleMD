// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { EditorView } from '@codemirror/view';
import { act, render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { App } from '../src/app/App';
import { setup } from './helpers';

test('CR-04 (R5): cursor movido sem digitar sobrevive à troca de aba (arch-frontend F-3)', async () => {
  const h = await setup({ 'a.md': '0123456789\n', 'b.md': 'bbbb\n' });
  render(<App app={h.app} />);
  await act(async () => {
    await h.app.sync.openFile('a.md');
  });
  const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
  expect(view.state.doc.toString()).toBe('0123456789\n');
  act(() => view.dispatch({ selection: { anchor: 7 } })); // arrow keys / click, no edit
  await act(async () => {
    await h.app.sync.openFile('b.md');
  });
  expect(view.state.doc.toString()).toBe('bbbb\n');
  act(() => h.app.store.getState().activate('a.md'));

  expect(view.state.selection.main.head).toBe(7);
});

test('CR-04 controle: depois de uma edição o cursor também volta', async () => {
  const h = await setup({ 'a.md': '0123456789\n', 'b.md': 'bbbb\n' });
  render(<App app={h.app} />);
  await act(async () => {
    await h.app.sync.openFile('a.md');
  });
  const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
  act(() => view.dispatch({ changes: { from: 7, insert: 'X' }, selection: { anchor: 8 } }));
  await act(async () => {
    await h.app.sync.openFile('b.md');
  });
  act(() => h.app.store.getState().activate('a.md'));

  expect(view.state.selection.main.head).toBe(8);
});
