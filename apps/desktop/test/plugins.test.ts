import { ConflictError, LocalFsProvider, sha256Hex, VaultError } from '@simplemd/vault';
import { MemoryFsPort } from '@simplemd/vault/testing';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPluginSettingsPort, createPluginVaultSession } from '../src/plugins/vault-port';
import { AUTOSAVE_DEBOUNCE_MS } from '../src/state/sync';
import { setup } from './helpers';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const TREE = { 'a.md': '# A\n', 'sub/c.md': '# C\n', 'b.txt': 'x', '.oculto/d.md': '# D\n' };

describe('api.vault (R-6.14, R-6.15, AC-6.15)', () => {
  async function session(files: Record<string, string> = TREE, status = () => undefined) {
    const h = await setup(files);
    const handle = h.app.store.getState().handle!;
    const after = vi.fn();
    const vault = createPluginVaultSession({
      provider: h.app.platform.vault,
      handle,
      tabStatus: status,
      afterWrite: after,
    });
    return { h, vault, after };
  }

  test('list = notas .md, relativas, ordenadas, sem ocultos', async () => {
    const { vault } = await session();
    expect(await vault.list()).toEqual(['a.md', 'sub/c.md']);
  });

  test.each(['../x.md', '/abs.md', '.simplemd/config.json', 'x.txt', '.oculto/d.md'])(
    '%s é recusado sem chamar a porta',
    async (path) => {
      const { h, vault } = await session();
      const before = h.port.calls().length;
      await expect(vault.read(path)).rejects.toBeInstanceOf(VaultError);
      await expect(vault.write(path, 'x')).rejects.toBeInstanceOf(VaultError);
      expect(h.port.calls().length).toBe(before);
    },
  );

  test('caminho novo cria; existente nunca lido → ConflictError; lido → grava; mudança externa → ConflictError', async () => {
    const { h, vault, after } = await session();
    await vault.write('sub/nova.md', '# Nova\n');
    expect(h.port.readText('sub/nova.md')).toBe('# Nova\n');
    expect(after).toHaveBeenCalledWith('sub/nova.md', true);
    const sha = () => sha256Hex(new TextEncoder().encode(h.port.readText('a.md') ?? ''));
    const original = sha();
    await expect(vault.write('a.md', 'x')).rejects.toBeInstanceOf(ConflictError);
    expect(sha()).toBe(original);
    await vault.read('a.md');
    h.port.externalWrite('a.md', '# A externo\n');
    await expect(vault.write('a.md', 'x')).rejects.toBeInstanceOf(ConflictError);
    expect(h.port.readText('a.md')).toBe('# A externo\n');
    await vault.read('a.md');
    await vault.write('a.md', '# A do plugin\n');
    expect(h.port.readText('a.md')).toBe('# A do plugin\n');
    expect(after).toHaveBeenCalledWith('a.md', false);
    await expect(vault.write('nao-existe/x.md', 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('aba com edição pendente → ConflictError e buffer intacto', async () => {
    const h = await setup({ 'nota.md': '# Nota\n' });
    await h.app.sync.openFile('nota.md');
    h.type('nota.md', ' editado');
    const vault = createPluginVaultSession({
      provider: h.app.platform.vault,
      handle: h.app.store.getState().handle!,
      tabStatus: (p) => h.app.store.getState().docs[p],
      afterWrite: () => {},
    });
    await vault.read('nota.md');
    await expect(vault.write('nota.md', 'plugin')).rejects.toBeInstanceOf(ConflictError);
    expect(h.text('nota.md')).toBe('# Nota\n editado');
    expect(h.port.readText('nota.md')).toBe('# Nota\n');
  });
});

describe('data.json do plugin (R-6.16, AC-6.16)', () => {
  test('vazio → {}; set grava mantendo chave desconhecida; ilegível nunca é sobrescrito', async () => {
    const port = new MemoryFsPort();
    port.seed({
      '.simplemd/plugins/a.b/manifest.json': '{}',
      '.simplemd/plugins/a.b/data.json': '{"desconhecida":1}',
      '.simplemd/plugins/c.d/data.json': '{ quebrado',
    });
    const provider = new LocalFsProvider(port);
    const handle = await provider.open();
    const warn = vi.fn();
    const settings = createPluginSettingsPort(provider, handle, warn);
    expect(await settings.load('x.y')).toEqual({ values: {}, writable: true });
    expect((await settings.load('a.b')).values).toEqual({ desconhecida: 1 });
    await settings.save('a.b', 'k', { v: 1 });
    expect(JSON.parse(port.readText('.simplemd/plugins/a.b/data.json') ?? '')).toEqual({
      desconhecida: 1,
      k: { v: 1 },
    });
    expect(await settings.load('c.d')).toEqual({ values: {}, writable: false });
    expect(warn).toHaveBeenCalledWith('c.d');
    expect(port.readText('.simplemd/plugins/c.d/data.json')).toBe('{ quebrado');
  });
});

describe('eventos do app (R-6.13, AC-6.14)', () => {
  test('file:open só numa aba nova; file:save no autosave; vault:change na abertura', async () => {
    const h = await setup({ 'nota.md': '# Nota\n', 'b.md': '# B\n' }, { open: false });
    const seen: Array<[string, unknown]> = [];
    h.app.plugins.events.subscribe((evt, payload) => seen.push([evt, payload]));
    await h.app.sync.openVault('welcome');
    await h.settle();
    expect(seen).toContainEqual(['vault:change', { paths: ['b.md', 'nota.md'] }]);
    seen.length = 0;
    await h.app.sync.openFile('nota.md');
    await h.app.sync.openFile('b.md');
    await h.app.sync.openFile('nota.md'); // já aberta: só foca
    expect(seen.filter(([e]) => e === 'file:open').map(([, p]) => p)).toEqual([
      { path: 'nota.md' },
      { path: 'b.md' },
    ]);
    h.type('nota.md', 'x');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(
      seen.some(([e, p]) => e === 'file:save' && (p as { path: string }).path === 'nota.md'),
    ).toBe(true);
  });
});
