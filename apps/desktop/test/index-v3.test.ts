import { createNoteExtractor } from '@simplemd/core';
import { generateTasksVault } from '@simplemd/core/testing';
import { INDEX_PATH } from '@simplemd/vault';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PERF_GATE } from '../../../packages/core/test/helpers/perf';
import { fxR7 } from '../harness/fixtures/r7';
import { setup, type Harness } from './helpers';

/**
 * Índice v3 com o extrator REAL do core (r7 S9; R-I9.3, NFR-47, AC-I2.8 reexecutado;
 * arch-backend r7 §1.7.6–§1.7.7): reconciliação (o v3 relido do disco = extração direta),
 * migração de um v2 do S2 com UMA reconstrução e o orçamento de tamanho de `FX-2000-TASKS`.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => vi.useRealTimers());

async function settleIndex(h: Harness) {
  for (let i = 0; i < 2000 && h.app.catalog.getSnapshot().status !== 'ready'; i++)
    await vi.advanceTimersByTimeAsync(1);
  expect(h.app.catalog.getSnapshot().status).toBe('ready');
}

const mdReads = (h: Harness) =>
  h.port.calls().filter((c) => c.op === 'readFile' && c.abs.endsWith('.md'));

/** O que o índice guarda de uma nota, pela extração direta (sem o vault). */
function direct(text: string, path: string) {
  const job = createNoteExtractor().start(text, path);
  while (!job.step(Number.POSITIVE_INFINITY));
  const { links, tasks, properties, inlineTags, truncated } = job.result();
  return { links, tasks, properties: { ...properties }, inlineTags, truncated };
}

describe('índice v3 com o extrator real', () => {
  test('reconciliação FX-R7: o v3 relido do disco (0 leituras de .md) = extração direta', async () => {
    const files = fxR7();
    const notes = Object.keys(files).filter((p) => p.endsWith('.md'));
    const first = await setup(files, { catalog: true });
    await settleIndex(first);
    await first.app.catalog.flush();
    const disk = first.port.readText(INDEX_PATH)!;
    expect(JSON.parse(disk).version).toBe(3);

    const second = await setup({ ...files, [INDEX_PATH]: disk }, { catalog: true });
    await settleIndex(second);
    expect(mdReads(second)).toEqual([]);
    const entries = second.app.catalog.getSnapshot().entries;
    expect(entries.map((e) => e.path).sort()).toEqual([...notes].sort());
    let withTasks = 0;
    for (const entry of entries) {
      const text = files[entry.path] as string;
      const { links, tasks, properties, inlineTags, truncated } = entry;
      expect({ links, tasks, properties: { ...properties }, inlineTags, truncated }).toEqual(
        direct(text, entry.path),
      );
      if (entry.tasks.length > 0) withTasks++;
    }
    expect(withTasks).toBeGreaterThan(3);
  });

  test('AC-I2.8 reexecutado: índice v2 do S2 → UMA reconstrução sem erro, grava v3', async () => {
    const files = { 'a.md': '# A\n- [ ] t #x\n[[b]]\n', 'b.md': '---\ntipo: y\n---\n# B\n' };
    const v2 = JSON.stringify({
      version: 2,
      entries: {
        'a.md': { mtime: 1, size: 1, title: 'A', tags: [], date: null, fmError: false, links: [] },
      },
    });
    const warn = vi.spyOn(console, 'warn');
    const h = await setup({ ...files, [INDEX_PATH]: v2 }, { catalog: true });
    await settleIndex(h);
    expect(mdReads(h)).toHaveLength(2);
    await h.app.catalog.flush();
    const saved = JSON.parse(h.port.readText(INDEX_PATH)!);
    expect(saved.version).toBe(3);
    expect(saved.entries['a.md'].tasks).toEqual([[1, ' ', 't #x', { g: ['#x'] }]]);
    expect(saved.entries['b.md'].props).toEqual({ tipo: 'y' });
    expect(warn).not.toHaveBeenCalled();
    // Segunda abertura: nenhuma reconstrução.
    const again = await setup(
      { ...files, [INDEX_PATH]: h.port.readText(INDEX_PATH)! },
      { catalog: true },
    );
    await settleIndex(again);
    expect(mdReads(again)).toEqual([]);
  });

  test('NFR-47: índice de FX-2000-TASKS ≤ 6.000.000 bytes (UTF-8); 40.000 tarefas indexadas', async () => {
    const files = generateTasksVault();
    const started = performance.now();
    const h = await setup(files, { catalog: true });
    await settleIndex(h);
    const buildMs = performance.now() - started;
    await h.app.catalog.flush();
    const bytes = h.port.readBytes(INDEX_PATH)!.length;
    const entries = h.app.catalog.getSnapshot().entries;
    const tasks = entries.reduce((n, e) => n + e.tasks.length, 0);
    console.info(
      `[NFR-47] FX-2000-TASKS: índice ${bytes} bytes, ${tasks} tarefas, ${Math.round(buildMs)} ms`,
    );
    expect(entries).toHaveLength(2000);
    expect(tasks).toBe(40_000);
    expect(entries.every((e) => Object.keys(e.properties).length === 5)).toBe(true);
    expect(bytes).toBeLessThanOrEqual(6_000_000);
    // Tempo só na máquina de referência sem carga (PERF_GATE; o PerfBenchmarker mede no PERF-4).
    if (PERF_GATE && process.env.SIMPLEMD_COVERAGE !== '1')
      expect(buildMs).toBeLessThanOrEqual(3600);
  }, 120_000);
});
