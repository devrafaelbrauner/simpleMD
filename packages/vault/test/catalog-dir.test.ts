// CR2-03 (R-IDX1 da revisão r2): uma pasta movida ou renomeada para dentro do vault chega do
// observador como um único caminho (FSEvents/ReadDirectoryChangesW); as notas dela entram no
// catálogo. Sem observador (sondagem), `revalidate` relista e indexa as notas novas.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createVaultIndex, LocalFsProvider, type VaultIndex } from '../src/index';
import { testExtractor } from './helpers/extractor';
import { MemoryFsPort } from '../src/testing/index';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

async function started(files: Record<string, string>) {
  const port = new MemoryFsPort();
  port.seed(files);
  const provider = new LocalFsProvider(port);
  const handle = await provider.open();
  const index = createVaultIndex({
    provider,
    handle,
    extract: testExtractor((text, path) => ({
      title: text.split('\n')[0] || path,
      tags: [],
      date: null,
      fmError: false,
    })),
    clock: {
      setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
      clearTimeout: (h: unknown) => clearTimeout(h as number),
    },
  });
  const run = index.start();
  await vi.advanceTimersByTimeAsync(20);
  await run;
  return { port, index };
}

const paths = (index: VaultIndex) =>
  index
    .getSnapshot()
    .entries.map((e) => e.path)
    .sort();

/** Deixa as fatias (pausas de 0 ms) andarem. */
async function settle(work: Promise<void>) {
  await vi.advanceTimersByTimeAsync(20);
  await work;
}

test('R-IDX1: as notas de uma pasta que aparece como um único caminho são indexadas', async () => {
  const { port, index } = await started({ 'a.md': '# A\n' });
  port.externalWrite('movida/b.md', '# B\n');
  port.externalWrite('movida/sub/c.md', '# C\n');
  port.externalWrite('movida/.oculta/d.md', '# D\n');
  await settle(index.applyChanges(['movida']));
  expect(paths(index)).toEqual(['a.md', 'movida/b.md', 'movida/sub/c.md']);
  expect(index.getSnapshot().entries.find((e) => e.path === 'movida/b.md')?.title).toBe('# B');
});

test('pasta renomeada: as notas saem do nome antigo e entram no novo', async () => {
  const { port, index } = await started({ 'a.md': '# A\n', 'velha/b.md': '# B\n' });
  expect(paths(index)).toEqual(['a.md', 'velha/b.md']);
  port.remove('velha');
  port.externalWrite('nova/b.md', '# B\n');
  await settle(index.applyChanges(['nova', 'velha']));
  expect(paths(index)).toEqual(['a.md', 'nova/b.md']);
});

test('sondagem: revalidate indexa notas novas e tira as removidas, sem reler as iguais', async () => {
  const { port, index } = await started({ 'a.md': '# A\n', 'x.md': '# X\n' });
  port.externalWrite('pasta/nova.md', '# Nova\n');
  port.remove('x.md');
  port.resetCalls();
  await settle(index.revalidate());
  expect(paths(index)).toEqual(['a.md', 'pasta/nova.md']);
  const reads = port.calls().filter((c) => c.op === 'readFile' && c.abs.endsWith('.md'));
  expect(reads.map((c) => c.abs)).toEqual(['/vault/pasta/nova.md']);
});
