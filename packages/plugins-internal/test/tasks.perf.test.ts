import { generateTasksVault } from '@simplemd/core/testing';
import { describe, expect, it } from 'vitest';
import { runQuery, type QueryKind } from '../src/tasks/query/evaluate';
import { fakeCatalog, indexNote } from './tasks-fixture';

// NFR-48 (orçamento do avaliador; a pintura do widget é medida pela QA no PW): `FX-2000-TASKS`
// = 2.000 notas × 20 tarefas = 40.000 tarefas.
const notes = Object.entries(generateTasksVault()).map(([path, text]) => indexNote(path, text));
const catalog = fakeCatalog(notes);
const source = { notes: catalog.getSnapshot().notes, catalog, notePath: '', today: '2026-10-10' };

function median(kind: QueryKind, code: string): { ms: number; count: number } {
  const times: number[] = [];
  let count = 0;
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const result = runQuery(kind, code, source);
    times.push(performance.now() - start);
    count = result.kind === 'error' ? -1 : result.count;
  }
  times.sort((a, b) => a - b);
  return { ms: times[2]!, count };
}

describe('NFR-48: avaliação sobre FX-2000-TASKS', () => {
  it('tem 40.000 tarefas', () => {
    expect(notes.reduce((sum, note) => sum + note.tasks.length, 0)).toBe(40_000);
  });

  it('```tasks com 3 filtros + ordenação + limit 100: mediana ≤ 500 ms', () => {
    const { ms, count } = median(
      'tasks',
      'not done\ndue after 2026-10-05\npath includes projetos\nsort by due\nsort by priority reverse\nlimit 100',
    );
    console.info(`[NFR-48] tasks 40.000: mediana ${ms.toFixed(1)} ms, ${count} resultados`);
    expect(count).toBe(100);
    expect(ms).toBeLessThanOrEqual(500);
  });

  it('TABLE dataview sobre 2.000 notas: mediana ≤ 300 ms', () => {
    const { ms, count } = median('dataview', 'TABLE file.size, file.folder\nSORT file.name DESC');
    console.info(`[NFR-48] TABLE 2.000 notas: mediana ${ms.toFixed(1)} ms, ${count} resultados`);
    expect(count).toBe(1000);
    expect(ms).toBeLessThanOrEqual(300);
  });
});
