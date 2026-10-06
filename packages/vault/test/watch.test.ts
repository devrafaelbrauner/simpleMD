import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LocalFsProvider, type FsPort, type VaultWatchEvent } from '../src/index';
import { MemoryFsPort } from '../src/testing/index';
import { makeTempVault, type TempVault } from './helpers/tmp';

describe('watch', () => {
  test('memória: eventos externos viram caminhos relativos; itens ocultos são ignorados', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'sub/c.md': 'c', 'a.md': 'a' });
    const provider = new LocalFsProvider(port);
    const handle = await provider.open();
    const events: VaultWatchEvent[] = [];
    const stop = provider.watch(handle, (e) => events.push(e));
    await Promise.resolve();
    port.externalWrite('sub/c.md', 'novo');
    port.externalWrite('.simplemd/config.json', '{}');
    port.touch('a.md');
    port.remove('sub');
    expect(events).toEqual([
      { kind: 'change', paths: ['sub/c.md'] },
      { kind: 'change', paths: ['a.md'] },
      { kind: 'change', paths: ['sub'] },
    ]);
    stop();
    port.externalWrite('a.md', 'depois');
    expect(events).toHaveLength(3);
  });

  test('cancelar antes de a observação começar também a encerra', async () => {
    const unwatch = vi.fn();
    const port = {
      ...new MemoryFsPort(),
      pickDirectory: async () => '/v',
      watch: async () => unwatch,
    } as unknown as FsPort;
    const provider = new LocalFsProvider(port);
    const handle = await provider.open();
    provider.watch(handle, () => {})();
    await Promise.resolve();
    await Promise.resolve();
    expect(unwatch).toHaveBeenCalledOnce();
  });

  test('porta sem watch, ou watch que falha → evento "unavailable" (o app passa a sondar)', async () => {
    const memory = new MemoryFsPort();
    const noWatch: FsPort = {
      pickDirectory: () => memory.pickDirectory(),
      join: (r, p) => memory.join(r, p),
      readDir: (a) => memory.readDir(a),
      lstat: (a) => memory.lstat(a),
      readFile: (a) => memory.readFile(a),
      writeFile: (a, d, m) => memory.writeFile(a, d, m),
      mkdirp: (a) => memory.mkdirp(a),
    };
    const provider = new LocalFsProvider(noWatch);
    const handle = await provider.open();
    const first = Promise.withResolvers<VaultWatchEvent>();
    provider.watch(handle, first.resolve);
    expect((await first.promise).kind).toBe('unavailable');

    const failing = new LocalFsProvider({
      ...noWatch,
      watch: () => Promise.reject(new Error('sem inotify')),
    });
    const second = Promise.withResolvers<VaultWatchEvent>();
    failing.watch(handle, second.resolve);
    expect(await second.promise).toEqual({ kind: 'unavailable', reason: 'sem inotify' });
  });

  describe('Node fs.watch real', () => {
    let vault: TempVault | undefined;
    afterEach(() => {
      vault?.cleanup();
      vault = undefined;
    });

    test('uma escrita externa em a.md chega como evento relativo', async () => {
      vault = await makeTempVault({ 'a.md': 'a' });
      const seen = new Set<string>();
      const stop = vault.provider.watch(vault.handle, (e) => {
        if (e.kind === 'change') e.paths.forEach((p) => seen.add(p));
      });
      await vi.waitFor(
        () => {
          writeFileSync(vault!.abs('a.md'), `x${Date.now()}`);
          expect(seen.has('a.md')).toBe(true);
        },
        { timeout: 8000, interval: 250 },
      );
      stop();
    });
  });
});
