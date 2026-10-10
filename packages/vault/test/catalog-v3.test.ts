import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createVaultIndex,
  INDEX_PATH,
  LocalFsProvider,
  propertiesFrom,
  type CatalogNoteMeta,
  type IndexedTask,
  type NoteIndexData,
  type VaultIndex,
} from '../src/index';
import { parseIndex, serializeIndex } from '../src/catalog/schema';
import { MemoryFsPort } from '../src/testing/index';
import { testExtractor } from './helpers/extractor';

/**
 * Índice v3 (r7 S9; R-I9.3, AC-I2.8 reexecutado; arch-backend r7 §1.7): tarefas, propriedades e
 * tags do corpo persistidas em tuplas compactas; v1/v2 → reconstrução única; revalidação quente
 * com 0 leituras de `.md`; tetos; tuplas fora do formato invalidam o arquivo inteiro.
 */
const meta = (text: string, path: string): CatalogNoteMeta => ({
  title: text.split('\n')[0]?.replace(/^# /, '') || path,
  tags: [],
  date: null,
  fmError: false,
});

const task = (line: number, over: Partial<IndexedTask> = {}): IndexedTask => ({
  line,
  status: ' ',
  text: `t${line}`,
  priority: 2,
  tags: [],
  invalid: [],
  ...over,
});

/** Linhas `- [s] texto` viram tarefas; `p chave=valor` propriedades; `#x` sozinha uma itag. */
const data = (text: string): Partial<NoteIndexData> => {
  const tasks: IndexedTask[] = [];
  const props: [string, string][] = [];
  const itags: string[] = [];
  text.split('\n').forEach((line, i) => {
    const m = /^- \[(.)\] (.*)$/.exec(line);
    if (m) tasks.push(task(i, { status: m[1] as string, text: m[2] as string }));
    const p = /^p (\S+)=(.*)$/.exec(line);
    if (p) props.push([p[1] as string, p[2] as string]);
    if (/^#\S+$/.test(line)) itags.push(line);
  });
  return { tasks, properties: propertiesFrom(props), inlineTags: itags };
};

const clock = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const mdReads = (port: MemoryFsPort) =>
  port.calls().filter((c) => c.op === 'readFile' && c.abs.endsWith('.md'));
const stored = (port: MemoryFsPort) =>
  JSON.parse(port.readText(INDEX_PATH) ?? 'null') as {
    version: number;
    entries: Record<string, Record<string, unknown>>;
  };

async function open(
  port: MemoryFsPort,
  extract = testExtractor(meta, () => [], 1, data),
): Promise<VaultIndex> {
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

const BASE = { mtime: 1, size: 1, title: 'A', tags: [], date: null, fmError: false, links: [] };
const V2 = JSON.stringify({ version: 2, entries: { 'a.md': BASE } });

describe('índice v3 (R-I9.3; migração v2 → v3)', () => {
  test('v2 do S2: uma reconstrução, grava v3 compacto; reabrir faz 0 leituras e devolve o mesmo', async () => {
    const port = new MemoryFsPort();
    port.seed({
      'a.md': '# A\n- [ ] comprar\n- [x] feito\np tipo=projeto\n#ideia\n',
      'b.md': '# B\n',
      [INDEX_PATH]: V2,
    });
    const first = await open(port);
    expect(mdReads(port)).toHaveLength(2);
    await first.flush();
    const before = entry(first, 'a.md');
    first.dispose();
    const saved = stored(port);
    expect(saved.version).toBe(3);
    expect(saved.entries['a.md']).toMatchObject({
      tasks: [
        [1, ' ', 'comprar'],
        [2, 'x', 'feito'],
      ],
      props: { tipo: 'projeto' },
      itags: ['#ideia'],
    });
    // Nota sem tarefas/propriedades/tags: os campos não são gravados.
    expect(Object.keys(saved.entries['b.md'] ?? {}).sort()).toEqual(
      ['date', 'fmError', 'links', 'mtime', 'size', 'tags', 'title'].sort(),
    );
    port.resetCalls();
    const second = await open(port);
    expect(mdReads(port)).toEqual([]);
    const after = entry(second, 'a.md');
    expect(after?.tasks).toEqual(before?.tasks);
    expect({ ...after?.properties }).toEqual({ tipo: 'projeto' });
    expect(after?.inlineTags).toEqual(['#ideia']);
    await second.flush();
    expect(port.calls().filter((c) => c.op === 'writeFile')).toEqual([]);
  });

  test('versão desconhecida (4) → reconstrução', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'a.md': '# A\n', [INDEX_PATH]: JSON.stringify({ version: 4, entries: {} }) });
    await open(port);
    expect(mdReads(port)).toHaveLength(1);
  });

  test('todos os campos da tarefa fazem a volta pelo arquivo', () => {
    const full = task(3, {
      status: '/',
      text: 'tudo #a',
      due: '2026-10-12',
      scheduled: '2026-10-11',
      start: '2026-10-01',
      created: '2026-09-30',
      done: '2026-10-13',
      cancelled: '2026-10-14',
      priority: 5,
      recurrence: 'every week',
      tags: ['#a'],
    });
    const invalid = task(4, { invalid: ['due', 'start'], priority: 0 });
    const map = new Map([
      [
        'a.md',
        {
          path: 'a.md',
          ...BASE,
          tasks: [full, invalid],
          properties: propertiesFrom([['n', [1, 'b', true, null]]]),
          inlineTags: [],
          truncated: [],
        },
      ],
    ]);
    const text = serializeIndex(map);
    expect(JSON.parse(text).entries['a.md'].tasks).toEqual([
      [
        3,
        '/',
        'tudo #a',
        {
          due: '2026-10-12',
          sch: '2026-10-11',
          st: '2026-10-01',
          cr: '2026-09-30',
          dn: '2026-10-13',
          cx: '2026-10-14',
          pr: 5,
          rec: 'every week',
          g: ['#a'],
        },
      ],
      [4, ' ', 't4', { pr: 0, inv: ['due', 'st'] }],
    ]);
    const back = parseIndex(text)!.get('a.md')!;
    expect(back.tasks).toEqual([full, invalid]);
    expect({ ...back.properties }).toEqual({ n: [1, 'b', true, null] });
  });

  test('2.001 tarefas → 2.000 + trunc "tasks"; descrição e regra cortadas no teto', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'muitas.md': '# M\n' });
    const extract = testExtractor(meta, () => [], 1, () => ({
      tasks: Array.from({ length: 2001 }, (_, i) =>
        task(i, i === 0 ? { text: 'x'.repeat(1200), recurrence: 'r'.repeat(300) } : {}),
      ),
    }));
    const index = await open(port, extract);
    const e = entry(index, 'muitas.md')!;
    expect(e.tasks).toHaveLength(2000);
    expect(e.truncated).toEqual(['tasks']);
    expect(e.tasks[0]?.text).toHaveLength(1000);
    expect(e.tasks[0]?.recurrence).toHaveLength(200);
    await index.flush();
    expect(stored(port).entries['muitas.md']?.trunc).toEqual(['tasks']);
  });

  test('propriedades: 101 chaves → 100; valor > 1 KiB ou chave longa saem; __proto__ é dado', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'p.md': '# P\n' });
    const props: [string, unknown][] = Array.from({ length: 101 }, (_, i) => [`k${i}`, i]);
    props.unshift(['__proto__', 'dado'], ['grande', 'é'.repeat(600)], ['k'.repeat(201), 1]);
    const extract = testExtractor(meta, () => [], 1, () => ({
      properties: propertiesFrom(props as [string, string][]),
      inlineTags: Array.from({ length: 101 }, (_, i) => `#t${i}`),
    }));
    const index = await open(port, extract);
    const e = entry(index, 'p.md')!;
    expect(Object.keys(e.properties)).toHaveLength(100);
    expect(e.properties.__proto__).toBe('dado');
    expect(Object.getPrototypeOf(e.properties)).toBeNull();
    expect(Object.keys(e.properties)).not.toContain('grande');
    expect(e.inlineTags).toHaveLength(100);
    expect(e.truncated).toEqual(['props', 'itags']);
    await index.flush();
    index.dispose();
    // Relido do disco: o protótipo continua intacto e `__proto__` volta como dado.
    port.resetCalls();
    const again = await open(port);
    expect(mdReads(port)).toEqual([]);
    expect(entry(again, 'p.md')?.properties.__proto__).toBe('dado');
    expect(({} as Record<string, unknown>).dado).toBeUndefined();
  });

  test('applySaved mantém tarefas/propriedades anteriores até o trabalho terminar', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'a.md': '# A\n- [ ] velha\n' });
    const index = await open(port, testExtractor(meta, () => [], 2, data));
    index.applySaved('a.md', '# A2\n- [ ] nova\n', 10);
    expect(entry(index, 'a.md')?.title).toBe('A2');
    expect(entry(index, 'a.md')?.tasks.map((t) => t.text)).toEqual(['velha']);
    await vi.advanceTimersByTimeAsync(50);
    expect(entry(index, 'a.md')?.tasks.map((t) => t.text)).toEqual(['nova']);
  });

  const bad: Array<[string, Record<string, unknown>]> = [
    ['tarefas vazias', { tasks: [] }],
    ['tupla de tarefa curta', { tasks: [[1, ' ']] }],
    ['estado com 2 caracteres', { tasks: [[1, 'xx', 'a']] }],
    ['linha negativa', { tasks: [[-1, ' ', 'a']] }],
    ['descrição > 1.000', { tasks: [[1, ' ', 'x'.repeat(1001)]] }],
    ['campo desconhecido', { tasks: [[1, ' ', 'a', { zz: 1 }]] }],
    ['campos não objeto', { tasks: [[1, ' ', 'a', [1]]] }],
    ['data fora do formato', { tasks: [[1, ' ', 'a', { due: '12/10/2026' }]] }],
    ['prioridade 2 gravada', { tasks: [[1, ' ', 'a', { pr: 2 }]] }],
    ['prioridade 6', { tasks: [[1, ' ', 'a', { pr: 6 }]] }],
    ['regra vazia', { tasks: [[1, ' ', 'a', { rec: '' }]] }],
    ['tags vazias', { tasks: [[1, ' ', 'a', { g: [] }]] }],
    ['inválido desconhecido', { tasks: [[1, ' ', 'a', { inv: ['constructor'] }]] }],
    ['inválido com data válida', { tasks: [[1, ' ', 'a', { due: '2026-10-12', inv: ['due'] }]] }],
    ['inválido repetido', { tasks: [[1, ' ', 'a', { inv: ['due', 'due'] }]] }],
    ['props vazias', { props: {} }],
    ['props lista', { props: [] }],
    ['prop objeto aninhado', { props: { a: { b: 1 } } }],
    ['prop lista com objeto', { props: { a: [{ b: 1 }] } }],
    ['prop > 1 KiB', { props: { a: 'x'.repeat(1100) } }],
    ['itag sem #', { itags: ['ideia'] }],
    ['itags vazias', { itags: [] }],
    ['trunc desconhecido', { trunc: ['nope'] }],
  ];

  test.each(bad)('%s → índice inteiro ignorado e refeito', async (_label, extra) => {
    const port = new MemoryFsPort();
    port.seed({
      'a.md': '# A\n',
      [INDEX_PATH]: JSON.stringify({ version: 3, entries: { 'a.md': { ...BASE, ...extra } } }),
    });
    await open(port);
    expect(mdReads(port)).toHaveLength(1);
  });

  test('o mesmo arquivo bem formado é aceito (controle dos casos acima)', () => {
    const good = {
      ...BASE,
      tasks: [[1, ' ', 'a', { due: '2026-10-12', inv: ['sch'], g: ['#x'], pr: 4, rec: 'every day' }]],
      props: { a: [1, 'b'], c: null },
      itags: ['#x'],
      trunc: ['tasks', 'props'],
    };
    const parsed = parseIndex(JSON.stringify({ version: 3, entries: { 'a.md': good } }));
    expect(parsed?.get('a.md')).toMatchObject({
      tasks: [
        task(1, { text: 'a', due: '2026-10-12', invalid: ['scheduled'], tags: ['#x'], priority: 4, recurrence: 'every day' }),
      ],
      inlineTags: ['#x'],
      truncated: ['tasks', 'props'],
    });
    for (const [, extra] of bad)
      expect(parseIndex(JSON.stringify({ version: 3, entries: { 'a.md': { ...BASE, ...extra } } }))).toBeNull();
  });
});
