// @vitest-environment jsdom
import type { InternalPlugin, PluginHost, PluginOptionSpec } from '@simplemd/plugin-api/runtime';
import { describe, expect, test, vi } from 'vitest';
import { setup } from './helpers';

/**
 * r7 ST — opções dos plugins internos (R-X7.4, DA-R7-12) e estados de carga (STR-181). r32c: o tipo
 * `dictionary` (sem valor no data.json) e a ativação que espera a leitura das opções da pasta.
 */
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
  options: readonly PluginOptionSpec[] = OPTIONS,
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
    options,
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

  test('ligado: api.settings.set de uma opção pelo próprio plugin republica o gerenciador (CR-S8 N9)', async () => {
    let api: { settings: { set(key: string, value: unknown): Promise<void> } } | null = null;
    const load = vi.fn(async () => ({
      default: (a: typeof api) => {
        api = a;
      },
    }));
    const h = await setup({ 'a.md': 'x' }, { internal: [plugin(load)] });
    const host = h.app.plugins.host;
    await settled(host);
    await host.setEnabled('simplemd.teste', true);
    const before = host.getSnapshot();
    await api!.settings.set('rules', ['X_RULE']);
    // Novo snapshot → o gerenciador aberto re-renderiza e relê `internalOptions` (lista atualizada).
    expect(host.getSnapshot()).not.toBe(before);
    expect(host.internalOptions('simplemd.teste')?.values.rules).toEqual(['X_RULE']);
    expect(JSON.parse(h.port.readText(DATA) ?? '{}')).toEqual({ rules: ['X_RULE'] });
    // Chave que não é opção: sem republicar.
    const after = host.getSnapshot();
    await api!.settings.set('outra', 1);
    expect(host.getSnapshot()).toBe(after);
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

describe('r32c: opção `dictionary` e ativação durante a leitura das opções da pasta', () => {
  test('`dictionary` não tem valor nem grava: a chave de mesmo nome no data.json não vale nem avisa', async () => {
    const options: readonly PluginOptionSpec[] = [
      ...OPTIONS,
      { key: 'words', kind: 'dictionary', label: 'Dicionário' },
    ];
    const h = await setup(
      { 'a.md': 'x', [DATA]: JSON.stringify({ lang: 'en-US', words: 'qualquer' }) },
      { internal: [plugin(undefined, options)] },
    );
    const host = h.app.plugins.host;
    await settled(host);
    const view = host.internalOptions('simplemd.teste');
    expect(view?.specs.at(-1)?.kind).toBe('dictionary');
    expect(view?.values.words).toBeUndefined();
    expect(view?.values.lang).toBe('en-US');
    expect(h.app.store.getState().notices.map((n) => n.text)).toEqual([]);
    expect(await host.setInternalOption('simplemd.teste', 'words', ['x'])).toEqual({
      ok: false,
      message: 'Opção desconhecida.',
    });
    expect(JSON.parse(h.port.readText(DATA) ?? '{}')).toEqual({ lang: 'en-US', words: 'qualquer' });
  });

  test('ligar antes de o data.json ser lido: a ativação espera e o api.settings vê os valores e grava', async () => {
    let api: {
      settings: { get(key: string): unknown; set(key: string, value: unknown): Promise<void> };
    } | null = null;
    const activate = vi.fn((a: typeof api) => {
      api = a;
    });
    const load = vi.fn(async () => ({ default: activate }));
    const h = await setup(
      { 'a.md': 'x', [DATA]: JSON.stringify({ lang: 'en-US' }) },
      { internal: [plugin(load)], open: false },
    );
    const host = h.app.plugins.host;
    const scans: string[] = [];
    host.subscribe(() => scans.push(host.getSnapshot().scan));
    // A leitura do data.json demora (pasta sincronizada lenta): o interruptor chega antes do fim.
    h.port.fault({ op: 'readFile', path: DATA, delayMs: 50, once: true });
    await h.app.sync.openVault('welcome');
    expect(host.internalOptions('simplemd.teste')?.values.lang).toBe('pt-BR');
    await host.setEnabled('simplemd.teste', true);
    expect(host.getSnapshot().internal[0]?.status).toBe('Ativo');
    expect(api!.settings.get('lang')).toBe('en-US');
    await api!.settings.set('size', 4);
    expect(JSON.parse(h.port.readText(DATA) ?? '{}')).toEqual({ lang: 'en-US', size: 4 });
    // A carga da pasta também ativa os internos ligados (o interruptor já gravou "ligado") antes
    // de procurar os externos: terminada a procura, continua uma ativação só.
    await vi.waitFor(() => {
      const at = scans.indexOf('scanning');
      expect(at).toBeGreaterThanOrEqual(0);
      expect(scans.slice(at)).toContain('idle');
    });
    expect(activate).toHaveBeenCalledTimes(1);
    expect(host.getSnapshot().internal[0]?.checked).toBe(true);
  });

  test('trocar de pasta no meio da leitura: a ativação presa não trava o interruptor e vale a pasta nova', async () => {
    let api: { settings: { get(key: string): unknown } } | null = null;
    const activate = vi.fn((a: typeof api) => {
      api = a;
    });
    const load = vi.fn(async () => ({ default: activate }));
    const h = await setup(
      { 'a.md': 'x', [DATA]: JSON.stringify({ lang: 'en-US' }) },
      { internal: [plugin(load)], open: false },
    );
    const host = h.app.plugins.host;
    // A 1ª leitura do data.json não termina (na prática); ligar fica esperando por ela.
    h.port.fault({ op: 'readFile', path: DATA, delayMs: 2_000_000_000, once: true });
    await h.app.sync.openVault('welcome');
    void host.setEnabled('simplemd.teste', true);
    await vi.waitFor(() => expect(host.getSnapshot().internal[0]?.busy).toBe(true));
    // Outra pasta (o mesmo caminho, com outro data.json), cuja leitura também demora um pouco.
    h.port.externalWrite(DATA, JSON.stringify({ lang: 'en-US', size: 5 }));
    h.port.fault({ op: 'readFile', path: DATA, delayMs: 50, once: true });
    await h.app.sync.openVault('shell');
    expect(host.getSnapshot().internal[0]?.busy).toBe(false);
    await host.setEnabled('simplemd.teste', true);
    expect(host.getSnapshot().internal[0]?.status).toBe('Ativo');
    expect(api!.settings.get('size')).toBe(5);
    expect(activate).toHaveBeenCalledTimes(1);
  });
});
