// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from '../src/app/App';
import latexSnippets from '../src/plugins/internal/latex-snippets';
import { setup } from './helpers';

/**
 * r7 S6 no app montado: ligar "Snippets LaTeX" registra os 3 comandos da paleta com o título exato
 * (host.palette chamado UMA vez por ativação: nenhum aviso "repetido", CR-PAL-D01), lê
 * `.simplemd/latex-snippets.json` e a digitação na view principal expande.
 */
afterEach(cleanup);

test('ligado: comandos na paleta sem "repetido", snippets do vault valem e `$x/2` vira fração', async () => {
  const warn = vi.spyOn(console, 'warn');
  const h = await setup(
    {
      'nota.md': 'a\n',
      '.simplemd/latex-snippets.json': JSON.stringify([
        { trigger: 'qq', replacement: '\\quad ', options: 'mA' },
        { trigger: 'x', replacement: 'y', options: 'mc' },
      ]),
    },
    { internalDescriptors: [latexSnippets] },
  );
  render(<App app={h.app} />);
  await act(async () => {
    await h.app.sync.openFile('nota.md');
  });
  await act(async () => {
    await h.app.plugins.host.setEnabled('simplemd.latex-snippets', true);
  });
  await vi.waitFor(() => {
    if (!h.app.plugins.commands.get('simplemd.latex-snippets:expand'))
      throw new Error('sem comando');
  });
  for (const [id, title] of [
    ['simplemd.latex-snippets:expand', 'Expandir snippet LaTeX'],
    ['simplemd.latex-snippets:next-field', 'LaTeX: Próximo campo do snippet'],
    ['simplemd.latex-snippets:prev-field', 'LaTeX: Campo anterior do snippet'],
  ] as const)
    expect(h.app.plugins.commands.get(id)?.title).toBe(title);
  await vi.waitFor(() =>
    expect(h.app.store.getState().notices.map((n) => n.text)).toContain(
      'Snippets LaTeX: 1 snippet ignorado em .simplemd/latex-snippets.json.',
    ),
  );

  const view = h.app.plugins.editor.view;
  if (!view) throw new Error('editor não montado');
  const type = (text: string) => {
    for (const key of text) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(event);
      if (!event.defaultPrevented)
        view.dispatch(
          view.state.update(view.state.replaceSelection(key), { userEvent: 'input.type' }),
        );
    }
  };
  act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
  act(() => type('$x/2 qq'));
  // Em linha, o espaço do fim de `\quad ` sai (`removeSnippetWhitespace` do upstream).
  expect(view.state.doc.toString()).toBe('a\n$\\frac{x}{2 \\quad}');
  expect(
    warn.mock.calls.filter((call) => call.some((arg) => String(arg).includes('repetido'))),
  ).toEqual([]);
  warn.mockRestore();
});
