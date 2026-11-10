// r37a (AC-R37A-1..3; design-r37 §1, §3, §7; D-R37-1..3): motor da busca no texto, portas Node e
// de memória e `LocalFsProvider.searchText`. A fixture `fixtures/search-fold.json` é a MESMA que o
// Rust da r37b lê (`include_str!`): dobra, consulta, posição e trechos iguais nos dois lados. r37b:
// os resíduos da revisão da r37a (guardas do provider depois do abort, envio por tempo durante uma
// leitura lenta, nenhuma leitura pendente depois de truncar/cancelar, vazamento por link conferido
// pelo conteúdo, ordem por ponto de código, substituto solto) e o NFR-4 medido de forma robusta.
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PERF_GATE } from '../../core/test/helpers/perf';
import {
  checkSearchQuery,
  decodeDocument,
  foldForSearch,
  LocalFsProvider,
  searchNote,
  searchTree,
  SEARCH_NOTE_MAX_BYTES,
  type FsPort,
  type FsSearchOptions,
  type SearchRead,
  type TextSearchHit,
  type TextSearchNote,
  type TextSearchOptions,
  type TextSearchResult,
  type TextSearchSummary,
  type VaultHandle,
} from '../src/index';
import { NodeFsPort } from '../src/ports/node';
import { MEMORY_ROOT, MemoryFsPort } from '../src/testing/index';
import { makeTempVault, type TempVault } from './helpers/tmp';

interface Fixture {
  readonly fold: ReadonlyArray<{ readonly input: string; readonly folded: string }>;
  /** `units`: as unidades UTF-16 de uma consulta com substituto solto (o JSON do Rust não a carrega). */
  readonly queries: ReadonlyArray<{
    readonly query?: string;
    readonly units?: readonly number[];
    readonly repeat?: number;
    readonly result: 'ok' | 'short' | 'long';
  }>;
  readonly notes: ReadonlyArray<{
    readonly name: string;
    readonly text: string;
    readonly query: string;
    readonly total: number;
    readonly hits: readonly TextSearchHit[];
  }>;
}

const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/search-fold.json'), 'utf8'),
) as Fixture;

const NONE = { hidden: 0, links: 0, cloud: 0, tooLarge: 0, notUtf8: 0, unreadable: 0 };

/** O resumo de uma busca que rodou (`done`). */
function done(result: TextSearchResult): TextSearchSummary {
  if (result.status !== 'done') throw new Error(`a busca não rodou: ${result.status}`);
  return result;
}

/** Busca pelo provider guardando os lotes entregues. */
async function search(
  provider: LocalFsProvider,
  handle: VaultHandle,
  query: string,
  options: Partial<TextSearchOptions> = {},
) {
  const batches: TextSearchNote[][] = [];
  const result = await provider.searchText(handle, query, {
    onNotes: (notes) => batches.push([...notes]),
    ...options,
  });
  return { result, batches, notes: batches.flat(), paths: batches.flat().map((n) => n.path) };
}

async function memoryVault(files: Record<string, string | Uint8Array>) {
  const port = new MemoryFsPort();
  port.seed(files);
  const provider = new LocalFsProvider(port);
  const handle = await provider.open();
  port.resetCalls();
  return { port, provider, handle };
}

/** A porta em memória sem `searchText` (métodos ligados, como em `watch.test.ts`). */
function withoutSearch(memory: MemoryFsPort): FsPort {
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

const WORDS = ['ação', 'coração', 'você', 'também', 'não', 'água', 'página', 'título', 'análise'];

/** ~1,5 KB com acentos; a cada 10 notas, uma linha com "Índice remissivo". */
function noteText(folder: number, note: number): string {
  let text = `# Nota ${folder}-${note}\n\n`;
  for (let i = 0; text.length < 1500; i++) {
    text += WORDS[(folder * 7 + note * 13 + i) % WORDS.length] + (i % 12 === 11 ? '\n' : ' ');
  }
  return note % 10 === 0 ? `${text}\nÍndice remissivo da nota.\n` : text;
}

/** NFR-4: 2.000 notas (20 pastas × 100), 200 delas com o termo. */
function twoThousand(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let folder = 1; folder <= 20; folder++) {
    for (let note = 1; note <= 100; note++) {
      const name = `pasta-${String(folder).padStart(2, '0')}/nota-${String(note).padStart(3, '0')}.md`;
      files[name] = noteText(folder, note);
    }
  }
  return files;
}

describe('AC-R37A-1: paridade com o Rust (search-fold.json)', () => {
  test.each(FIXTURE.fold)('dobra de $input', ({ input, folded }) => {
    expect(foldForSearch(input)).toBe(folded);
  });

  test.each(FIXTURE.queries)('consulta %# → $result', ({ query, units, repeat, result }) => {
    const typed = units ? String.fromCharCode(...units) : (query ?? '').repeat(repeat ?? 1);
    expect(checkSearchQuery(typed)).toBe(result);
  });

  test('a fixture tem o caso que separa "recomeça na unidade seguinte" de match_indices', () => {
    const names = FIXTURE.notes.map((note) => note.name);
    expect(names).toContain(
      'recomeça na unidade seguinte, não no fim do candidato (≠ match_indices)',
    );
    expect(FIXTURE.queries.filter((q) => q.units !== undefined).length).toBeGreaterThanOrEqual(1);
  });

  test.each(FIXTURE.notes)('$name', ({ text, query, total, hits }) => {
    expect(searchNote(text, query)).toEqual(total === 0 ? null : { total, hits });
  });

  test('cada trecho aponta para o texto que o editor mostra (decodeDocument)', () => {
    let checked = 0;
    for (const note of FIXTURE.notes) {
      const lines = decodeDocument(note.text).doc.split('\n');
      for (const hit of note.hits) {
        const line = lines[hit.line] ?? '';
        const start = hit.col - hit.at;
        expect(foldForSearch(line.slice(hit.col, hit.col + hit.len))).toBe(
          foldForSearch(note.query),
        );
        expect(line.slice(start, start + hit.text.length)).toBe(hit.text);
        expect(hit.cutBefore).toBe(start > 0);
        expect(hit.cutAfter).toBe(start + hit.text.length < line.length);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(15);
  });

  test('o total de uma nota para em 999, com 5 trechos', () => {
    expect(searchNote('ab '.repeat(1200), 'AB')).toMatchObject({ total: 999, hits: { length: 5 } });
  });
});

describe('AC-R37A-1: busca pelo provider na porta em memória', () => {
  test('acha sem acento nem caixa, com posição e trecho, na ordem do percurso', async () => {
    const { provider, handle } = await memoryVault({
      'b.md': 'nada aqui',
      'a.md': '# Ação\n\nprimeira AÇÃO',
      'pasta/c.md': 'acao em c',
      'Z.md': 'Acao no Z',
    });
    const { result, notes } = await search(provider, handle, 'ação');
    expect(done(result)).toMatchObject({ scanned: 4, matched: 3, truncated: false });
    // Em cada pasta: as notas pela ordem dos pontos de código ("Z" < "a") e depois as subpastas.
    expect(notes).toEqual([
      { path: 'Z.md', total: 1, hits: [expect.objectContaining({ line: 0, col: 0, len: 4 })] },
      {
        path: 'a.md',
        total: 2,
        hits: [
          { line: 0, col: 2, len: 4, text: '# Ação', at: 2, cutBefore: false, cutAfter: false },
          {
            line: 2,
            col: 9,
            len: 4,
            text: 'primeira AÇÃO',
            at: 9,
            cutBefore: false,
            cutAfter: false,
          },
        ],
      },
      { path: 'pasta/c.md', total: 1, hits: [expect.objectContaining({ line: 0, col: 0 })] },
    ]);
  });

  test('consulta curta ou longa → short/long com 0 chamadas; porta sem busca → unavailable', async () => {
    const { port, provider, handle } = await memoryVault({ 'a.md': 'ab' });
    const onNotes = () => {
      throw new Error('nenhum lote esperado');
    };
    expect(await provider.searchText(handle, 'a', { onNotes })).toEqual({ status: 'short' });
    expect(await provider.searchText(handle, 'a\u0301', { onNotes })).toEqual({ status: 'short' });
    expect(await provider.searchText(handle, 'x'.repeat(257), { onNotes })).toEqual({
      status: 'long',
    });
    // AppSec r37a item 4: substituto solto nunca casa (e o IPC do Rust o recusa) → `short`.
    for (const lone of ['ab\uD800', '\uDC00ab', '\uDC00\uD800']) {
      expect(await provider.searchText(handle, lone, { onNotes })).toEqual({ status: 'short' });
    }
    expect(checkSearchQuery('ab\uD83D\uDE00')).toBe('ok');
    expect(port.calls()).toEqual([]);
    const bare = new LocalFsProvider(withoutSearch(port));
    const bareHandle = await bare.open();
    expect(await bare.searchText(bareHandle, 'ab', { onNotes })).toEqual({ status: 'unavailable' });
  });

  test('o provider refiltra os caminhos da porta e conta só o que entregou', async () => {
    const hit = { line: 0, col: 0, len: 2, text: 'ab', at: 0, cutBefore: false, cutAfter: false };
    const sent = ['ok.md', '.simplemd/x.md', 'a/.git/y.md', '../fora.md', 'C:/x.md', 'x.txt'];
    const port = {
      pickDirectory: async () => '/v',
      searchText: async (
        _abs: string,
        options: Parameters<NonNullable<FsPort['searchText']>>[1],
      ) => {
        options.onNotes(
          [...sent, 'con.md', 'sub/ok.md'].map((path) => ({ path, total: 1, hits: [hit] })),
        );
        return { scanned: 8, matched: 8, truncated: false, cancelled: false, skipped: NONE };
      },
    } as unknown as FsPort;
    const provider = new LocalFsProvider(port);
    const { result, paths } = await search(provider, await provider.open(), 'ab');
    expect(paths).toEqual(['ok.md', 'sub/ok.md']);
    expect(done(result).matched).toBe(2);
  });

  // Code review r37a itens 1 e 2 (o mutante M1 sobrevivia): com a porta assíncrona do Tauri, o
  // lote e o progresso podem chegar depois do abort — o provider é a barreira.
  test('nada sai depois do abort: nem lote nem progresso que a porta ainda manda; resumo cancelled', async () => {
    const hit = { line: 0, col: 0, len: 2, text: 'ab', at: 0, cutBefore: false, cutAfter: false };
    const note = (path: string) => ({ path, total: 1, hits: [hit] });
    const port = {
      pickDirectory: async () => '/v',
      searchText: async (_abs: string, options: FsSearchOptions) => {
        options.onProgress?.(200);
        options.onNotes([note('a.md')]);
        await Promise.resolve();
        // O Rust terminou antes de ver o cancelamento: o resto ainda chega pelo canal.
        options.onNotes([note('b.md')]);
        options.onProgress?.(400);
        return { scanned: 400, matched: 2, truncated: false, cancelled: false, skipped: NONE };
      },
    } as unknown as FsPort;
    const provider = new LocalFsProvider(port);
    const controller = new AbortController();
    const delivered: string[] = [];
    const progress: number[] = [];
    const result = await provider.searchText(await provider.open(), 'ab', {
      signal: controller.signal,
      onProgress: (scanned) => progress.push(scanned),
      onNotes: (notes) => {
        delivered.push(...notes.map((n) => n.path));
        controller.abort();
      },
    });
    expect(delivered).toEqual(['a.md']);
    expect(progress).toEqual([200]);
    expect(done(result)).toMatchObject({ matched: 1, cancelled: true });
  });
});

describe('AC-R37A-2: limites, lotes e cancelamento', () => {
  const many = (count: number, text = 'conteúdo') =>
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`n-${String(i).padStart(4, '0')}.md`, text]),
    );

  test('limit: a nota limit + 1 prova que havia mais (truncated); limite exato não trunca', async () => {
    const { provider, handle } = await memoryVault(many(205));
    const standard = await search(provider, handle, 'conteudo');
    expect(done(standard.result)).toMatchObject({ matched: 200, truncated: true, scanned: 201 });
    expect(standard.paths.at(-1)).toBe('n-0199.md');
    const exact = await search(provider, handle, 'conteudo', { limit: 205 });
    expect(done(exact.result)).toMatchObject({ matched: 205, truncated: false, scanned: 205 });
    const one = await search(provider, handle, 'conteudo', { limit: 0 });
    expect(done(one.result)).toMatchObject({ matched: 1, truncated: true });
  });

  test('limit acima de 500 vale 500', async () => {
    const { provider, handle } = await memoryVault(many(510));
    const { result } = await search(provider, handle, 'conteudo', { limit: 10_000 });
    expect(done(result)).toMatchObject({ matched: 500, truncated: true });
  });

  test('lotes de até 16 notas na ordem do percurso; progresso a cada 200 notas', async () => {
    const files = { ...many(450, 'sem nada'), ...many(40) };
    const { provider, handle } = await memoryVault(files);
    const progress: number[] = [];
    const { result, batches, paths } = await search(provider, handle, 'conteudo', {
      onProgress: (scanned) => progress.push(scanned),
    });
    expect(done(result)).toMatchObject({ scanned: 450, matched: 40 });
    expect(batches.every((batch) => batch.length >= 1 && batch.length <= 16)).toBe(true);
    expect(paths).toEqual(Object.keys(many(40)));
    expect(progress).toEqual([200, 400]);
  });

  test('cancelar depois do 1º lote: cancelled, scanned < 2000 e nenhum lote depois', async () => {
    const { provider, handle } = await memoryVault(many(2000));
    const controller = new AbortController();
    const batches: TextSearchNote[][] = [];
    const result = await provider.searchText(handle, 'conteudo', {
      limit: 500,
      signal: controller.signal,
      onNotes: (notes) => {
        batches.push([...notes]);
        controller.abort();
      },
    });
    expect(batches).toHaveLength(1);
    const summary = done(result);
    expect(summary).toMatchObject({ cancelled: true, truncated: false });
    expect(summary.matched).toBe(batches[0]?.length);
    expect(summary.scanned).toBeLessThan(2000);
  });

  test('signal já abortado: nenhuma chamada à porta', async () => {
    const { port, provider, handle } = await memoryVault(many(10));
    const controller = new AbortController();
    controller.abort();
    const { result, batches } = await search(provider, handle, 'conteudo', {
      signal: controller.signal,
    });
    expect(done(result)).toMatchObject({ cancelled: true, scanned: 0, matched: 0 });
    expect(batches).toEqual([]);
    expect(port.calls()).toEqual([]);
  });

  test('a porta recusa consulta inválida com INVALID_QUERY, como o Rust (o provider confere antes)', async () => {
    const port = new MemoryFsPort();
    const options = { limit: 10, signal: new AbortController().signal, onNotes: () => {} };
    for (const query of ['a', '\uD800ab', 'x'.repeat(257)]) {
      await expect(port.searchText(MEMORY_ROOT, { ...options, query })).rejects.toMatchObject({
        code: 'INVALID_QUERY',
      });
    }
  });

  // Code review r37a item 3: o envio por tempo (50 ms) vence também enquanto o percurso espera uma
  // leitura ou uma listagem lenta (nuvem, rede): a nota já achada sai sem esperar o disco.
  test.each([
    { slow: 'leitura', op: 'readFile', path: 'b.md', note: 'b.md' },
    { slow: 'listagem', op: 'readDir', path: 'sub', note: 'sub/b.md' },
  ] as const)('o lote sai em 50 ms com uma $slow lenta pendente', async ({ op, path, note }) => {
    const { port, provider, handle } = await memoryVault({
      'a.md': 'conteúdo',
      [note]: 'conteúdo',
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      port.fault({ op, path, delayMs: 5_000, once: true });
      const batches: string[][] = [];
      const running = provider.searchText(handle, 'conteudo', {
        onNotes: (notes) => batches.push(notes.map((n) => n.path)),
      });
      await vi.advanceTimersByTimeAsync(60);
      expect(batches).toEqual([['a.md']]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(done(await running)).toMatchObject({ scanned: 2, matched: 2 });
      expect(batches.flat()).toEqual(['a.md', note]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Code review r37a item 4 (AppSec r37a item 3): depois de truncar ou cancelar, as até 7 leituras
  // já pedidas terminam antes de a busca voltar — nenhum descritor nem buffer fica para trás. As 2
  // primeiras leituras terminam na hora; as outras esperam o teste liberá-las.
  test.each([
    { stop: 'truncar', limit: 1, abortAt: Infinity, pending: 7 },
    { stop: 'cancelar', limit: 500, abortAt: 3, pending: 1 },
  ])('$stop espera as leituras já pedidas', async ({ limit, abortAt, pending }) => {
    const names = Array.from({ length: 12 }, (_, i) => `n-${String(i).padStart(2, '0')}.md`);
    const controller = new AbortController();
    const held: Array<() => void> = [];
    let started = 0;
    let inFlight = 0;
    const source = {
      readDir: async () => names.map((name) => ({ name, kind: 'file' as const })),
      readNote: (): Promise<SearchRead> => {
        started++;
        inFlight++;
        if (started === abortAt) controller.abort();
        const read = Promise.withResolvers<SearchRead>();
        const finish = () => {
          inFlight--;
          read.resolve(new TextEncoder().encode('conteúdo'));
        };
        if (started <= 2) finish();
        else held.push(finish);
        return read.promise;
      },
    };
    let settled = false;
    const running = searchTree(source, {
      query: 'conteudo',
      limit,
      signal: controller.signal,
      onNotes: () => {},
    }).finally(() => {
      settled = true;
    });
    for (let tick = 0; tick < 50; tick++) await Promise.resolve();
    expect(settled).toBe(false);
    expect(inFlight).toBe(pending);
    for (const finish of held) finish();
    const summary = await running;
    expect(inFlight).toBe(0);
    expect(summary.scanned).toBeLessThan(12);
    if (limit === 1) expect(summary).toMatchObject({ truncated: true, matched: 1, scanned: 2 });
    else expect(summary).toMatchObject({ cancelled: true, matched: 0 });
  });

  // Code review r37a item 7: a ordem dos pontos de código — a do `str` do Rust — põe U+E000–FFFF
  // antes de um nome com emoji (fora do BMP), e isso decide quem entra antes do `truncated`.
  test('nome com emoji vem depois de U+E000–FFFF, como no Rust', async () => {
    const { provider, handle } = await memoryVault({
      '\u{1F600}.md': 'ação',
      '\uFF21.md': 'ação',
      '\uE000.md': 'ação',
      'z.md': 'ação',
    });
    const all = await search(provider, handle, 'acao');
    expect(all.paths).toEqual(['z.md', '\uE000.md', '\uFF21.md', '\u{1F600}.md']);
    const first = await search(provider, handle, 'acao', { limit: 3 });
    expect(first.paths).toEqual(['z.md', '\uE000.md', '\uFF21.md']);
    expect(done(first.result).truncated).toBe(true);
  });
});

describe('AC-R37A-3: memória — pulados e contados, só .md visíveis lidas', () => {
  const TERM = 'segredo';

  test('links, ocultos, nuvem, teto de 2 MiB e não UTF-8; nada gravado nem baixado', async () => {
    const { port, provider, handle } = await memoryVault({
      'a.md': `${TERM} visível`,
      '.simplemd/x.md': TERM,
      '.git/y.md': TERM,
      '.oculta.md': TERM,
      'pasta/.escondida/z.md': TERM,
      'nuvem.md': TERM,
      'imagem.png': TERM,
      'con.md': TERM,
      'grande.md': 'x'.repeat(SEARCH_NOTE_MAX_BYTES + 1),
      'limite.md': TERM + 'x'.repeat(SEARCH_NOTE_MAX_BYTES - TERM.length),
      'binario.md': Uint8Array.of(0x61, 0xff, 0xfe),
    });
    port.symlink('link.md', '/fora/segredo.md');
    port.symlink('pasta-link', '/fora');
    port.setCloudOnly('nuvem.md');
    port.resetCalls();
    const { result, notes } = await search(provider, handle, TERM);
    expect(notes.map((n) => n.path)).toEqual(['a.md', 'limite.md']);
    expect(notes[1]?.hits).toEqual([
      {
        line: 0,
        col: 0,
        len: TERM.length,
        text: TERM + 'x'.repeat(80),
        at: 0,
        cutBefore: false,
        cutAfter: true,
      },
    ]);
    expect(done(result)).toEqual({
      status: 'done',
      scanned: 4,
      matched: 2,
      truncated: false,
      cancelled: false,
      skipped: { hidden: 4, links: 2, cloud: 1, tooLarge: 1, notUtf8: 1, unreadable: 0 },
    });
    const calls = port.calls().map((c) => `${c.op} ${c.abs.slice(MEMORY_ROOT.length)}`);
    // Só as pastas e as notas visíveis; a nota acima do teto não é lida; nada é gravado.
    expect(calls.sort()).toEqual([
      'readDir ',
      'readDir /pasta',
      'readFile /a.md',
      'readFile /binario.md',
      'readFile /limite.md',
    ]);
    expect(await port.lstat(`${MEMORY_ROOT}/nuvem.md`)).toMatchObject({ cloudOnly: true });
  });

  test('falhas injetadas: nota ilegível e subpasta ilegível contam; a raiz ilegível rejeita', async () => {
    const { port, provider, handle } = await memoryVault({
      'a.md': TERM,
      'b.md': TERM,
      'pasta/c.md': TERM,
    });
    port.failNext('readFile', 'IO', 'a.md');
    port.failNext('readDir', 'PERMISSION_DENIED', 'pasta');
    const { result, paths } = await search(provider, handle, TERM);
    expect(paths).toEqual(['b.md']);
    expect(done(result).skipped).toEqual({ ...NONE, unreadable: 2 });
    port.failNext('readDir', 'IO');
    await expect(search(provider, handle, TERM)).rejects.toMatchObject({ code: 'IO' });
  });

  test('nota trocada por link durante a leitura → links, sem o conteúdo', async () => {
    const { port, provider, handle } = await memoryVault({ 'a.md': TERM, 'b.md': TERM });
    // O atraso injetado é um `setTimeout` falso: a troca acontece com a leitura de a.md parada nele.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      port.fault({ op: 'readFile', path: 'a.md', delayMs: 30, once: true });
      const running = search(provider, handle, TERM);
      const reading = () => port.calls().some((c) => c.abs === `${MEMORY_ROOT}/a.md`);
      for (let i = 0; i < 1000 && !reading(); i++) await Promise.resolve();
      expect(reading()).toBe(true);
      port.remove('a.md');
      port.symlink('a.md', '/fora/segredo.md');
      await vi.advanceTimersByTimeAsync(30);
      const { result, paths } = await running;
      expect(paths).toEqual(['b.md']);
      expect(done(result).skipped).toEqual({ ...NONE, links: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AC-R37A-3: Node fs (pasta temporária real)', () => {
  let vault: TempVault | undefined;
  let outside: string | undefined;
  afterEach(() => {
    vault?.cleanup();
    if (outside) rmSync(outside, { recursive: true, force: true });
    vault = undefined;
    outside = undefined;
  });

  const TERM = 'segredo';
  const makeOutside = () => {
    outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'simplemd-fora-')));
    writeFileSync(join(outside, 'segredo.md'), `${TERM} de fora`);
    return outside;
  };

  test('link de pasta/junção não é seguido; ocultos, teto e não UTF-8 contados', async () => {
    const fora = makeOutside();
    vault = await makeTempVault({
      'a.md': `Achou o ${TERM.toUpperCase()}`,
      '.git/y.md': TERM,
      '.simplemd/x.md': TERM,
      'grande.md': 'x'.repeat(SEARCH_NOTE_MAX_BYTES + 1),
      'binario.md': Uint8Array.of(0x61, 0xff),
      'sub/b.md': `${TERM}\r\nlinha 2`,
    });
    symlinkSync(fora, vault.abs('saida'), process.platform === 'win32' ? 'junction' : 'dir');
    const { result, notes } = await search(vault.provider, vault.handle, TERM);
    expect(notes.map((n) => [n.path, n.hits[0]?.line, n.hits[0]?.col])).toEqual([
      ['a.md', 0, 8],
      ['sub/b.md', 0, 0],
    ]);
    expect(done(result)).toMatchObject({
      scanned: 4,
      matched: 2,
      skipped: { ...NONE, hidden: 2, links: 1, tooLarge: 1, notUtf8: 1 },
    });
  });

  test('link de arquivo para fora do vault não é lido', async (ctx) => {
    const fora = makeOutside();
    vault = await makeTempVault({ 'a.md': 'nada' });
    try {
      symlinkSync(join(fora, 'segredo.md'), vault.abs('link.md'), 'file');
    } catch {
      // Windows sem privilégio de criar links de arquivo (A-4): a junção acima cobre o NTFS.
      ctx.skip();
    }
    const { result, paths } = await search(vault.provider, vault.handle, TERM);
    expect(paths).toEqual([]);
    expect(done(result)).toMatchObject({ scanned: 1, skipped: { ...NONE, links: 1 } });
  });

  test('nota trocada por link entre listar e abrir → links (O_NOFOLLOW; no Windows, lstat)', async () => {
    const fora = makeOutside();
    vault = await makeTempVault({ 'b.md': TERM });
    symlinkSync(fora, vault.abs('troca.md'), process.platform === 'win32' ? 'junction' : 'dir');
    // A listagem ainda diz "arquivo": a abertura sem seguir link é que recusa.
    class StaleListing extends NodeFsPort {
      override async readDir(abs: string) {
        const items = await super.readDir(abs);
        return items.map((item) =>
          item.name === 'troca.md' ? { ...item, kind: 'file' as const } : item,
        );
      }
    }
    const provider = new LocalFsProvider(new StaleListing(vault.root));
    const { result, paths } = await search(provider, await provider.open(), TERM);
    expect(paths).toEqual(['b.md']);
    expect(done(result)).toMatchObject({ scanned: 2, skipped: { ...NONE, links: 1 } });
  });

  // Code review r37a item 5: o vazamento real conferido pelo conteúdo — a nota trocada, entre a
  // listagem e a abertura, por um link para um ARQUIVO de fora com o termo não é lida (sem
  // `O_NOFOLLOW`, o texto de fora apareceria). POSIX: no Windows, criar link de arquivo pede
  // privilégio (A-4); a junção acima cobre o NTFS.
  test.skipIf(process.platform === 'win32')(
    'nota trocada por link para arquivo de fora: o conteúdo de fora nunca aparece',
    async () => {
      const fora = makeOutside();
      vault = await makeTempVault({ 'b.md': `${TERM} de dentro` });
      symlinkSync(join(fora, 'segredo.md'), vault.abs('troca.md'), 'file');
      class StaleListing extends NodeFsPort {
        override async readDir(abs: string) {
          const items = await super.readDir(abs);
          return items.map((item) =>
            item.name === 'troca.md' ? { ...item, kind: 'file' as const } : item,
          );
        }
      }
      const provider = new LocalFsProvider(new StaleListing(vault.root));
      const { result, notes } = await search(provider, await provider.open(), TERM);
      const texts = notes.flatMap((note) => note.hits.map((hit) => hit.text));
      expect(texts).toEqual([`${TERM} de dentro`]);
      expect(texts.join('\n')).not.toContain('de fora');
      expect(done(result)).toMatchObject({ scanned: 2, skipped: { ...NONE, links: 1 } });
    },
  );
});

/**
 * NFR-4 robusto ao ruído do runner (Reality r37a a; o molde da r37f): 1 rodada de aquecimento e 5
 * medidas, intercaladas — na porta Node — com a leitura pura das mesmas notas pela mesma porta. O
 * orçamento (≤ 500 ms) vale para a mediana da busca, e a razão busca/leitura (mediana por par) não
 * passa de 4×: o mesmo ruído cai nos dois lados e uma rajada numa rodada só não decide.
 */
async function measure(run: () => Promise<unknown>, read?: () => Promise<unknown>) {
  await run();
  const times: number[] = [];
  const ratios: number[] = [];
  for (let round = 0; round < 5; round++) {
    let started = performance.now();
    await run();
    const elapsed = performance.now() - started;
    times.push(elapsed);
    if (read) {
      started = performance.now();
      await read();
      ratios.push(elapsed / (performance.now() - started));
    }
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[2] ?? NaN;
  return { time: median(times), ratio: read ? median(ratios) : null, times, ratios };
}

/** A leitura pura das 2.000 notas pela porta (8 por vez, como a busca), sem dobra nem casamento. */
async function readAll(port: FsPort, root: string): Promise<void> {
  const notes: string[] = [];
  for (const folder of await port.readDir(root)) {
    const dir = port.join(root, folder.name);
    for (const item of await port.readDir(dir)) notes.push(port.join(dir, item.name));
  }
  for (let i = 0; i < notes.length; i += 8) {
    await Promise.all(notes.slice(i, i + 8).map((abs) => port.readFile(abs)));
  }
}

describe('NFR-4 (AC-R37A-2): 2.000 notas de ~1,5 KB com acentos em ≤ 500 ms', () => {
  let vault: TempVault | undefined;
  afterEach(() => {
    vault?.cleanup();
    vault = undefined;
  });

  const expectFullScan = (result: TextSearchResult, paths: string[]) => {
    expect(done(result)).toMatchObject({ scanned: 2000, matched: 200, truncated: false });
    expect(paths[0]).toBe('pasta-01/nota-010.md');
    expect(paths.at(-1)).toBe('pasta-20/nota-100.md');
  };

  // TA-R2-16: arquivos reais → tempo limite explícito; o orçamento em ms só no portão.
  test('Node fs', { timeout: 60_000 }, async () => {
    const temp = await makeTempVault(twoThousand());
    vault = temp;
    const { result, paths } = await search(temp.provider, temp.handle, 'INDICE REMISSIVO');
    expectFullScan(result, paths);
    if (!PERF_GATE) return;
    const run = () => search(temp.provider, temp.handle, 'INDICE REMISSIVO');
    const { time, ratio, times, ratios } = await measure(run, () => readAll(temp.port, temp.root));
    console.info(
      `[NFR-4] busca no texto de 2.000 notas (Node fs): mediana ${time.toFixed(1)} ms ` +
        `(${times.map((t) => t.toFixed(0)).join(', ')}); busca/leitura ${ratio?.toFixed(2)} ` +
        `(${ratios.map((r) => r.toFixed(2)).join(', ')})`,
    );
    expect(time).toBeLessThanOrEqual(500);
    expect(ratio).toBeLessThan(4);
  });

  test('memória', { timeout: 30_000 }, async () => {
    const { provider, handle } = await memoryVault(twoThousand());
    const { result, paths } = await search(provider, handle, 'INDICE REMISSIVO');
    expectFullScan(result, paths);
    if (!PERF_GATE) return;
    const { time, times } = await measure(() => search(provider, handle, 'INDICE REMISSIVO'));
    console.info(
      `[NFR-4] busca no texto de 2.000 notas (memória): mediana ${time.toFixed(1)} ms ` +
        `(${times.map((t) => t.toFixed(0)).join(', ')})`,
    );
    expect(time).toBeLessThanOrEqual(500);
  });
});
