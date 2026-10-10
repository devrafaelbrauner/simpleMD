// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { loadTableEngine } from '@simplemd/core';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { App } from '../src/app/App';
import { setup } from './helpers';

/**
 * r7 S3 — AC-I3.6 (parte VT): a paleta lista os 22 "Tabela: …" com os atalhos (`aria-keyshortcuts`
 * + chip); AC-I3.3 pela paleta do app: fora de tabela o aviso N1 warn STR-155, 0 mudanças; dentro,
 * o comando muda a nota aberta (que o autosave grava, AC-I3.7 = MAC).
 */
beforeAll(async () => {
  await loadTableEngine();
});
afterEach(cleanup);

const NOTE = '# Nota\n\nTexto.\n\n|Ação|Preço|\n|-|-|\n|Café|5|\n';

async function openNote() {
  const h = await setup({ 'nota.md': NOTE });
  render(<App app={h.app} />);
  await act(async () => {
    await h.app.sync.openFile('nota.md');
  });
  const view = h.app.plugins.editor.view;
  if (!view) throw new Error('editor não montado');
  return { h, view };
}

test('a paleta lista os 22 comandos "Tabela: …", em ordem, com os atalhos da arch-ux §3.7', async () => {
  const { h } = await openNote();
  act(() => h.app.store.setState({ paletteOpen: true, palettePrefill: '' }));
  const options = [
    ...document.querySelectorAll<HTMLElement>('[role="option"][data-command-id^="table:"]'),
  ];
  expect(options.map((o) => o.dataset.commandId)).toEqual([
    'table:format',
    'table:format-all',
    'table:next-cell',
    'table:prev-cell',
    'table:next-row',
    'table:insert-row-above',
    'table:insert-row-below',
    'table:delete-row',
    'table:insert-col-left',
    'table:insert-col-right',
    'table:delete-col',
    'table:move-row-up',
    'table:move-row-down',
    'table:move-col-left',
    'table:move-col-right',
    'table:align-left',
    'table:align-center',
    'table:align-right',
    'table:align-none',
    'table:sort-asc',
    'table:sort-desc',
    'table:transpose',
  ]);
  const keys = Object.fromEntries(
    options.map((o) => [o.dataset.commandId, o.getAttribute('aria-keyshortcuts')]),
  );
  // jsdom não é macOS: Mod = Control; chip "Ctrl+Shift+F", "Ctrl+Alt+→".
  expect(keys['table:format']).toBe('Control+Shift+F');
  expect(keys['table:next-cell']).toBe('Control+Alt+ArrowRight');
  expect(keys['table:prev-cell']).toBe('Control+Alt+ArrowLeft');
  expect(keys['table:next-row']).toBe('Enter');
  expect(keys['table:transpose']).toBeNull();
  const format = options[0];
  expect(format?.textContent).toContain('Tabela: Formatar tabela');
  expect(format?.querySelector('kbd')?.textContent).toBe('Ctrl+Shift+F');
  expect(options[2]?.querySelector('kbd')?.textContent).toBe('Ctrl+Alt+→');
  // Comandos de tabela ficam habilitados fora de tabela (UX-R7-D23).
  expect(options.every((o) => o.getAttribute('aria-disabled') !== 'true')).toBe(true);
  expect(screen.getAllByRole('option').length).toBeGreaterThan(22);
});

test('fora de tabela: aviso warn "Coloque o cursor numa tabela" e 0 mudanças; dentro: formata', async () => {
  const { h, view } = await openNote();
  act(() => view.dispatch({ selection: { anchor: NOTE.indexOf('Texto') } }));
  await act(async () => {
    await h.app.plugins.commands.get('table:format')?.run();
  });
  const notice = h.app.store.getState().notices.at(-1);
  expect(notice).toMatchObject({
    kind: 'info',
    level: 'warn',
    notice: 'table',
    text: 'Coloque o cursor numa tabela',
  });
  expect(view.state.doc.toString()).toBe(NOTE);

  act(() => view.dispatch({ selection: { anchor: NOTE.indexOf('Café') } }));
  await act(async () => {
    await h.app.plugins.commands.get('table:format')?.run();
  });
  expect(view.state.doc.toString()).toBe(
    '# Nota\n\nTexto.\n\n| Ação | Preço |\n| ---- | ----- |\n| Café | 5     |\n',
  );
  expect(h.app.store.getState().notices.filter((n) => n.notice === 'table')).toHaveLength(1);
});
