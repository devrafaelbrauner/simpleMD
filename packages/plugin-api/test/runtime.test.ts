import * as autocomplete from '@codemirror/autocomplete';
import * as language from '@codemirror/language';
import * as state from '@codemirror/state';
import * as view from '@codemirror/view';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  AppEventBus,
  builtinHotkeys,
  CommandRegistry,
  compareSemver,
  ContributionStore,
  discoverPlugins,
  normalizeHotkey,
  PanelRegistry,
  PluginHost,
  prepareModule,
  type ApprovalsPort,
  type ModuleEvaluator,
  type PluginDirPort,
  type PluginHostSnapshot,
  type PluginNotice,
  type PluginVaultContext,
} from '../src/runtime';

const encoder = new TextEncoder();
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Avaliador do Vitest: o Node não importa `blob:`, então o texto vai para arquivos temporários. */
// Dentro do projeto (em `build/`, ignorado): o executor do Vitest só resolve arquivos sob a raiz.
mkdirSync(join(__dirname, '../build'), { recursive: true });
const dir = mkdtempSync(join(__dirname, '../build/plugins-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let seq = 0;
const evaluator: ModuleEvaluator = {
  publish(text) {
    const file = join(dir, `simplemd-plugin-${++seq}.mjs`);
    writeFileSync(file, text);
    // `/` em todo SO: o caminho vai para dentro de um literal de string JS (no Windows `\` escaparia).
    return file.replace(/\\/g, '/');
  },
  importModule: (url) => import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>,
};
const HOST = {
  '@codemirror/state': state,
  '@codemirror/view': view,
  '@codemirror/language': language,
  '@codemirror/autocomplete': autocomplete,
};

interface FakePlugin {
  manifest?: string | object;
  main?: string;
  mainSize?: number;
}

/** Vault em memória só com `.simplemd/plugins/*`; conta leituras de cada `main.js`. */
function fakeVault(plugins: Record<string, FakePlugin>, stray: string[] = []) {
  const reads: string[] = [];
  const dirPort: PluginDirPort = {
    listPluginFolders: async () => [
      ...Object.keys(plugins).map((name) => ({ name, kind: 'dir' })),
      ...stray.map((name) => ({ name, kind: 'file' })),
    ],
    async readManifest(folder) {
      const m = plugins[folder]?.manifest;
      if (m === undefined) throw Object.assign(new Error('x'), { code: 'NOT_FOUND' });
      const bytes = encoder.encode(typeof m === 'string' ? m : JSON.stringify(m));
      if (bytes.length > 64 * 1024) throw Object.assign(new Error('x'), { code: 'TOO_LARGE' });
      return bytes;
    },
    async statMain(folder) {
      const p = plugins[folder];
      if (p?.main === undefined) return null;
      return { size: p.mainSize ?? encoder.encode(p.main).length };
    },
  };
  return {
    plugins,
    reads,
    dir: dirPort,
    async readMain(folder: string) {
      reads.push(folder);
      return encoder.encode(plugins[folder]?.main ?? '');
    },
  };
}

function memoryApprovals(): ApprovalsPort & {
  map: Map<string, { sha256: string; enabled: boolean }>;
} {
  const map = new Map<string, { sha256: string; enabled: boolean }>();
  return {
    map,
    get: async () => Object.fromEntries(map),
    set: async (id, sha256) => void map.set(id, { sha256, enabled: true }),
    async setEnabled(id, enabled) {
      const a = map.get(id);
      if (!a) throw new Error('NOT_APPROVED');
      a.enabled = enabled;
    },
  };
}

const manifest = (id: string, extra: object = {}) => ({
  id,
  name: `Plugin ${id}`,
  version: '1.0.0',
  minAppVersion: '0.0.0',
  main: 'main.js',
  ...extra,
});

function makeHost(approvals = memoryApprovals(), sha256Hex = sha) {
  const notices: PluginNotice[] = [];
  const commands = new CommandRegistry();
  const panels = new PanelRegistry();
  const events = new AppEventBus();
  let host: PluginHost | null = null;
  const contributions = new ContributionStore(
    builtinHotkeys([], 'other'),
    (id) => host?.rank(id) ?? 0,
  );
  host = new PluginHost({
    appVersion: '0.1.0',
    platform: 'other',
    commands,
    panels,
    contributions,
    events,
    evaluator,
    hostModules: HOST,
    sha256Hex,
    paletteHotkeyLabel: 'Ctrl+Shift+P',
    notify: (n) => notices.push(n),
    showPanel: vi.fn(),
  });
  const contextFor = (vault: ReturnType<typeof fakeVault>): PluginVaultContext => ({
    dir: vault.dir,
    readMain: (folder) => vault.readMain(folder),
    approvals,
    settings: { load: async () => ({ values: {}, writable: true }), save: async () => {} },
    vaultFor: () => ({
      read: async () => '',
      write: async () => {},
      list: async () => [],
      dispose: () => {},
    }),
  });
  const row = (key: string) => {
    const snap: PluginHostSnapshot = host.getSnapshot();
    return [...snap.internal, ...snap.external].find((r) => r.key === key);
  };
  return { host, commands, panels, events, contributions, notices, approvals, contextFor, row };
}

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).__probe;
});

describe('descoberta e manifesto (AC-6.4, AC-6.5)', () => {
  const PROBE = 'globalThis.__probe = 1; export default () => {};';
  const cases: Array<[string, FakePlugin, string, string]> = [
    ['JSON malformado', { manifest: '{ "id": ', main: PROBE }, 'Inválido', 'JSON malformado'],
    [
      'sem main',
      { manifest: { ...manifest('a.b'), main: undefined }, main: PROBE },
      'Inválido',
      'main',
    ],
    ['id Com.X', { manifest: manifest('Com.X'), main: PROBE }, 'Inválido', 'id'],
    ['pasta ≠ id', { manifest: manifest('a.c'), main: PROBE }, 'Inválido', 'id'],
    [
      'version 1.0',
      { manifest: manifest('a.b', { version: '1.0' }), main: PROBE },
      'Inválido',
      'version',
    ],
    [
      'main ../x.js',
      { manifest: manifest('a.b', { main: '../x.js' }), main: PROBE },
      'Inválido',
      'main',
    ],
    [
      'main /abs.js',
      { manifest: manifest('a.b', { main: '/abs.js' }), main: PROBE },
      'Inválido',
      'main',
    ],
    ['main x.ts', { manifest: manifest('a.b', { main: 'x.ts' }), main: PROBE }, 'Inválido', 'main'],
    [
      'manifesto 65 KB',
      { manifest: { ...manifest('a.b'), pad: 'x'.repeat(65 * 1024) }, main: PROBE },
      'Inválido',
      'manifest.json',
    ],
    [
      'main 5 MB + 1',
      { manifest: manifest('a.b'), main: PROBE, mainSize: 5 * 1024 * 1024 + 1 },
      'Inválido',
      'main',
    ],
    [
      'minAppVersion acima',
      { manifest: manifest('a.b', { minAppVersion: '9.0.0' }), main: PROBE },
      'Incompatível',
      'requer simpleMD ≥ 9.0.0',
    ],
  ];
  test.each(cases)(
    '%s → status nomeando o campo, 0 leituras do main.js',
    async (_l, plugin, status, field) => {
      const t = makeHost();
      const vault = fakeVault({ 'a.b': plugin });
      await t.host.loadForVault(t.contextFor(vault));
      const row = t.row('a.b');
      expect(row?.status).toBe(status);
      expect(row?.reason).toContain(field);
      expect(row?.toggleable).toBe(false);
      expect(vault.reads).toEqual([]);
      expect((globalThis as Record<string, unknown>).__probe).toBeUndefined();
    },
  );

  test('20 pastas válidas + 2 arquivos soltos → exatamente as 20, em ordem de id', async () => {
    const plugins: Record<string, FakePlugin> = {};
    for (let i = 20; i >= 1; i--) {
      const id = `p.n${String(i).padStart(2, '0')}`;
      plugins[id] = { manifest: manifest(id), main: 'export default () => {};' };
    }
    const records = await discoverPlugins(fakeVault(plugins, ['solto.txt', 'x.js']).dir, '0.1.0');
    expect(records.map((r) => r.folder)).toEqual(Object.keys(plugins).sort());
    expect(records.every((r) => r.kind === 'valid')).toBe(true);
  });

  test('SemVer: precedência com pré-lançamento', () => {
    expect(compareSemver('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1);
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
    expect(compareSemver('1.0.0+b', '1.0.0')).toBe(0);
  });
});

describe('carregador (R-6.8, VR-4)', () => {
  const urls = {
    '@codemirror/state': 'u:state',
    '@codemirror/view': 'u:view',
    '@codemirror/language': 'u:language',
    '@codemirror/autocomplete': 'u:autocomplete',
  };
  test('troca só os 4 módulos do host e acrescenta o sourceURL', () => {
    const text = prepareModule(
      encoder.encode(
        "import { EditorView } from '@codemirror/view';\nconst s = import('@codemirror/state');",
      ),
      'a.b',
      'main.js',
      urls,
    );
    expect(text).toContain("from 'u:view'");
    expect(text).toContain('import("u:state")');
    expect(text.trimEnd().endsWith('//# sourceURL=simplemd-plugin://a.b/main.js')).toBe(true);
  });
  test.each([
    "import 'lodash';",
    "import './x.js';",
    "import 'https://e.com/x.js';",
    'const m = "x"; import(m);',
  ])('recusa %s nomeando o especificador', (src) => {
    expect(() => prepareModule(encoder.encode(src), 'a.b', 'main.js', urls)).toThrow(
      /Importa um módulo indisponível/,
    );
  });
  test('main.js que não é UTF-8 é recusado', () => {
    expect(() => prepareModule(new Uint8Array([0xff, 0xfe]), 'a.b', 'main.js', urls)).toThrow(
      /UTF-8/,
    );
  });
});

describe('atalhos (R-6.9)', () => {
  test('forma canônica e conjunto de conflito', () => {
    expect(normalizeHotkey('Mod-Shift-H', 'mac')).toBe('Shift-Meta-h');
    expect(normalizeHotkey('Mod-Shift-H', 'other')).toBe('Shift-Ctrl-h');
    const set = builtinHotkeys([{ key: 'Mod-z' }, { key: 'Mod-y', mac: 'Mod-Shift-z' }], 'mac');
    for (const key of ['Mod-b', 'Mod-Shift-p', 'Mod-Shift-l', 'Mod-z', 'Mod-Shift-z', 'Enter'])
      expect(set.has(normalizeHotkey(key, 'mac'))).toBe(true);
    expect(set.has(normalizeHotkey('Mod-Shift-h', 'mac'))).toBe(false);
  });
});

const PLUGIN = (body: string) =>
  `import { ViewPlugin } from '@codemirror/view';\nexport default function activate(api) {\n${body}\n}`;

describe('ciclo de vida, consentimento e isolamento (AC-6.6, 6.8, 6.9, 6.10, 6.18, 6.19, 6.28)', () => {
  test('novo → Desativado; ligar abre o aviso; Cancelar não executa; Ativar → activate 1×', async () => {
    const t = makeHost();
    const main = PLUGIN('globalThis.__probe = (globalThis.__probe ?? 0) + 1;');
    const vault = fakeVault({ 'a.b': { manifest: manifest('a.b'), main } });
    await t.host.loadForVault(t.contextFor(vault));
    expect(t.row('a.b')).toMatchObject({
      status: 'Desativado',
      reason: 'Nunca ativado neste dispositivo.',
    });
    await t.host.setEnabled('a.b', true);
    const warning = t.host.getSnapshot().warning;
    expect(warning).toMatchObject({
      id: 'a.b',
      changed: false,
      hash12: sha(encoder.encode(main)).slice(0, 12),
    });
    t.host.cancelWarning();
    expect((globalThis as Record<string, unknown>).__probe).toBeUndefined();
    expect(t.row('a.b')?.status).toBe('Desativado');
    await t.host.setEnabled('a.b', true);
    await t.host.confirmWarning();
    expect((globalThis as Record<string, unknown>).__probe).toBe(1);
    expect(t.row('a.b')).toMatchObject({ status: 'Ativo', checked: true });
    expect(vault.reads).toEqual(['a.b']); // uma leitura: os bytes do hash são os executados
  });

  test('1 byte mudado → Alterado, nada executa, ligar mostra o aviso de novo; aparelho novo → Desativado', async () => {
    const approvals = memoryApprovals();
    const t = makeHost(approvals);
    const vault = fakeVault({
      'a.b': { manifest: manifest('a.b'), main: PLUGIN('globalThis.__probe = 1;') },
    });
    await t.host.loadForVault(t.contextFor(vault));
    await t.host.setEnabled('a.b', true);
    await t.host.confirmWarning();
    expect(t.row('a.b')?.status).toBe('Ativo');
    delete (globalThis as Record<string, unknown>).__probe;
    vault.plugins['a.b']!.main = PLUGIN('globalThis.__probe = 2;');
    await t.host.reload();
    expect(t.row('a.b')).toMatchObject({ status: 'Alterado — confirme de novo', checked: false });
    expect((globalThis as Record<string, unknown>).__probe).toBeUndefined();
    await t.host.setEnabled('a.b', true);
    expect(t.host.getSnapshot().warning?.changed).toBe(true);
    t.host.cancelWarning();
    approvals.map.clear();
    await t.host.reload();
    expect(t.row('a.b')?.status).toBe('Desativado');
  });

  test('CR2-07: bytes trocados entre o aviso e o clique com o MESMO prefixo de 12 hex → nada é aprovado', async () => {
    // Hash com prefixo fixo: dois códigos diferentes colidem nos 12 hex que o aviso mostra.
    const prefixed = (bytes: Uint8Array) => `abcdefabcdef${sha(bytes).slice(12)}`;
    const approvals = memoryApprovals();
    const t = makeHost(approvals, prefixed);
    const vault = fakeVault({
      'a.b': { manifest: manifest('a.b'), main: PLUGIN('globalThis.__probe = 1;') },
    });
    await t.host.loadForVault(t.contextFor(vault));
    await t.host.setEnabled('a.b', true);
    expect(t.host.getSnapshot().warning?.hash12).toBe('abcdefabcdef');
    vault.plugins['a.b']!.main = PLUGIN('globalThis.__probe = 666;');
    await t.host.reload();
    await t.host.confirmWarning();
    expect(approvals.map.size).toBe(0);
    expect((globalThis as Record<string, unknown>).__probe).toBeUndefined();
    expect(t.row('a.b')?.status).not.toBe('Ativo');
  });

  test('API congelada, 1 argumento, 8 chaves, instâncias distintas, sem __TAURI__', async () => {
    const t = makeHost();
    const body = `
      globalThis.__apis = [...(globalThis.__apis ?? []), { n: arguments.length, keys: Object.keys(api),
        frozen: Object.isFrozen(api) && Object.isFrozen(api.vault), api, tauri: typeof window.__TAURI__ }];`;
    const main = `export default function activate(api) {${body}}`;
    const vault = fakeVault({
      'a.b': { manifest: manifest('a.b'), main },
      'a.c': { manifest: manifest('a.c'), main },
    });
    await t.host.loadForVault(t.contextFor(vault));
    for (const id of ['a.b', 'a.c']) {
      await t.host.setEnabled(id, true);
      await t.host.confirmWarning();
    }
    const apis = (globalThis as Record<string, unknown>).__apis as Array<Record<string, unknown>>;
    expect(apis).toHaveLength(2);
    for (const a of apis) {
      expect(a.n).toBe(1);
      expect(a.keys).toEqual([
        'registerCommand',
        'registerEditorExtension',
        'registerPanel',
        'registerCompletionSource',
        'on',
        'vault',
        'settings',
        'ui',
      ]);
      expect(a.frozen).toBe(true);
      expect(a.tauri).toBe('undefined');
    }
    expect(apis[0]!.api).not.toBe(apis[1]!.api);
  });

  test('comandos, atalhos, wysiwyg, painel, eventos, descarte e religar sem aviso', async () => {
    const t = makeHost();
    const main = PLUGIN(`
      globalThis.__probe = (globalThis.__probe ?? 0) + 1;
      api.registerCommand('x', { name: 'Dizer olá', hotkey: 'Mod-Shift-H', run: () => api.ui.notify('oi') });
      api.registerCommand('b', { name: 'Negrito', hotkey: 'Mod-b', run() {} });
      try { api.registerCommand('x', { name: 'dup', run() {} }); } catch (e) { globalThis.__dup = String(e); }
      try { api.registerEditorExtension({}); } catch (e) { globalThis.__ext = e instanceof TypeError && String(e); }
      api.registerEditorExtension({ wysiwyg: { opaque: true } });
      api.registerEditorExtension({ source: ViewPlugin.define(() => ({})) });
      api.registerPanel('p', { title: 'T', render(el) { el.textContent = 'painel'; globalThis.__render = (globalThis.__render ?? 0) + 1; } });
      api.on('file:save', (e) => { globalThis.__saves = [...(globalThis.__saves ?? []), e]; });
      return () => { globalThis.__disposed = (globalThis.__disposed ?? 0) + 1; };`);
    const vault = fakeVault({ 'a.b': { manifest: manifest('a.b', { name: 'Hello' }), main } });
    const g = globalThis as Record<string, unknown>;
    const baseline = {
      commands: t.commands.size,
      panels: t.panels.getSnapshot().length,
      ...t.contributions.counts(),
    };
    await t.host.loadForVault(t.contextFor(vault));
    await t.host.setEnabled('a.b', true);
    await t.host.confirmWarning();
    expect(t.commands.get('a.b:x')?.title).toBe('Hello: Dizer olá');
    expect(t.commands.get('a.b:x')?.hotkey).toBe('Mod-Shift-H');
    expect(t.commands.get('a.b:b')?.hotkey).toBeUndefined();
    expect(t.notices.find((n) => n.kind === 'plugin-hotkey')?.text).toBe(
      'Hello: o atalho Mod-b de “Negrito” já é usado pelo simpleMD. Use a paleta de comandos (Ctrl+Shift+P).',
    );
    expect(String(g.__dup)).toContain('já registrado');
    expect(String(g.__ext)).toMatch(/source.*wysiwyg/);
    expect(t.contributions.counts()).toEqual({ extensions: 1, sources: 0, hotkeys: 1 });
    t.commands.get('a.b:x')!.run();
    expect(t.notices.at(-1)).toMatchObject({ level: 'info', text: 'Hello: oi' });
    // Painel: render 1× mesmo pedindo duas vezes.
    t.panels.ensureRendered('a.b:p');
    t.panels.ensureRendered('a.b:p');
    expect(g.__render).toBe(1);
    const panelEl = t.panels.getSnapshot()[0]!.el;
    t.events.emit('file:save', { path: 'n.md', mtime: 1 });
    expect(g.__saves).toEqual([{ path: 'n.md', mtime: 1 }]);
    // Desligar: dispose 1×, contagens de volta à base, painel esvaziado.
    await t.host.setEnabled('a.b', false);
    expect(g.__disposed).toBe(1);
    expect({
      commands: t.commands.size,
      panels: t.panels.getSnapshot().length,
      ...t.contributions.counts(),
    }).toEqual(baseline);
    expect(panelEl.textContent).toBe('');
    t.events.emit('file:save', { path: 'n.md', mtime: 2 });
    expect(g.__saves).toHaveLength(1);
    expect(t.row('a.b')).toMatchObject({ status: 'Desativado', reason: 'Desativado por você.' });
    // Religar com o mesmo hash: sem aviso; o módulo não é reavaliado (`__probe` sobrevive).
    await t.host.setEnabled('a.b', true);
    expect(t.host.getSnapshot().warning).toBeNull();
    expect(t.row('a.b')?.status).toBe('Ativo');
    expect(g.__probe).toBe(2);
  });

  test('falhas: activate lança → 0 registros, Erro; comando/evento/render/sugestões → 1 aviso por tipo', async () => {
    const t = makeHost();
    const vault = fakeVault({
      'f.a': {
        manifest: manifest('f.a'),
        main: PLUGIN(`api.registerCommand('c', { name: 'c', run() {} }); throw new Error('boom');`),
      },
      'f.b': {
        manifest: manifest('f.b', { name: 'Faulty' }),
        main: PLUGIN(`
          api.registerCommand('c', { name: 'quebra', run() { throw new Error('cmd'); } });
          api.on('vault:change', () => { throw new Error('evt'); });
          api.registerPanel('p', { title: 'P', render() { throw new Error('rnd'); } });
          api.registerCompletionSource(() => { throw new Error('src'); });`),
      },
      'f.c': {
        manifest: manifest('f.c'),
        main: PLUGIN(
          `api.registerCommand('ok', { name: 'ok', run() { globalThis.__ok = true; } });`,
        ),
      },
    });
    await t.host.loadForVault(t.contextFor(vault));
    for (const id of ['f.a', 'f.b', 'f.c']) {
      await t.host.setEnabled(id, true);
      await t.host.confirmWarning();
    }
    expect(t.row('f.a')).toMatchObject({ status: 'Erro', reason: 'boom', checked: false });
    expect(t.commands.get('f.a:c')).toBeUndefined();
    t.commands.get('f.b:c')!.run();
    t.commands.get('f.b:c')!.run();
    t.events.emit('vault:change', { paths: [] });
    t.panels.ensureRendered('f.b:p');
    const [source] = t.contributions.snapshot().completionSources;
    expect(source!({} as never)).toBeNull();
    const errors = t.notices.filter(
      (n) => n.kind === 'plugin-error' && n.text.startsWith('Faulty'),
    );
    expect(errors.map((n) => n.text)).toEqual([
      'Faulty: erro em comando “quebra” — cmd',
      'Faulty: erro em evento vault:change — evt',
      'Faulty: erro em painel “P” — rnd',
      'Faulty: erro em sugestões — src',
    ]);
    expect(t.row('f.b')?.status).toBe('Erro');
    t.commands.get('f.c:ok')!.run();
    expect((globalThis as Record<string, unknown>).__ok).toBe(true);
  });

  test('ViewPlugin que lança é atribuído pelo stack (extensão do editor)', async () => {
    const t = makeHost();
    const vault = fakeVault({
      'v.p': {
        manifest: manifest('v.p'),
        main: PLUGIN(`globalThis.__fail = () => { throw new Error('vp'); };`),
      },
    });
    await t.host.loadForVault(t.contextFor(vault));
    await t.host.setEnabled('v.p', true);
    await t.host.confirmWarning();
    let error: unknown;
    try {
      ((globalThis as Record<string, unknown>).__fail as () => void)();
    } catch (e) {
      error = e;
    }
    expect(t.host.attribute(error)).toBe('v.p');
    t.host.onEditorException(error);
    expect(t.row('v.p')?.status).toBe('Erro');
  });

  test('troca de vault descarta tudo antes de ativar a próxima (AC-6.28)', async () => {
    const t = makeHost();
    const log: string[] = [];
    (globalThis as Record<string, unknown>).__log = log;
    const main = (n: string) =>
      PLUGIN(
        `globalThis.__log.push('activate ${n}'); return () => globalThis.__log.push('dispose ${n}');`,
      );
    const a = fakeVault({ 'a.a': { manifest: manifest('a.a'), main: main('A') } });
    await t.host.loadForVault(t.contextFor(a));
    await t.host.setEnabled('a.a', true);
    await t.host.confirmWarning();
    const b = fakeVault({ 'b.b': { manifest: manifest('b.b'), main: main('B') } });
    await t.approvals.set('b.b', sha(encoder.encode(b.plugins['b.b']!.main!)));
    await t.host.loadForVault(t.contextFor(b));
    expect(log).toEqual(['activate A', 'dispose A', 'activate B']);
    expect(t.commands.size).toBe(0);
  });
});
