import { generateVault } from '@simplemd/core/testing';
import { INDEX_PATH } from '@simplemd/vault';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AUTOSAVE_DEBOUNCE_MS } from '../src/state/sync';
import { setup, type Harness } from './helpers';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const sha = (bytes: Uint8Array | null) =>
  createHash('sha256')
    .update(bytes ?? '')
    .digest('hex');

/** Deixa a construção do índice terminar (fatias de 25 notas entre tarefas de 0 ms). */
async function settleIndex(h: Harness) {
  for (let i = 0; i < 200 && h.app.catalog.getSnapshot().status !== 'ready'; i++)
    await vi.advanceTimersByTimeAsync(1);
}

describe('AC-9.3 regra 1 com o vault de 2.000 notas (R-9.9) e o extrator real', () => {
  test('construção completa + revalidação: 0 escritas em .md; sha256 e mtime iguais', async () => {
    const files = generateVault();
    const h = await setup(files, { catalog: true });
    const before = new Map(Object.keys(files).map((p) => [p, sha(h.port.readBytes(p))]));
    const listed = await h.platform.vault.listNotes(h.app.store.getState().handle!);
    const mtimes = new Map(listed.map((n) => [n.path, n.mtime]));
    const started = performance.now();
    await settleIndex(h);
    const buildMs = performance.now() - started;
    const snap = h.app.catalog.getSnapshot();
    expect(snap.entries).toHaveLength(2000);
    expect(snap.entries.filter((e) => e.fmError)).toHaveLength(100);
    // NFR-27 (VT, porta em memória): construção completa ≤ 3 s — medido sem a instrumentação da
    // cobertura v8 (que no runner Ubuntu compartilhado passa de 3 s; ambiente de referência, §3).
    if (process.env.SIMPLEMD_COVERAGE !== '1') expect(buildMs).toBeLessThan(3000);
    console.info(`[NFR-27] construção do índice de 2.000 notas: ${Math.round(buildMs)} ms`);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.port.readText(INDEX_PATH)).not.toBeNull();

    // Revalidação: reabrir a mesma pasta (índice quente) relê 0 notas.
    h.port.resetCalls();
    await h.app.sync.openVault('shell');
    await settleIndex(h);
    expect(h.port.calls().filter((c) => c.op === 'readFile' && c.abs.endsWith('.md'))).toEqual([]);
    // 21 do explorador (lista do r1) + 21 do índice (uma por pasta; NFR-28).
    expect(h.port.calls().filter((c) => c.op === 'readDir')).toHaveLength(42);

    const targets = new Set(
      h.port
        .calls()
        .filter((c) => c.op === 'writeFile')
        .map((c) => c.abs),
    );
    expect([...targets].every((abs) => abs === `/vault/${INDEX_PATH}`)).toBe(true);
    for (const [path, digest] of before) expect(sha(h.port.readBytes(path))).toBe(digest);
    const after = await h.platform.vault.listNotes(h.app.store.getState().handle!);
    expect(after.every((n) => mtimes.get(n.path) === n.mtime)).toBe(true);
  }, 20_000);
});

describe('AC-9.8 gravação do app e observador', () => {
  test('salvar no app atualiza a entrada sem ler o .md; o índice só regrava com metadados novos', async () => {
    const h = await setup(
      { 'receitas/bolo.md': '---\ntitle: Bolo\ntags: [doce]\n---\n# Corpo\n' },
      { catalog: true },
    );
    await settleIndex(h);
    await vi.advanceTimersByTimeAsync(2000);
    await h.app.sync.openFile('receitas/bolo.md');
    h.port.resetCalls();
    // O índice lê notas por `provider.read`; a gravação compara a base direto na porta.
    const reads = vi.spyOn(h.platform.vault, 'read');

    h.type('receitas/bolo.md', 'só o corpo\n');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await h.settle();
    await vi.advanceTimersByTimeAsync(3000);
    // 1 escrita (a nota); o índice não regrava (decisão B: só mtime/tamanho mudaram).
    expect(
      h.port
        .calls()
        .filter((c) => c.op === 'writeFile')
        .map((c) => c.abs),
    ).toEqual(['/vault/receitas/bolo.md']);
    const entry = () =>
      h.app.catalog.getSnapshot().entries.find((e) => e.path === 'receitas/bolo.md');
    expect(entry()?.mtime).toBe(h.app.registry.get('receitas/bolo.md')?.mtime);

    const record = h.app.registry.get('receitas/bolo.md')!;
    const { state } = record.state.update({
      changes: { from: 11, to: 15, insert: 'Bolo de fubá' },
    });
    h.app.sync.onEditorChange('receitas/bolo.md', state);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await h.settle();
    expect(entry()?.title).toBe('Bolo de fubá');
    await vi.advanceTimersByTimeAsync(2000);
    expect(reads).not.toHaveBeenCalled();
    expect(
      JSON.parse(h.port.readText(INDEX_PATH) ?? '{}').entries['receitas/bolo.md'],
    ).toMatchObject({ title: 'Bolo de fubá', tags: ['doce'] });
  });

  test('mudança externa (observador) relê só o arquivo mudado; trocar de pasta descarta o índice', async () => {
    const h = await setup({ 'a.md': '# A\n', 'b.md': '# B\n' }, { catalog: true });
    await settleIndex(h);
    h.port.resetCalls();
    h.port.externalWrite('b.md', '# B novo\n');
    await h.settle();
    await vi.advanceTimersByTimeAsync(5);
    expect(h.app.catalog.getSnapshot().entries.find((e) => e.path === 'b.md')?.title).toBe(
      'B novo',
    );
    expect(
      h.port
        .calls()
        .filter((c) => c.op === 'readFile')
        .map((c) => c.abs),
    ).toEqual(['/vault/b.md']);
    h.port.remove('a.md');
    await h.settle();
    await vi.advanceTimersByTimeAsync(5);
    expect(h.app.catalog.getSnapshot().entries.map((e) => e.path)).toEqual(['b.md']);

    // Fechar a janela grava o índice pendente (flush) e descarta o índice.
    expect(await h.requestClose()).toBe(true);
    expect(JSON.parse(h.port.readText(INDEX_PATH) ?? '{}').entries).toHaveProperty(['b.md']);
    expect(h.app.catalog.getSnapshot()).toMatchObject({ entries: [], status: 'loading' });
  });

  test('sem o índice ligado (padrão dos testes do r1) nada é lido nem gravado além do r1', async () => {
    const h = await setup({ 'a.md': '# A\n' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.port.calls().filter((c) => c.op === 'readFile')).toEqual([]);
    expect(h.app.catalog.getSnapshot().entries).toEqual([]);
  });
});
