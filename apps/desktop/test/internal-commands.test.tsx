// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import type { EditorView } from '@codemirror/view';
import { internalCommandsFacet, type InternalCommand } from '@simplemd/core';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { App } from '../src/app/App';
import { setup } from './helpers';

/**
 * JEV D-R7-M05: comandos de paleta dos plugins internos (`host.palette` → `internalCommandsFacet`)
 * aparecem com o título exato (sem prefixo do nome do plugin) e o atalho mostrado, rodam na view
 * principal e somem quando a facet sai do editor (plugin desligado).
 */
afterEach(cleanup);

test('a paleta lista os comandos da facet com título e atalho exatos, roda na view e some sem a facet', async () => {
  const h = await setup({ 'nota.md': '- um\n' });
  render(<App app={h.app} />);
  await act(async () => {
    await h.app.sync.openFile('nota.md');
  });
  const view = h.app.plugins.editor.view;
  if (!view) throw new Error('editor não montado');
  const ran: EditorView[] = [];
  const commands: InternalCommand[] = [
    {
      id: 'simplemd.teste:mover',
      title: 'Lista: Mover item para cima',
      hotkey: 'Ctrl-Shift-ArrowUp',
      run: (v) => (ran.push(v), true),
    },
    { id: 'simplemd.teste:dobrar', title: 'Lista: Dobrar item', run: () => true },
  ];
  act(() =>
    h.app.plugins.editor.apply({
      pluginExtensions: [internalCommandsFacet.of(commands)],
      completionSources: [],
      globalBindings: [],
    }),
  );
  act(() => h.app.store.setState({ paletteOpen: true, palettePrefill: '' }));
  const move = document.querySelector<HTMLElement>(
    '[role="option"][data-command-id="simplemd.teste:mover"]',
  );
  expect(move?.textContent).toContain('Lista: Mover item para cima');
  expect(move?.textContent).not.toContain('Outliner');
  expect(move?.getAttribute('aria-keyshortcuts')).toBe('Control+Shift+ArrowUp');
  const fold = document.querySelector<HTMLElement>(
    '[role="option"][data-command-id="simplemd.teste:dobrar"]',
  );
  expect(fold?.textContent).toContain('Lista: Dobrar item');
  expect(fold?.getAttribute('aria-keyshortcuts')).toBeNull();
  await act(async () => {
    await h.app.plugins.commands.get('simplemd.teste:mover')?.run();
  });
  expect(ran).toEqual([view]);

  act(() =>
    h.app.plugins.editor.apply({ pluginExtensions: [], completionSources: [], globalBindings: [] }),
  );
  expect(h.app.plugins.commands.get('simplemd.teste:mover')).toBeUndefined();
  expect(h.app.plugins.commands.get('simplemd.teste:dobrar')).toBeUndefined();
});
