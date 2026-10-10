import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createVaultIndex,
  INDEX_MAX_BYTES,
  INDEX_PATH,
  LocalFsProvider,
  type CatalogNoteMeta,
  type IndexedLink,
  type VaultIndex,
} from '../src/index';
import { MemoryFsPort } from '../src/testing/index';
import { testExtractor } from './helpers/extractor';

/**
 * Índice v2 (r7 S2; R-I2.8, AC-I2.8; arch-backend r7 §1.7): links de saída persistidos, migração
 * v1 → v2 = reconstrução única, revalidação quente com 0 leituras de `.md`, teto de 1.000 links,
 * trabalho fatiado e gravações do app.
 */
const meta = (text: string, path: string): CatalogNoteMeta => ({
  title: text.split('\n')[0]?.replace(/^# /, '') || path,
  tags: [],
  date: null,
  fmError: false,
});

/** Cada linha `-> alvo` vira um wikilink; `=> caminho.md` um link `.md` em linha. */
const links = (text: string): IndexedLink[] =>
  text.split('\n').flatMap((line, i): IndexedLink[] => {
    if (line.startsWith('-> '))
      return [{ line: i, column: 0, length: line.length, kind: 'wikilink', target: line.slice(3) }];
    if (line.startsWith('=> '))
      return [{ line: i, column: 0, length: line.length, kind: 'inline', target: line.slice(3) }];
    return [];
  });

const clock = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const mdReads = (port: MemoryFsPort) =>
  port.calls().filter((c) => c.op === 'readFile' && c.abs.endsWith('.md'));
const stored = (port: MemoryFsPort) =>
  JSON.parse(port.readText(INDEX_PATH) ?? 'null') as {
    version: number;
    entries: Record<string, { links: unknown[]; trunc?: string[] }>;
  };

async function open(port: MemoryFsPort, extract = testExtractor(meta, links)): Promise<VaultIndex> {
  const provider = new LocalFsProvider(port);
  const handle = await provider.open();
  const index = createVaultIndex({ provider, handle, extract, clock });
  const started = index.start();
  await vi.advanceTimersByTimeAsync(50);
  await started;
  return index;
}

const entry = (index: VaultIndex, path: string) =>
  index.getSnapshot().entries.find((e) => e.path === path);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const V1 = JSON.stringify({
  version: 1,
  entries: {
    'a.md': { mtime: 1, size: 1, title: 'A', tags: [], date: null, fmError: false },
  },
});

describe('AC-I2.8 índice v2', () => {
  test('índice v1 do 52de38b: uma reconstrução sem erro, grava v2 com links; reabrir faz 0 leituras', async () => {
    const port = new MemoryFsPort();
    port.seed({
      'a.md': '# A\n-> B\n=> pasta/c.md\n',
      'b.md': '# B\n',
      'pasta/c.md': '# C\n',
      [INDEX_PATH]: V1,
    });
    const warn = vi.fn();
    const provider = new LocalFsProvider(port);
    const handle = await provider.open();
    const first = createVaultIndex({
      provider,
      handle,
      extract: testExtractor(meta, links),
      clock,
      warn,
    });
    const started = first.start();
    await vi.advanceTimersByTimeAsync(50);
    await started;
    expect(warn).not.toHaveBeenCalled();
    expect(mdReads(port)).toHaveLength(3);
    expect(entry(first, 'a.md')?.links).toEqual([
      { line: 1, column: 0, length: 4, kind: 'wikilink', target: 'B' },
      { line: 2, column: 0, length: 13, kind: 'inline', target: 'pasta/c.md' },
    ]);
    await first.flush();
    first.dispose();
    const data = stored(port);
    expect(data.version).toBe(2);
    expect(data.entries['a.md']?.links).toEqual([
      [1, 0, 4, 0, 'B'],
      [2, 0, 13, 1, 'pasta/c.md'],
    ]);
    // Reconstrução ÚNICA: a segunda abertura lê o v2 e não relê nenhuma nota.
    port.resetCalls();
    const second = await open(port);
    expect(mdReads(port)).toEqual([]);
    expect(entry(second, 'a.md')?.links.map((l) => l.target)).toEqual(['B', 'pasta/c.md']);
    await second.flush();
    expect(port.calls().filter((c) => c.op === 'writeFile')).toEqual([]);
  });

  test('nota com 1.001 links guarda 1.000 e marca trunc ["links"]; 1.000 exatos não marcam', async () => {
    const port = new MemoryFsPort();
    const many = (n: number) =>
      `# Muitos\n${Array.from({ length: n }, (_, i) => `-> n${i}`).join('\n')}\n`;
    port.seed({ 'muitos.md': many(1001), 'mil.md': many(1000) });
    const index = await open(port);
    expect(entry(index, 'muitos.md')?.links).toHaveLength(1000);
    expect(entry(index, 'muitos.md')?.truncated).toEqual(['links']);
    expect(entry(index, 'mil.md')?.links).toHaveLength(1000);
    expect(entry(index, 'mil.md')?.truncated).toEqual([]);
    await index.flush();
    expect(stored(port).entries['muitos.md']?.trunc).toEqual(['links']);
    expect(stored(port).entries['mil.md']?.trunc).toBeUndefined();
    index.dispose();
    port.resetCalls();
    const again = await open(port);
    expect(mdReads(port)).toEqual([]);
    expect(entry(again, 'muitos.md')?.truncated).toEqual(['links']);
  });

  test.each([
    ['tipo de link desconhecido', [[0, 0, 1, 7, 'x']]],
    ['linha negativa', [[-1, 0, 1, 0, 'x']]],
    ['alvo vazio', [[0, 0, 1, 0, '']]],
    ['caminho .md oculto', [[0, 0, 1, 1, '.oculto/a.md']]],
    ['tupla curta', [[0, 0, 1, 0]]],
  ])('%s → índice inteiro ignorado e refeito', async (_label, bad) => {
    const port = new MemoryFsPort();
    const text = JSON.stringify({
      version: 2,
      entries: {
        'a.md': { mtime: 1, size: 1, title: 'A', tags: [], date: null, fmError: false, links: bad },
      },
    });
    port.seed({ 'a.md': '# A\n', [INDEX_PATH]: text });
    const index = await open(port);
    expect(mdReads(port)).toHaveLength(1);
    expect(entry(index, 'a.md')?.links).toEqual([]);
  });

  test('trunc inválido (campo desconhecido, vazio, repetido) invalida o índice', async () => {
    for (const trunc of [['tasks'], [], ['links', 'links']]) {
      const port = new MemoryFsPort();
      const base = { mtime: 1, size: 1, title: 'A', tags: [], date: null, fmError: false };
      port.seed({
        'a.md': '# A\n',
        [INDEX_PATH]: JSON.stringify({
          version: 2,
          entries: { 'a.md': { ...base, links: [], trunc } },
        }),
      });
      await open(port);
      expect(mdReads(port)).toHaveLength(1);
    }
  });

  test('links que o esquema recusaria são filtrados na extração (o arquivo continua válido)', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'a.md': '# A\n=> .oculto/x.md\n=> ok.md\n' });
    const index = await open(port);
    expect(entry(index, 'a.md')?.links.map((l) => l.target)).toEqual(['ok.md']);
  });
});

describe('trabalho fatiado e gravações do app (arch-backend r7 §1.7.5)', () => {
  test('nota grande cede a vez entre fatias (3 passos) e entra no fim', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'a.md': '# A\n-> B\n' });
    const extract = testExtractor(meta, links, 3);
    const index = await open(port, extract);
    expect(extract.steps).toEqual(['a.md', 'a.md', 'a.md']);
    expect(entry(index, 'a.md')?.links).toHaveLength(1);
  });

  test('applySaved: metadados na hora, links depois do trabalho; save mais novo substitui o pendente', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'a.md': '# A\n', 'b.md': '# B\n' });
    const extract = testExtractor(meta, links, 2);
    const index = await open(port, extract);
    port.resetCalls();
    index.applySaved('a.md', '# A2\n-> B\n', 10);
    expect(entry(index, 'a.md')?.title).toBe('A2');
    expect(entry(index, 'a.md')?.links).toEqual([]);
    index.applySaved('a.md', '# A3\n-> B\n-> C\n', 11);
    await vi.advanceTimersByTimeAsync(10);
    expect(entry(index, 'a.md')?.title).toBe('A3');
    expect(entry(index, 'a.md')?.links.map((l) => l.target)).toEqual(['B', 'C']);
    expect(mdReads(port)).toEqual([]);
  });

  test('applySaved depois de dispose não publica links', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'a.md': '# A\n' });
    const index = await open(port, testExtractor(meta, links, 2));
    index.applySaved('a.md', '# A\n-> X\n', 5);
    index.dispose();
    await vi.advanceTimersByTimeAsync(10);
    expect(entry(index, 'a.md')?.links).toEqual([]);
  });

  // CR-S2-01 (sonda do revisor): salvar → fechar logo em seguida, com trabalhos de 3 fatias: o de
  // a.md em andamento (1ª fatia já rodou) e o de b.md ainda na fila.
  test('flush logo depois de salvar persiste os links novos (em andamento e na fila); reabrir quente lê 0 .md', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'a.md': '# A\n', 'b.md': '# B\n' });
    const index = await open(port, testExtractor(meta, links, 3));
    await index.flush();
    const saved: Record<string, number> = {};
    for (const [path, text] of [
      ['a.md', '# A\n-> B\n'],
      ['b.md', '# B\n=> a.md\n'],
    ] as const) {
      await port.writeFile(`/vault/${path}`, new TextEncoder().encode(text), 'overwrite');
      saved[path] = (await port.lstat(`/vault/${path}`))?.mtime ?? -1;
      index.applySaved(path, text, saved[path]);
    }
    await index.flush();
    index.dispose();
    expect(stored(port).entries).toMatchObject({
      'a.md': { mtime: saved['a.md'], links: [[1, 0, 4, 0, 'B']] },
      'b.md': { mtime: saved['b.md'], links: [[1, 0, 7, 1, 'a.md']] },
    });
    port.resetCalls();
    const reopened = await open(port, testExtractor(meta, links, 3));
    expect(entry(reopened, 'a.md')?.links.map((l) => l.target)).toEqual(['B']);
    expect(entry(reopened, 'b.md')?.links.map((l) => l.target)).toEqual(['a.md']);
    expect(mdReads(port)).toEqual([]);
  });

  test('o trabalho drenado pelo flush não aplica de novo; um save mais novo continua valendo', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'a.md': '# A\n' });
    const extract = testExtractor(meta, links, 3);
    const index = await open(port, extract);
    index.applySaved('a.md', '# A\n-> B\n', 10);
    await index.flush();
    expect(entry(index, 'a.md')?.links.map((l) => l.target)).toEqual(['B']);
    index.applySaved('a.md', '# A\n-> C\n', 11);
    await vi.advanceTimersByTimeAsync(20);
    expect(entry(index, 'a.md')?.links.map((l) => l.target)).toEqual(['C']);
  });
});

describe('CR-S2-08 — índice acima do teto de leitura (D-R7-B15: grava mesmo assim)', () => {
  test('serializado > INDEX_MAX_BYTES → grava (r2) e registra o aviso de diagnóstico', async () => {
    // Notas pequenas; o extrator de teste devolve 1.000 links de 1.000 caracteres por nota
    // (23 notas ≈ 23 MB serializados) sem ler nem varrer megabytes de texto.
    const port = new MemoryFsPort();
    const files: Record<string, string> = {};
    for (let i = 0; i < 23; i++) files[`n${i}.md`] = `# N${i}\n`;
    port.seed(files);
    const many: IndexedLink[] = Array.from({ length: 1000 }, (_, line) => ({
      line,
      column: 0,
      length: 1004,
      kind: 'wikilink',
      target: 't'.repeat(1000),
    }));
    const provider = new LocalFsProvider(port);
    const handle = await provider.open();
    const warn = vi.fn();
    const extract = testExtractor(meta, () => many);
    const index = createVaultIndex({ provider, handle, extract, clock, warn });
    const started = index.start();
    await vi.advanceTimersByTimeAsync(50);
    await started;
    await index.flush();
    const bytes = new TextEncoder().encode(port.readText(INDEX_PATH) ?? '').length;
    expect(bytes).toBeGreaterThan(INDEX_MAX_BYTES);
    expect(warn).toHaveBeenCalledWith(
      'índice: maior que o teto de leitura; será refeito a cada abertura',
      { bytes },
    );
  }, 30_000);
});

describe('listFailed (painel "Links" em erro; D-R7-S2-03b)', () => {
  test('listagem falha → snapshot com listFailed; revalidação bem-sucedida limpa', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'a.md': '# A\n' });
    const provider = new LocalFsProvider(port);
    const handle = await provider.open();
    const spy = vi.spyOn(provider, 'listNotes').mockRejectedValueOnce(new Error('falhou'));
    const index = createVaultIndex({
      provider,
      handle,
      extract: testExtractor(meta, links),
      clock,
    });
    const started = index.start();
    await vi.advanceTimersByTimeAsync(20);
    await started;
    expect(index.getSnapshot().listFailed).toBe(true);
    spy.mockRejectedValueOnce(new Error('de novo'));
    const again = index.revalidate();
    await vi.advanceTimersByTimeAsync(20);
    await again;
    expect(index.getSnapshot().listFailed).toBe(true);
    const ok = index.revalidate();
    await vi.advanceTimersByTimeAsync(20);
    await ok;
    expect(index.getSnapshot().listFailed).toBeUndefined();
    expect(index.getSnapshot().entries.map((e) => e.path)).toEqual(['a.md']);
  });
});
