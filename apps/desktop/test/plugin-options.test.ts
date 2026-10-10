// @vitest-environment jsdom
import type { InternalPlugin, PluginHost, PluginOptionSpec } from '@simplemd/plugin-api/runtime';
import { describe, expect, test, vi } from 'vitest';
import { setup } from './helpers';

/** r7 ST — opções dos plugins internos (R-X7.4, DA-R7-12) e estados de carga (STR-181). */
const OPTIONS: readonly PluginOptionSpec[] = [
  { key: 'auto', kind: 'boolean', label: 'Fração automática', default: true },
  {
    key: 'lang',
    kind: 'select',
    label: 'Idioma padrão',
    default: 'pt-BR',
    choices: [
      { value: 'pt-BR', label: 'Português (Brasil)', lang: 'pt-BR' },
      { value: 'en-US', label: 'English (US)', lang: 'en-US' },
    ],
  },
  { key: 'size', kind: 'number', label: 'Tamanho', default: 3, min: 1, max: 5 },
  {
    key: 'rules',
    kind: 'list',
    label: 'Regras desativadas',
    emptyText: 'Nenhuma regra desativada.',
  },
];

function plugin(
  load: InternalPlugin['load'] = vi.fn(async () => ({ default: () => {} })),
): InternalPlugin {
  return {
    manifest: {
      id: 'simplemd.teste',
      name: 'Teste',
      version: '0.0.0',
      minAppVersion: '0.0.0',
      main: 'index.ts',
    },
    defaultEnabled: false,
    options: OPTIONS,
    load,
  };
}

/** A pasta abriu e o plugin (desligado por padrão) já assentou: opções lidas do data.json. */
async function settled(host: PluginHost) {
  await vi.waitFor(() =>
    expect(host.getSnapshot().internal[0]?.reason).toBe('Desativado por você.'),
  );
}

const DATA = '.simplemd/plugins/simplemd.teste/data.json';

describe('opções de plugin interno', () => {
  test('desligado por padrão; valores do data.json validados (inválido → padrão + aviso)', async () => {
    const h = await setup(
      { 'a.md': 'x', [DATA]: JSON.stringify({ auto: 'sim', lang: 'en-US', size: 9 }) },
      { internal: [plugin()] },
    );
    await settled(h.app.plugins.host);
    const row = h.app.plugins.host.getSnapshot().internal[0];
    expect(row?.checked).toBe(false);
    expect(row?.hasOptions).toBe(true);
    const view = h.app.plugins.host.internalOptions('simplemd.teste');
    expect(view?.values).toMatchObject({ auto: true, lang: 'en-US', size: 3, rules: [] });
    expect(
      h.app.store
        .getState()
        .notices.map((n) => n.text)
        .join('\n'),
    ).toContain(
      'valores inválidos em .simplemd/plugins/simplemd.teste/data.json foram trocados pelo padrão (auto, size)',
    );
  });

  test('mudança com o plugin desligado: grava no data.json, limita número, anuncia STR-180', async () => {
    const h = await setup({ 'a.md': 'x' }, { internal: [plugin()] });
    const host = h.app.plugins.host;
    await settled(host);
    const seen: string[] = [];
    host.onInternalOption('simplemd.teste', (key) => seen.push(key));
    expect(await host.setInternalOption('simplemd.teste', 'lang', 'en-US')).toEqual({
      ok: true,
      value: 'en-US',
    });
    expect(host.getSnapshot().announcement?.text).toBe('“Idioma padrão”: English (US).');
    expect(await host.setInternalOption('simplemd.teste', 'size', '42')).toEqual({
      ok: true,
      value: 5,
    });
    expect(await host.setInternalOption('simplemd.teste', 'size', 'abc')).toEqual({
      ok: false,
      message: 'Entre 1 e 5.',
    });
    expect(await host.setInternalOption('simplemd.teste', 'lang', 'xx')).toMatchObject({
      ok: false,
    });
    expect(seen).toEqual(['lang', 'size']);
    expect(JSON.parse(h.port.readText(DATA) ?? '{}')).toEqual({ lang: 'en-US', size: 5 });
  });

  test('ligado: api.settings.get vê o valor mudado pelo gerenciador (mesmo objeto)', async () => {
    let api: { settings: { get(key: string): unknown } } | null = null;
    const load = vi.fn(async () => ({
      default: (a: typeof api) => {
        api = a;
      },
    }));
    const h = await setup({ 'a.md': 'x' }, { internal: [plugin(load)] });
    const host = h.app.plugins.host;
    await settled(host);
    await host.setEnabled('simplemd.teste', true);
    await host.setInternalOption('simplemd.teste', 'auto', false);
    expect(api!.settings.get('auto')).toBe(false);
  });

  test('falha do import(): status Erro + "Não foi possível carregar o plugin: …", desligado', async () => {
    const load = vi.fn(async () => {
      throw new Error('rede caiu');
    });
    const h = await setup({ 'a.md': 'x' }, { internal: [plugin(load)] });
    const host = h.app.plugins.host;
    await settled(host);
    await host.setEnabled('simplemd.teste', true);
    const row = host.getSnapshot().internal[0];
    expect(row?.status).toBe('Erro');
    expect(row?.reason).toBe('Não foi possível carregar o plugin: rede caiu');
    expect(row?.checked).toBe(false);
  });
});
