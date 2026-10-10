import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createVaultIndex,
  INDEX_PATH,
  LocalFsProvider,
  type CatalogNoteMeta,
  type VaultIndex,
} from '../src/index';
import { MemoryFsPort } from '../src/testing/index';
import { testExtractor } from './helpers/extractor';
import { makeTempVault } from './helpers/tmp';

/**
 * Índice do vault (R-9.7; AC-9.3, AC-9.7, AC-9.8; decisão B do pai). O extrator real (core) entra
 * nos testes do desktop; aqui um extrator simples basta: título = `title:` ou `# `, tags = `tags:`.
 */
function fakeExtract(text: string, path: string): CatalogNoteMeta {
  const line = (prefix: string) =>
    text
      .split('\n')
      .find((l) => l.startsWith(prefix))
      ?.slice(prefix.length)
      .trim();
  return {
    title: line('title:') ?? line('# ') ?? path.slice(path.lastIndexOf('/') + 1, -3),
    tags: (line('tags:') ?? '').split(',').filter(Boolean),
    date: line('date:') ?? null,
    fmError: text.includes('ERRO'),
  };
}

const SENTINEL = 'CORPO-SENTINELA-9F3A';
const clock = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function notes(count: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const folder = `pasta-${String(i % 20).padStart(2, '0')}`;
    files[`${folder}/nota-${i}.md`] =
      `title: Nota ${i}\ntags: t${i % 5}\n\n${SENTINEL} corpo ${i}\n`;
  }
  return files;
}

const mdReads = (port: MemoryFsPort) =>
  port.calls().filter((c) => c.op === 'readFile' && c.abs.endsWith('.md'));
const writes = (port: MemoryFsPort) => port.calls().filter((c) => c.op === 'writeFile');

async function open(port: MemoryFsPort): Promise<{ index: VaultIndex; provider: LocalFsProvider }> {
  const provider = new LocalFsProvider(port);
  const handle = await provider.open();
  const index = createVaultIndex({ provider, handle, extract: testExtractor(fakeExtract), clock });
  const started = index.start();
  await vi.advanceTimersByTimeAsync(20);
  await started;
  return { index, provider };
}

const stored = (port: MemoryFsPort) =>
  JSON.parse(port.readText(INDEX_PATH) ?? 'null') as {
    version: number;
    entries: Record<string, Record<string, unknown>>;
  };
const titles = (index: VaultIndex) =>
  Object.fromEntries(index.getSnapshot().entries.map((e) => [e.path, e.title]));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('AC-9.7 esquema e só metadados', () => {
  test('version 2 (r7 D-R7-B08), campos do R-9.7 + links, sentinela do corpo 0 vezes; escrita 2 s depois', async () => {
    const port = new MemoryFsPort();
    port.seed(notes(40));
    const { index } = await open(port);
    expect(index.getSnapshot()).toMatchObject({ status: 'ready', done: 40, total: 40 });
    expect(port.readText(INDEX_PATH)).toBeNull();
    // `open` já avançou 20 ms do relógio falso depois de agendar a escrita.
    await vi.advanceTimersByTimeAsync(1900);
    expect(port.readText(INDEX_PATH)).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    const text = port.readText(INDEX_PATH) ?? '';
    const data = stored(port);
    expect(data.version).toBe(2);
    expect(Object.keys(data.entries)).toHaveLength(40);
    for (const entry of Object.values(data.entries))
      expect(Object.keys(entry)).toEqual([
        'mtime',
        'size',
        'title',
        'tags',
        'date',
        'fmError',
        'links',
      ]);
    expect(data.entries['pasta-01/nota-1.md']).toMatchObject({ title: 'Nota 1', tags: ['t1'] });
    expect(text.split(SENTINEL)).toHaveLength(1);
    // Caminhos em ordem estável; criado só-criação, com a pasta .simplemd.
    expect(Object.keys(data.entries)).toEqual(Object.keys(data.entries).sort());
    expect(writes(port).map((c) => c.mode)).toEqual(['create-new']);
  });
});

describe('AC-9.8 incremental e recuperação', () => {
  async function warm(count = 60) {
    const port = new MemoryFsPort();
    port.seed(notes(count));
    const first = await open(port);
    await first.index.flush();
    first.index.dispose();
    port.resetCalls();
    return port;
  }

  test('índice quente: 0 leituras de .md; tocar 1 → exatamente 1 leitura; apagar e criar', async () => {
    const port = await warm();
    const again = await open(port);
    expect(mdReads(port)).toEqual([]);
    expect(port.calls().filter((c) => c.op === 'readDir')).toHaveLength(21);
    again.index.dispose();

    port.touch('pasta-03/nota-3.md');
    port.remove('pasta-04/nota-4.md');
    port.seed({ 'nova/criada.md': '# Criada\n' });
    port.resetCalls();
    const third = await open(port);
    expect(mdReads(port).map((c) => c.abs)).toEqual([
      '/vault/pasta-03/nota-3.md',
      '/vault/nova/criada.md',
    ]);
    const all = titles(third.index);
    expect(all['pasta-04/nota-4.md']).toBeUndefined();
    expect(all['nova/criada.md']).toBe('Criada');
    expect(Object.keys(all)).toHaveLength(60);
    // Só mtime mudou (nota-3) não é mudança de metadados; a remoção e a criação são.
    await vi.advanceTimersByTimeAsync(2000);
    expect(Object.keys(stored(port).entries)).toHaveLength(60);
  });

  test.each([
    ['corrompido', '{"version":2,"entries":'],
    ['version 99', '{"version":99,"entries":{}}'],
    ['entrada fora do esquema', '{"version":2,"entries":{"a.md":{"mtime":1}}}'],
    [
      'caminho oculto',
      '{"version":2,"entries":{".x/a.md":{"mtime":1,"size":1,"title":"","tags":[],"date":null,"fmError":false,"links":[]}}}',
    ],
    [
      'v1 do r2 (52de38b) válido → reconstrução única (AC-I2.8)',
      '{"version":1,"entries":{"a.md":{"mtime":1,"size":1,"title":"","tags":[],"date":null,"fmError":false}}}',
    ],
    ['raiz lista', '[]'],
  ])(
    '%s → ignorado e refeito sem erro bloqueante, regravado sobre a base lida',
    async (_l, bad) => {
      const port = new MemoryFsPort();
      port.seed({ ...notes(10), [INDEX_PATH]: bad });
      const { index } = await open(port);
      expect(index.getSnapshot().entries).toHaveLength(10);
      await vi.advanceTimersByTimeAsync(2000);
      expect(stored(port).version).toBe(2);
      expect(writes(port).map((c) => c.mode)).toEqual(['overwrite']);
    },
  );

  test('21 MB: não é lido (só stat), refeito em memória e não regravado nesta sessão', async () => {
    const port = new MemoryFsPort();
    port.seed({ ...notes(5), [INDEX_PATH]: ' '.repeat(21 * 1024 * 1024) });
    const { index } = await open(port);
    expect(port.calls().filter((c) => c.op === 'readFile' && c.abs.endsWith('index.json'))).toEqual(
      [],
    );
    expect(index.getSnapshot().entries).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(5000);
    await index.flush();
    expect(writes(port)).toEqual([]);
  });

  test('gravação do app: entrada atualizada com 0 leituras; grava só se os metadados mudaram', async () => {
    const port = await warm(10);
    const { index } = await open(port);
    port.resetCalls();
    // Só o corpo e o mtime mudam: nada é regravado (decisão B).
    index.applySaved('pasta-01/nota-1.md', 'title: Nota 1\ntags: t1\n\noutro corpo\n', 9e12);
    await vi.advanceTimersByTimeAsync(5000);
    expect(port.calls()).toEqual([]);
    expect(index.getSnapshot().entries.find((e) => e.path === 'pasta-01/nota-1.md')?.mtime).toBe(
      9e12,
    );
    index.applySaved('pasta-01/nota-1.md', 'title: Renomeada\n', 9e12 + 1);
    expect(titles(index)['pasta-01/nota-1.md']).toBe('Renomeada');
    await vi.advanceTimersByTimeAsync(2000);
    expect(mdReads(port)).toEqual([]);
    expect(writes(port).map((c) => c.abs)).toEqual([`/vault/${INDEX_PATH}`]);
    expect(stored(port).entries['pasta-01/nota-1.md']).toMatchObject({ title: 'Renomeada' });
    // Ignora caminhos fora do esquema.
    index.applySaved('.oculto/x.md', 'x', 1);
    expect(titles(index)['.oculto/x.md']).toBeUndefined();
  });

  test('mudanças externas: stat por caminho, releitura só do que mudou, pasta removida', async () => {
    const port = new MemoryFsPort();
    port.seed(notes(40));
    const { index } = await open(port);
    port.resetCalls();
    port.externalWrite('pasta-02/nota-2.md', 'title: De fora\n');
    port.remove('pasta-03');
    await index.applyChanges(['pasta-02/nota-2.md', 'pasta-03', 'pasta-05/nota-5.md', 'b.txt']);
    expect(mdReads(port).map((c) => c.abs)).toEqual(['/vault/pasta-02/nota-2.md']);
    expect(port.calls().filter((c) => c.op === 'readDir')).toEqual([]);
    const all = titles(index);
    expect(all['pasta-02/nota-2.md']).toBe('De fora');
    expect(Object.keys(all).some((p) => p.startsWith('pasta-03/'))).toBe(false);
    port.remove('pasta-05/nota-5.md');
    await index.applyChanges(['pasta-05/nota-5.md']);
    expect(titles(index)['pasta-05/nota-5.md']).toBeUndefined();
  });

  test('conflito: outro aparelho trocou o índice → a versão nova vira base e o app grava de novo', async () => {
    const port = await warm(5);
    const { index } = await open(port);
    port.externalWrite(INDEX_PATH, '{"version":2,"entries":{}}');
    index.applySaved('pasta-00/nota-0.md', 'title: Depois do conflito\n', 5e12);
    await vi.advanceTimersByTimeAsync(2000);
    await index.flush();
    expect(stored(port).entries['pasta-00/nota-0.md']).toMatchObject({
      title: 'Depois do conflito',
    });
  });

  test('nota > 2 MB não é lida; não UTF-8 entra pelo nome; dispose impede gravação', async () => {
    const port = new MemoryFsPort();
    port.seed({
      'grande.md': `# Grande\n${'x'.repeat(2 * 1024 * 1024)}`,
      'latin1.md': new Uint8Array([0x23, 0x20, 0xe9, 0x0a]),
      'ok.md': '# Ok\n',
    });
    const { index } = await open(port);
    expect(
      mdReads(port)
        .map((c) => c.abs)
        .sort(),
    ).toEqual(['/vault/latin1.md', '/vault/ok.md']);
    expect(titles(index)).toEqual({ 'grande.md': 'grande', 'latin1.md': 'latin1', 'ok.md': 'Ok' });
    index.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes(port)).toEqual([]);
    index.applySaved('ok.md', '# Outro\n', 1);
    await index.applyChanges(['ok.md']);
    expect(writes(port)).toEqual([]);
  });

  test('mudança durante a construção é aplicada no fim; progresso e assinantes', async () => {
    const port = new MemoryFsPort();
    port.seed(notes(80));
    const provider = new LocalFsProvider(port);
    const handle = await provider.open();
    const index = createVaultIndex({
      provider,
      handle,
      extract: testExtractor(fakeExtract),
      clock,
    });
    const seen: string[] = [];
    const off = index.subscribe(() => {
      const s = index.getSnapshot();
      seen.push(`${s.status}:${s.done}/${s.total}`);
    });
    const started = index.start();
    await index.applyChanges(['pasta-00/nota-0.md']);
    port.externalWrite('pasta-00/nota-0.md', 'title: Mudou no meio\n');
    await vi.advanceTimersByTimeAsync(50);
    await started;
    off();
    expect(seen[0]).toBe('building:0/80');
    expect(seen).toContain('building:25/80');
    expect(seen.at(-1)).toBe('ready:80/80');
    expect(titles(index)['pasta-00/nota-0.md']).toBe('Mudou no meio');
  });
});

describe('AC-9.3 regra 1: o índice nunca grava um .md', () => {
  test('construção + revalidação de 400 notas: toda escrita é o index.json; bytes e mtime iguais', async () => {
    const port = new MemoryFsPort();
    port.seed(notes(400));
    const before = new Map(Object.keys(notes(400)).map((p) => [p, port.readText(p)]));
    const mtimes = await new LocalFsProvider(port).listNotes(
      await new LocalFsProvider(port).open(),
    );
    const first = await open(port);
    await first.index.flush();
    first.index.dispose();
    port.touch('pasta-00/nota-0.md');
    const second = await open(port);
    await second.index.flush();
    const targets = new Set(writes(port).map((c) => c.abs));
    expect([...targets]).toEqual([`/vault/${INDEX_PATH}`]);
    for (const [path, text] of before) expect(port.readText(path)).toBe(text);
    const after = await new LocalFsProvider(port).listNotes(await new LocalFsProvider(port).open());
    const changed = after.filter((n) => mtimes.find((m) => m.path === n.path)?.mtime !== n.mtime);
    expect(changed.map((n) => n.path)).toEqual(['pasta-00/nota-0.md']); // só o touch externo
  });
});

describe('listNotes', () => {
  test('porta Node (sem stat na listagem): lstat por arquivo; ocultos e não-.md fora', async () => {
    vi.useRealTimers();
    const vault = await makeTempVault({
      'a.md': 'abc',
      'sub/b.md': 'b',
      'sub/c.txt': 'c',
      '.oculto/d.md': 'd',
      '.simplemd/index.json': '{}',
    });
    try {
      const listed = await vault.provider.listNotes(vault.handle);
      expect(listed.map((n) => [n.path, n.size]).sort()).toEqual([
        ['a.md', 3],
        ['sub/b.md', 1],
      ]);
      expect(listed.every((n) => Number.isInteger(n.mtime) && n.mtime > 0)).toBe(true);
    } finally {
      vault.cleanup();
    }
  });
});
