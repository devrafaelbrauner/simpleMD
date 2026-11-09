// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from '../src/app/App';
import type { InternalPluginDescriptor } from '../src/plugins/internal/index';
import { setup } from './helpers';

/**
 * r7 ST (CR-ST-11, UX-R7-D11) e r27 (D-R27-03): presença da barra de status C6 na casca. Sem aba e
 * com os padrões, ausente; com uma nota aberta, existe com o item do modo ("Fonte"/"Prévia"); a
 * "Tecla Tab no editor" soma o item Tab; T1↔T2 só muda o item (sem desmontar a barra); desligar a
 * chave tira só o item Tab; fechar a última aba tira a barra.
 */
afterEach(cleanup);

test('STB-ABSENT sem aba; nota aberta = item do modo; chave soma o Tab; Ctrl-M muda o modo sem desmontar; desligar tira o item', async () => {
  const h = await setup({ 'nota.md': '# Nota\n' });
  const { container } = render(<App app={h.app} />);
  expect(screen.queryByTestId('status-bar')).toBeNull();
  await act(async () => {
    await h.app.sync.openFile('nota.md');
  });
  const bar = screen.getByTestId('status-bar');
  expect(screen.getByTestId('status-mode').getAttribute('data-mode')).toBe(
    h.app.plugins.editor.mode.getSnapshot(),
  );
  expect(screen.queryByTestId('status-tab')).toBeNull();
  act(() => h.app.settings.setCaptureTab(true));
  expect(screen.getByTestId('status-bar')).toBe(bar);
  expect(screen.getByTestId('status-tab').getAttribute('data-mode')).toBe('indent');
  const content = container.querySelector<HTMLElement>('.cm-content');
  act(() => {
    content?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'm',
        code: 'KeyM',
        // jsdom não é macOS: o alternador é Ctrl-M.
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(screen.getByTestId('status-tab').getAttribute('data-mode')).toBe('focus');
  expect(screen.getByTestId('status-bar')).toBe(bar);
  act(() => h.app.settings.setCaptureTab(false));
  expect(screen.queryByTestId('status-tab')).toBeNull();
  expect(screen.getByTestId('status-bar')).toBe(bar);
  await act(async () => {
    await h.app.sync.closeTab('nota.md');
  });
  expect(screen.queryByTestId('status-bar')).toBeNull();
});

test('desligar um interno grava a preferência ANTES do aviso do host (a C6 relê a configuração)', async () => {
  const vim: InternalPluginDescriptor = {
    id: 'simplemd.vim',
    name: 'Vim',
    description: 'teste',
    defaultEnabled: false,
    order: 50,
    load: async () => ({ default: () => {} }),
  };
  const h = await setup({ 'nota.md': '# Nota\n' }, { internalDescriptors: [vim] });
  const { host } = h.app.plugins;
  await host.setEnabled('simplemd.vim', true);
  await vi.waitFor(() => expect(h.app.settings.internalPluginEnabled('simplemd.vim')).toBe(true));
  const seen: boolean[] = [];
  host.subscribe(() => seen.push(h.app.settings.internalPluginEnabled('simplemd.vim')));
  await host.setEnabled('simplemd.vim', false);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((enabled) => !enabled)).toBe(true);
});
