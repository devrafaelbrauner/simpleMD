// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { isMac } from '@simplemd/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from '../src/app/App';
import { setup } from './helpers';

afterEach(cleanup);

test('a11y F-2 / EC F-9: o h1 da casca fica dentro do marco <main>', async () => {
  const h = await setup({ 'nota.md': '# Nota\n' });
  render(<App app={h.app} />);
  await act(async () => {});
  const heading = screen.getByRole('heading', { level: 1, name: 'simpleMD' });
  expect(heading.closest('main')).not.toBeNull();
});

test('a11y F-1: o editor da casca é uma parada de Tab (tabindex 0 no conteúdo)', async () => {
  const h = await setup({ 'nota.md': '# Nota\n' });
  const { container } = render(<App app={h.app} />);
  await act(async () => {
    await h.app.sync.openFile('nota.md');
  });
  const content = container.querySelector('.cm-content');
  expect(content?.getAttribute('tabindex')).toBe('0');
  expect(content?.getAttribute('aria-label')).toBe('Editor: nota.md');
});

/** `Mod-N` como o navegador entrega, no `<body>` (foco fora do editor). */
function pressModN(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'n',
    bubbles: true,
    cancelable: true,
    ...(isMac ? { metaKey: true } : { ctrlKey: true }),
  });
  act(() => {
    document.body.dispatchEvent(event);
  });
  return event;
}

test('r9 Mod-N nas boas-vindas: nada abre, o default é impedido', async () => {
  const h = await setup({ 'nota.md': '# Nota\n' }, { open: false });
  render(<App app={h.app} />);
  await act(async () => {});
  expect(pressModN().defaultPrevented).toBe(true);
  expect(h.app.store.getState().newNote).toBeNull();
  expect(screen.queryByTestId('new-note-dialog')).toBeNull();
});

test('r9 Mod-N → "Nova nota" → Enter: nota criada, aba ativa e foco no editor dela', async () => {
  const h = await setup({ 'nota.md': '# Nota\n' });
  const { container } = render(<App app={h.app} />);
  await act(async () => {});
  expect(pressModN().defaultPrevented).toBe(true);
  const name = await screen.findByTestId('new-note-name');
  await vi.waitFor(() => expect(document.activeElement).toBe(name));
  fireEvent.change(name, { target: { value: 'teste' } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('new-note-create'));
  });
  await vi.waitFor(() => expect(h.app.store.getState().activeId).toBe('teste.md'));
  expect(h.port.readText('teste.md')).toBe('');
  expect(screen.queryByTestId('new-note-dialog')).toBeNull();
  await vi.waitFor(() =>
    expect(container.querySelector('.cm-content')?.contains(document.activeElement)).toBe(true),
  );
  expect(container.querySelector('.cm-content')?.getAttribute('aria-label')).toBe(
    'Editor: teste.md',
  );
});
