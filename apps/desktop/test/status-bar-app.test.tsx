// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from '../src/app/App';
import type { InternalPluginDescriptor } from '../src/plugins/internal/index';
import { setup } from './helpers';

/**
 * r7 ST (CR-ST-11, UX-R7-D11): presença da barra de status C6 na casca. Ausente com os padrões;
 * aparece com a "Tecla Tab no editor"; T1↔T2 só muda o item (sem desmontar a barra); some ao
 * desligar a chave.
 */
afterEach(cleanup);

test('STB-ABSENT com padrões; chave liga a barra; Ctrl-M muda o modo sem desmontar; desligar some', async () => {
  const h = await setup({ 'nota.md': '# Nota\n' });
  const { container } = render(<App app={h.app} />);
  await act(async () => {
    await h.app.sync.openFile('nota.md');
  });
  expect(screen.queryByTestId('status-bar')).toBeNull();
  act(() => h.app.settings.setCaptureTab(true));
  const bar = screen.getByTestId('status-bar');
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
