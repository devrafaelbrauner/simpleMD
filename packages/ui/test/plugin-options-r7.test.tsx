import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { PluginOptions, type PluginOptionsData } from '../src/plugins/PluginOptions';

/** r7 ST — opções genéricas de plugin: `info` sem releitura por render (CR-ST-08), `number` (CR-ST-09). */
afterEach(cleanup);

const props = { id: 'opts', pluginId: 'simplemd.lint', pluginName: 'Lint', onChange: vi.fn() };

test('CR-ST-08: info é lido ao abrir e quando os valores mudam, não a cada render', async () => {
  const info = vi.fn<(key: string) => Promise<string>>(async () => 'Padrão do simpleMD');
  const data = (values: Record<string, unknown>): PluginOptionsData => ({
    fields: [{ key: 'rules', kind: 'info', label: 'Regras em uso' }],
    values,
    // Função nova em todo render, como o app faz.
    info: (key) => info(key),
  });
  const { rerender } = render(<PluginOptions {...props} data={data({ strict: false })} />);
  expect(await screen.findByText('Padrão do simpleMD')).toBeTruthy();
  for (let i = 0; i < 5; i++) rerender(<PluginOptions {...props} data={data({ strict: false })} />);
  await act(async () => {});
  expect(info).toHaveBeenCalledTimes(1);
  rerender(<PluginOptions {...props} data={data({ strict: true })} />);
  await act(async () => {});
  expect(info).toHaveBeenCalledTimes(2);
});

test('CR-ST-09: number com dica de faixa no aria-describedby e erro com glifo ⚠', async () => {
  const onChange = vi.fn(async () => ({ ok: false as const, message: 'Entre 1 e 10.' }));
  render(
    <PluginOptions
      {...props}
      onChange={onChange}
      data={{
        fields: [{ key: 'delay', kind: 'number', label: 'Atraso', min: 1, max: 10 }],
        values: { delay: 3 },
        info: async () => '',
      }}
    />,
  );
  const input = screen.getByLabelText('Atraso');
  const hintId = input.getAttribute('aria-describedby') ?? '';
  expect(document.getElementById(hintId)?.textContent).toBe('Entre 1 e 10.');
  fireEvent.change(input, { target: { value: '' } });
  await act(async () => {
    fireEvent.blur(input);
  });
  expect(input.getAttribute('aria-invalid')).toBe('true');
  const ids = (input.getAttribute('aria-describedby') ?? '').split(' ');
  expect(ids).toHaveLength(2);
  const error = document.getElementById(ids[1] ?? '');
  expect(error?.textContent).toBe('Entre 1 e 10.');
  expect(error?.querySelector('svg.smd-icon')).not.toBeNull();
});
