// Observação do vault pelo provider. r36a (AC-R36-1, D-R36-3, D-R36-5): uma observação da porta
// por vault (`handle.id`) repartida entre os ouvintes, `node_modules/` e `.git/` fora dos eventos, e
// falha → `unavailable` para todos, inclusive para quem chega depois.
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LocalFsProvider, type FsPort, type VaultWatchEvent } from '../src/index';
import { MemoryFsPort } from '../src/testing/index';
import { makeTempVault, type TempVault } from './helpers/tmp';

/** A porta em memória sem `watch`, base das portas de teste abaixo. */
function withoutWatch(memory: MemoryFsPort): FsPort {
  return {
    pickDirectory: () => memory.pickDirectory(),
    join: (r, p) => memory.join(r, p),
    readDir: (a) => memory.readDir(a),
    lstat: (a) => memory.lstat(a),
    readFile: (a) => memory.readFile(a),
    writeFile: (a, d, m) => memory.writeFile(a, d, m),
    mkdirp: (a) => memory.mkdirp(a),
  };
}

/**
 * Espera a resposta de cada chamada à `watch` da porta (começou ou falhou). O provider se inscreveu
 * nessas promessas antes, então já reagiu a elas quando esta espera termina.
 */
async function answered(watch: { mock: { results: { value: unknown }[] } }): Promise<void> {
  await Promise.allSettled(watch.mock.results.map((result) => result.value));
}

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
    const noWatch = withoutWatch(new MemoryFsPort());
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

  describe('r36a: uma observação da porta por vault (AC-R36-1, D-R36-5)', () => {
    /** Porta em memória que conta as observações abertas (`watch`) e encerradas (`unwatch`). */
    function counting() {
      const port = new MemoryFsPort();
      port.seed({ 'a.md': 'a' });
      const unwatch = vi.fn();
      const start = port.watch.bind(port);
      const watch = vi.spyOn(port, 'watch').mockImplementation(async (abs, onPaths) => {
        const stop = await start(abs, onPaths);
        return () => {
          unwatch();
          stop();
        };
      });
      return { port, watch, unwatch, provider: new LocalFsProvider(port) };
    }

    const into = (paths: string[]) => (event: VaultWatchEvent) => {
      if (event.kind === 'change') paths.push(...event.paths);
    };

    test('3 ouvintes = 1 port.watch; cada evento chega aos 3; 1 unwatch, quando o último sai', async () => {
      const { port, watch, unwatch, provider } = counting();
      const handle = await provider.open();
      const a: string[] = [];
      const b: string[] = [];
      const c: string[] = [];
      const stopA = provider.watch(handle, into(a));
      const stopB = provider.watch(handle, into(b));
      const stopC = provider.watch(handle, into(c));
      await answered(watch);
      expect(watch).toHaveBeenCalledOnce();
      port.externalWrite('a.md', 'b');
      expect([a, b, c]).toEqual([['a.md'], ['a.md'], ['a.md']]);

      stopA();
      stopB();
      stopB(); // sair de novo não conta
      expect(unwatch).not.toHaveBeenCalled();
      port.externalWrite('a.md', 'c');
      expect([a, b, c]).toEqual([['a.md'], ['a.md'], ['a.md', 'a.md']]);
      stopC();
      expect(unwatch).toHaveBeenCalledOnce();
      port.externalWrite('a.md', 'd');
      expect(c).toEqual(['a.md', 'a.md']);

      // Todos saíram: a próxima inscrição abre outra; outro vault, outra.
      provider.watch(handle, () => {});
      provider.watch(await provider.open(), () => {});
      expect(watch).toHaveBeenCalledTimes(3);
    });

    test('o último sai antes de a observação começar e outro chega: ela fica, sem 2º port.watch', async () => {
      const { port, watch, unwatch, provider } = counting();
      const handle = await provider.open();
      provider.watch(handle, () => {})();
      const seen: string[] = [];
      const stop = provider.watch(handle, into(seen));
      await answered(watch);
      expect(watch).toHaveBeenCalledOnce();
      expect(unwatch).not.toHaveBeenCalled();
      port.externalWrite('a.md', 'b');
      expect(seen).toEqual(['a.md']);
      stop();
      expect(unwatch).toHaveBeenCalledOnce();
    });

    test('node_modules/, .git/ e ocultos não chegam (D-R36-3); o resto do lote chega uma vez', async () => {
      const memory = new MemoryFsPort();
      let emit: (absPaths: string[]) => void = () => {};
      const watch = vi.fn<NonNullable<FsPort['watch']>>(async (_abs, onPaths) => {
        emit = onPaths;
        return () => {};
      });
      const provider = new LocalFsProvider({ ...withoutWatch(memory), watch });
      const handle = await provider.open();
      const events: VaultWatchEvent[] = [];
      provider.watch(handle, (event) => events.push(event));
      await answered(watch);
      const abs = (rels: string[]) => rels.map((rel) => memory.join(handle.root, rel));
      emit(
        abs([
          'node_modules',
          'node_modules/pacote/index.md',
          'notas/node_modules/x.md',
          '.git/HEAD',
          '.git/objects/ab/cdef',
          '.env',
          'notas/.oculto.md',
          'notas/a.md',
          'notas/a.md',
          '.markdownlint.json',
        ]),
      );
      emit(abs(['node_modules/y.md', '.git/index']));
      expect(events).toEqual([{ kind: 'change', paths: ['notas/a.md', '.markdownlint.json'] }]);
    });

    test('falha: os ouvintes de agora e o que chega depois recebem "unavailable"; 1 port.watch', async () => {
      let fail: (reason: string) => void = () => {};
      const watch = vi.fn<NonNullable<FsPort['watch']>>(async (_abs, _onPaths, onError) => {
        fail = onError;
        return () => {};
      });
      const provider = new LocalFsProvider({ ...withoutWatch(new MemoryFsPort()), watch });
      const handle = await provider.open();
      const a: VaultWatchEvent[] = [];
      const b: VaultWatchEvent[] = [];
      provider.watch(handle, (event) => a.push(event));
      provider.watch(handle, (event) => b.push(event));
      await answered(watch);
      fail('observação substituída');
      const unavailable = { kind: 'unavailable', reason: 'observação substituída' };
      expect([a, b]).toEqual([[unavailable], [unavailable]]);
      const late = Promise.withResolvers<VaultWatchEvent>();
      provider.watch(handle, late.resolve);
      expect(await late.promise).toEqual(unavailable);
      expect(watch).toHaveBeenCalledOnce();
    });

    test('a observação não começa: todos e o tardio "unavailable"; quando todos saem, nova tentativa', async () => {
      const watch = vi.fn<NonNullable<FsPort['watch']>>(() =>
        Promise.reject(new Error('sem inotify')),
      );
      const provider = new LocalFsProvider({ ...withoutWatch(new MemoryFsPort()), watch });
      const handle = await provider.open();
      const a: VaultWatchEvent[] = [];
      const stopA = provider.watch(handle, (event) => a.push(event));
      await answered(watch);
      const unavailable = { kind: 'unavailable', reason: 'sem inotify' };
      expect(a).toEqual([unavailable]);
      const late = Promise.withResolvers<VaultWatchEvent>();
      const stopLate = provider.watch(handle, late.resolve);
      expect(await late.promise).toEqual(unavailable);
      expect(watch).toHaveBeenCalledOnce();
      stopA();
      stopLate();
      provider.watch(handle, () => {});
      expect(watch).toHaveBeenCalledTimes(2);
    });
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
