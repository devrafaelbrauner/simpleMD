// r36b (AC-R36-2, D-R36-7): nota só na nuvem (`cloudOnly` da porta) entra no índice só pelo nome,
// com `cloud: true`, sem nenhuma leitura do conteúdo — ler faria o sistema baixá-la. É relida quando
// fica no disco ou com a preferência `index.cloudOnly` ligada; liberada depois de indexada, mantém
// os metadados. A porta em memória simula a marca (`setCloudOnly`; ler a tira, como o download).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createVaultIndex,
  INDEX_PATH,
  LocalFsProvider,
  type CatalogNoteMeta,
  type FsPort,
  type NoteExtractor,
  type VaultIndex,
} from '../src/index';
import { parseIndex } from '../src/catalog/schema';
import { MemoryFsPort } from '../src/testing/index';
import { testExtractor } from './helpers/extractor';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Título = linha `# ` (senão o nome do arquivo); tags = linha `tags:`. */
function meta(text: string, path: string): CatalogNoteMeta {
  const lines = text.split('\n');
  const title = lines.find((l) => l.startsWith('# '))?.slice(2);
  const tags = lines.find((l) => l.startsWith('tags:'))?.slice(5);
  return {
    title: title ?? path.slice(path.lastIndexOf('/') + 1, -3),
    tags: (tags ?? '').split(',').filter(Boolean),
    date: null,
    fmError: false,
  };
}

const clock = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
};
const SENTINEL = 'CORPO-NUVEM-7C1E';
const BOLO = `# Bolo de fubá\ntags:receita,doce\n\n${SENTINEL}\n`;

/** Leituras de conteúdo de nota que chegaram à porta. */
const noteReads = (port: MemoryFsPort) =>
  port
    .calls()
    .filter((c) => c.op === 'readFile' && c.abs.endsWith('.md'))
    .map((c) => c.abs);

/** Deixa as fatias (pausas de 0 ms) andarem. */
async function settle(work: Promise<void>) {
  await vi.advanceTimersByTimeAsync(50);
  await work;
}

async function open(port: FsPort, cloudOnly = false) {
  const provider = new LocalFsProvider(port);
  const handle = await provider.open();
  const extract = testExtractor(meta);
  const index = createVaultIndex({ provider, handle, extract, clock, cloudOnly });
  await settle(index.start());
  return index;
}

const entry = (index: VaultIndex, path: string) =>
  index.getSnapshot().entries.find((e) => e.path === path);

/** Entradas do `index.json` gravado, cruas (a chave `cloud` presente ou ausente). */
function stored(port: MemoryFsPort): Record<string, Record<string, unknown>> {
  // O arquivo é o que o índice deste teste gravou; a forma é conferida pelo `parseIndex`.
  const file = JSON.parse(port.readText(INDEX_PATH) ?? 'null') as {
    entries: Record<string, Record<string, unknown>>;
  };
  return file.entries;
}

describe('AC-R36-2: nota só na nuvem no índice', () => {
  test('entra pelo nome, sem ler o conteúdo; `cloud: true` no arquivo; reabrir faz 0 leituras', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'receitas/bolo.md': BOLO, 'a.md': '# A\n' });
    port.setCloudOnly('receitas/bolo.md');
    const index = await open(port);
    expect(noteReads(port)).toEqual(['/vault/a.md']);
    expect(entry(index, 'receitas/bolo.md')).toMatchObject({
      title: 'bolo',
      tags: [],
      cloud: true,
    });
    expect(entry(index, 'a.md')).toMatchObject({ title: 'A' });
    expect(entry(index, 'a.md')).not.toHaveProperty('cloud');
    // O índice não baixou a nota: a marca continua.
    expect(await port.lstat('/vault/receitas/bolo.md')).toMatchObject({ cloudOnly: true });

    await index.flush();
    expect(port.readText(INDEX_PATH)).not.toContain(SENTINEL);
    expect(stored(port)['receitas/bolo.md']).toMatchObject({ title: 'bolo', cloud: true });
    expect(stored(port)['a.md']).not.toHaveProperty('cloud');
    // Regra 1: só o índice é gravado.
    const written = port.calls().filter((c) => c.op === 'writeFile');
    expect(written.map((c) => c.abs)).toEqual([`/vault/${INDEX_PATH}`]);
    index.dispose();

    port.resetCalls();
    const again = await open(port);
    expect(noteReads(port)).toEqual([]);
    expect(entry(again, 'receitas/bolo.md')).toMatchObject({ title: 'bolo', cloud: true });
  });

  test('fica no disco (baixada fora do app) → relida: pelo evento, pela revalidação e ao reabrir', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'bolo.md': BOLO, 'pudim.md': '# Pudim\n', 'torta.md': '# Torta\n' });
    for (const rel of ['bolo.md', 'pudim.md', 'torta.md']) port.setCloudOnly(rel);
    const index = await open(port);
    expect(noteReads(port)).toEqual([]);

    // Observador: o `stat` diz que ela está no disco → 1 leitura, só dela.
    port.setCloudOnly('bolo.md', false);
    await settle(index.applyChanges(['bolo.md']));
    expect(noteReads(port)).toEqual(['/vault/bolo.md']);
    expect(entry(index, 'bolo.md')).toMatchObject({
      title: 'Bolo de fubá',
      tags: ['receita', 'doce'],
    });
    expect(entry(index, 'bolo.md')).not.toHaveProperty('cloud');

    // Sondagem: a revalidação acha a que ficou no disco.
    port.resetCalls();
    port.setCloudOnly('pudim.md', false);
    await settle(index.revalidate());
    expect(noteReads(port)).toEqual(['/vault/pudim.md']);
    expect(entry(index, 'pudim.md')?.title).toBe('Pudim');
    await index.flush();
    index.dispose();

    // Reabrir com a última já no disco: o índice salvo a tem com `cloud` → 1 leitura.
    port.setCloudOnly('torta.md', false);
    port.resetCalls();
    const again = await open(port);
    expect(noteReads(port)).toEqual(['/vault/torta.md']);
    expect(entry(again, 'torta.md')?.title).toBe('Torta');
  });

  test('preferência ligada relê só as que entraram pelo nome (o sistema as baixa); desligar não apaga', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'bolo.md': BOLO, 'a.md': '# A\n' });
    port.setCloudOnly('bolo.md');
    const index = await open(port);
    port.resetCalls();
    await settle(index.setCloudOnly(true));
    expect(noteReads(port)).toEqual(['/vault/bolo.md']);
    expect(entry(index, 'bolo.md')).toMatchObject({
      title: 'Bolo de fubá',
      tags: ['receita', 'doce'],
    });
    expect(entry(index, 'bolo.md')).not.toHaveProperty('cloud');
    expect(await port.lstat('/vault/bolo.md')).not.toHaveProperty('cloudOnly');

    port.resetCalls();
    await settle(index.setCloudOnly(false));
    await settle(index.revalidate());
    expect(noteReads(port)).toEqual([]);
    expect(entry(index, 'bolo.md')?.title).toBe('Bolo de fubá');
    await index.flush();
    expect(port.readText(INDEX_PATH)).not.toContain(SENTINEL);
  });

  test('preferência ligada desde a abertura: lê na construção, sem `cloud`', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'bolo.md': BOLO });
    port.setCloudOnly('bolo.md');
    const index = await open(port, true);
    expect(noteReads(port)).toEqual(['/vault/bolo.md']);
    expect(entry(index, 'bolo.md')).toMatchObject({ title: 'Bolo de fubá' });
    expect(entry(index, 'bolo.md')).not.toHaveProperty('cloud');
  });

  test('preferência ligada no meio da construção: as que já tinham entrado pelo nome são relidas no fim', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i++) files[`n${String(i).padStart(2, '0')}.md`] = `# Nota ${i}\n`;
    const port = new MemoryFsPort();
    port.seed(files);
    port.setCloudOnly('n00.md');
    const base = testExtractor(meta);
    let index: VaultIndex | null = null;
    // Liga quando a 2ª fatia (25 notas por fatia) chega a n40; n00 já entrou só pelo nome.
    const extract: NoteExtractor = {
      meta: base.meta,
      start(text, path) {
        if (path === 'n40.md') void index?.setCloudOnly(true);
        return base.start(text, path);
      },
    };
    const provider = new LocalFsProvider(port);
    const handle = await provider.open();
    index = createVaultIndex({ provider, handle, extract, clock });
    await settle(index.start());
    expect(noteReads(port).filter((abs) => abs === '/vault/n00.md')).toHaveLength(1);
    expect(entry(index, 'n00.md')).toMatchObject({ title: 'Nota 0' });
    expect(entry(index, 'n00.md')).not.toHaveProperty('cloud');
    expect(index.getSnapshot()).toMatchObject({ status: 'ready', done: 60, total: 60 });
  });

  test('liberada depois de indexada ("Liberar espaço"): mantém título e tags, 0 leituras', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'bolo.md': BOLO });
    const index = await open(port);
    expect(entry(index, 'bolo.md')?.title).toBe('Bolo de fubá');
    port.resetCalls();
    port.setCloudOnly('bolo.md');
    await settle(index.applyChanges(['bolo.md']));
    await settle(index.revalidate());
    expect(noteReads(port)).toEqual([]);
    expect(entry(index, 'bolo.md')).toMatchObject({
      title: 'Bolo de fubá',
      tags: ['receita', 'doce'],
    });
    expect(entry(index, 'bolo.md')).not.toHaveProperty('cloud');
    await index.flush();
    index.dispose();

    port.resetCalls();
    const again = await open(port);
    expect(noteReads(port)).toEqual([]);
    expect(entry(again, 'bolo.md')?.title).toBe('Bolo de fubá');
  });

  test('evento numa nota só na nuvem: 0 leituras, também quando ela mudou na nuvem', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'bolo.md': BOLO, 'a.md': '# A\n' });
    port.setCloudOnly('bolo.md');
    const index = await open(port);
    port.resetCalls();
    port.touch('bolo.md');
    await settle(index.applyChanges(['bolo.md']));
    const { mtime } = (await port.lstat('/vault/bolo.md')) ?? { mtime: -1 };
    expect(entry(index, 'bolo.md')).toMatchObject({ title: 'bolo', cloud: true, mtime });
    // Já indexada pelo conteúdo, chega da nuvem mudada e sem os dados: volta a entrar pelo nome.
    port.externalWrite('a.md', '# A nova\ncom mais texto\n');
    port.setCloudOnly('a.md');
    await settle(index.applyChanges(['a.md']));
    expect(noteReads(port)).toEqual([]);
    expect(entry(index, 'a.md')).toMatchObject({ title: 'a', cloud: true });
  });

  test('gravação do app tira a marca: a nota foi aberta (baixada) e o texto é o do app', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'bolo.md': BOLO });
    port.setCloudOnly('bolo.md');
    const index = await open(port);
    index.applySaved('bolo.md', '# Bolo de fubá\ntags:doce\n', 42);
    expect(entry(index, 'bolo.md')).toMatchObject({ title: 'Bolo de fubá', tags: ['doce'] });
    expect(entry(index, 'bolo.md')).not.toHaveProperty('cloud');
    await index.flush();
    expect(stored(port)['bolo.md']).not.toHaveProperty('cloud');
    expect(noteReads(port)).toEqual([]);
  });
});

describe('esquema v3: `cloud` opcional, só `true`', () => {
  const BASE = { mtime: 1, size: 1, title: 'a', tags: [], date: null, fmError: false, links: [] };
  const file = (extra: Record<string, unknown>) =>
    JSON.stringify({ version: 3, entries: { 'a.md': { ...BASE, ...extra } } });

  test('`cloud: true` faz a volta; outro valor invalida o índice inteiro (refeito com 1 leitura)', async () => {
    expect(parseIndex(file({ cloud: true }))?.get('a.md')?.cloud).toBe(true);
    expect(parseIndex(file({}))?.get('a.md')).not.toHaveProperty('cloud');
    for (const cloud of [false, 1, 'sim', null]) expect(parseIndex(file({ cloud }))).toBeNull();
    const port = new MemoryFsPort();
    port.seed({ 'a.md': '# A\n', [INDEX_PATH]: file({ cloud: false }) });
    await open(port);
    expect(noteReads(port)).toEqual(['/vault/a.md']);
  });

  test('relida com o mesmo título do nome: o arquivo perde `cloud` e reabrir faz 0 leituras', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'x.md': 'sem título\n' });
    port.setCloudOnly('x.md');
    const index = await open(port);
    await index.flush();
    expect(stored(port)['x.md']).toMatchObject({ title: 'x', cloud: true });
    port.setCloudOnly('x.md', false);
    await settle(index.applyChanges(['x.md']));
    expect(entry(index, 'x.md')).toMatchObject({ title: 'x' });
    await index.flush();
    expect(stored(port)['x.md']).not.toHaveProperty('cloud');
    index.dispose();
    port.resetCalls();
    await open(port);
    expect(noteReads(port)).toEqual([]);
  });
});

describe('porta em memória e provider', () => {
  test('setCloudOnly: listagem e lstat marcam; ler baixa (a marca sai, sem evento)', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'a.md': 'a', 'p/b.md': 'b' });
    const events: string[][] = [];
    await port.watch('/vault', (paths) => events.push(paths));
    port.setCloudOnly('a.md');
    expect(events).toEqual([['/vault/a.md']]);
    expect(await port.readDir('/vault')).toContainEqual({
      name: 'a.md',
      kind: 'file',
      size: 1,
      mtime: expect.any(Number),
      cloudOnly: true,
    });
    expect(await port.lstat('/vault/a.md')).toMatchObject({ kind: 'file', cloudOnly: true });
    expect(await port.lstat('/vault/p')).not.toHaveProperty('cloudOnly');
    expect(new TextDecoder().decode(await port.readFile('/vault/a.md'))).toBe('a');
    expect(await port.lstat('/vault/a.md')).not.toHaveProperty('cloudOnly');
    expect(events).toHaveLength(1);
    expect(() => port.setCloudOnly('nada.md')).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
    expect(() => port.setCloudOnly('p')).toThrow(expect.objectContaining({ code: 'INVALID_PATH' }));
  });

  test('listNotes leva a marca, com stat na listagem e sem ele (um lstat por nota, como a porta Node)', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'a.md': 'a', 'p/b.md': 'b' });
    port.setCloudOnly('p/b.md');
    const bare: FsPort = {
      pickDirectory: () => port.pickDirectory(),
      join: (root, rel) => port.join(root, rel),
      readDir: async (abs) => (await port.readDir(abs)).map(({ name, kind }) => ({ name, kind })),
      lstat: (abs) => port.lstat(abs),
      readFile: (abs) => port.readFile(abs),
      writeFile: (abs, data, mode) => port.writeFile(abs, data, mode),
      mkdirp: (abs) => port.mkdirp(abs),
    };
    const expected = [
      { path: 'a.md', size: 1, mtime: expect.any(Number) },
      { path: 'p/b.md', size: 1, mtime: expect.any(Number), cloudOnly: true },
    ];
    for (const fs of [port, bare]) {
      const provider = new LocalFsProvider(fs);
      const notes = await provider.listNotes(await provider.open());
      expect([...notes].sort((x, y) => (x.path < y.path ? -1 : 1))).toEqual(expected);
    }
  });
});
