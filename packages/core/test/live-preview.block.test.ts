import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState, type Transaction } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMarkdownExtensions, setEditorFocus } from '../src';
import { computeInlineDecorations } from '../src/live-preview';
import { createBlockDriver } from '../src/live-preview/block';
import { editorFocus } from '../src/live-preview/focus';
import { blockImages } from '../src/live-preview/images/element';
import { linkReferencesField } from '../src/live-preview/references';
import { tableBlock } from '../src/live-preview/table';
import { liveCounters } from '../src/live-preview/counters';
import { generateRichR7Markdown } from '../src/testing';
import { flattenDecos } from './helpers/live-preview';
import { PERF_GATE } from './helpers/perf';

/** O mesmo campo do editor (contribuidores de bloco do `index.ts`) num estado sem view. */
const driver = createBlockDriver([tableBlock, blockImages]);
const extensions = [
  createMarkdownExtensions({ livePreview: false }),
  editorFocus(),
  linkReferencesField,
  driver.field,
];

function stateOf(doc: string, anchor = doc.length): EditorState {
  const state = EditorState.create({ doc, selection: { anchor }, extensions });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state.update({ effects: setEditorFocus.of(true) }).state;
}

/**
 * Testes estruturais sem relógio (TestResultsR7 F3). O parse incremental do CodeMirror tem 20 ms de
 * `Date.now` por transação; sob carga uma tecla estoura, a árvore fica parcial e o parse termina
 * numa transação seguinte. Com uma tecla lenta (sonda: `Date.now` +25 ms por leitura), o NFR-43
 * conta ≈ 2.400 contribuições (passada de topo do §5.2 d) e a propriedade do CR-S1-01 diverge do
 * recálculo no passo lento (semente 2, passo 42, o mesmo da falha sob carga). Com o `Date` parado o
 * orçamento nunca vence e o resultado só depende do código. O teste de tempo (PERF_GATE) usa o
 * relógio real.
 */
function freezeParseClock(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

/** Decorações comparáveis: posição, tipo, bloco e o widget (classe + `eq`). */
function shape(set: DecorationSet) {
  return flattenDecos(set).map(({ from, to, kind, block, widget }) => ({
    from,
    to,
    kind,
    block: block ?? false,
    widget: widget?.constructor.name ?? null,
    widgetValue: widget,
  }));
}

function expectFieldEqualsCompute(state: EditorState, label: string) {
  const field = shape(state.field(driver.field));
  const full = shape(driver.compute(state));
  const plain = (list: typeof field) =>
    list.map(({ from, to, kind, block, widget }) => ({ from, to, kind, block, widget }));
  expect(plain(field), label).toEqual(plain(full));
  field.forEach((d, i) => {
    const other = full[i]?.widgetValue;
    if (d.widgetValue && other) expect(d.widgetValue.eq(other), `${label} widget ${i}`).toBe(true);
  });
}

/** PRNG determinístico (mulberry32). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE = [
  'texto inicial',
  '',
  '```',
  'code',
  '```',
  '',
  '![b](b.png)',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '<div>',
  'html',
  '</div>',
  '',
  '<!-- comentário -->',
  '',
  '~~~',
  'mais código',
  '~~~',
  '',
  '![c](c.png)',
  '',
  '| x | y |',
  '| - | - |',
  '| 3 | 4 |',
  '',
  '  ![recuada](r.png)',
  '',
  ' | p | q |',
  ' | - | - |',
  ' | 5 | 6 |',
  '',
  'fim',
  '',
].join('\n');

const SNIPPETS = [
  '`',
  '```',
  '~~~',
  '\n',
  '\n\n',
  '|',
  '| - |',
  '![x](x.png)',
  ' ',
  'a',
  '> ',
  '<!--',
  '-->',
  '<div>',
  '</div>',
  '    ',
  '- ',
];

describe('CR-S1-01 — campo de blocos incremental == recálculo completo', () => {
  freezeParseClock();

  it('caso mínimo: apagar uma crase da cerca de abertura reestrutura o resto (tabela e imagem viram código)', () => {
    const doc = 'texto\n\n```\ncode\n```\n\n![b](b.png)\n\n| a | b |\n| - | - |\n| 1 | 2 |\n';
    const state = stateOf(doc, 0);
    expect(shape(state.field(driver.field)).map((d) => d.widget)).toEqual([
      'ImageWidget',
      'TableWidget',
    ]);
    const fence = doc.indexOf('```');
    const edited = state.update({ changes: { from: fence, to: fence + 1 } }).state;
    expect(shape(edited.field(driver.field))).toEqual([]);
    expectFieldEqualsCompute(edited, 'mínimo');
    // E de volta: recolocar a crase devolve os 2 widgets.
    const restored = edited.update({ changes: { from: fence, insert: '`' } }).state;
    expectFieldEqualsCompute(restored, 'restaurado');
    expect(shape(restored.field(driver.field))).toHaveLength(2);
  });

  it('CR-S1-11: imagem e tabela recuadas (1–3 espaços) logo depois do bloco editado continuam com widget', () => {
    for (const doc of [
      'texto\n\n  ![b](b.png)\n',
      'texto\n\n | a | b |\n | - | - |\n | 1 | 2 |\n',
    ]) {
      const state = stateOf(doc, doc.length);
      expect(shape(state.field(driver.field)), doc).toHaveLength(1);
      const edited = state.update({ changes: { from: 0, insert: 'x' } }).state;
      expect(shape(edited.field(driver.field)), doc).toHaveLength(1);
      expectFieldEqualsCompute(edited, `recuada: ${JSON.stringify(doc)}`);
    }
  });

  it('propriedade: 4 sementes × 600 edições/seleções/foco aleatórios, campo == compute a cada passo', () => {
    for (const seed of [1, 2, 3, 4]) {
      const random = rng(seed);
      let state = stateOf(BASE, 0);
      for (let step = 0; step < 600; step++) {
        const len = state.doc.length;
        const pos = Math.floor(random() * (len + 1));
        const roll = random();
        let tr: Transaction;
        if (roll < 0.45) {
          const insert = SNIPPETS[Math.floor(random() * SNIPPETS.length)]!;
          tr = state.update({ changes: { from: pos, insert } });
        } else if (roll < 0.8) {
          const to = Math.min(len, pos + 1 + Math.floor(random() * 6));
          tr = state.update({ changes: { from: pos, to } });
        } else if (roll < 0.95) {
          const head = Math.floor(random() * (len + 1));
          tr = state.update({ selection: { anchor: pos, head } });
        } else {
          tr = state.update({ effects: setEditorFocus.of(random() < 0.5) });
        }
        state = tr.state;
        if (state.doc.length > 4000) state = stateOf(BASE, 0);
        expectFieldEqualsCompute(state, `semente ${seed}, passo ${step}`);
      }
    }
  });
});

describe('NFR-43 — campos de bloco mapeados, não recalculados, em edição fora deles', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('digitar num parágrafo de prosa refaz só esse parágrafo; os widgets dos outros blocos são os mesmos objetos', () => {
    // Relógio parado como em `freezeParseClock` (falha sob carga: "expected 2419 to be ≤ 40"); só
    // aqui, porque o teste de tempo deste bloco usa o relógio real.
    vi.useFakeTimers({ toFake: ['Date'] });
    const doc = generateRichR7Markdown();
    const prose = doc.indexOf('\n\n', 2000) + 2;
    let state = stateOf(doc, prose);
    const before = flattenDecos(state.field(driver.field));
    expect(before.length).toBeGreaterThan(10);
    const builds0 = liveCounters.blockBuilds;
    for (let i = 0; i < 20; i++)
      state = state.update({
        changes: { from: prose + i, insert: 'x' },
        selection: { anchor: prose + i + 1 },
      }).state;
    const builds = liveCounters.blockBuilds - builds0;
    const after = flattenDecos(state.field(driver.field));
    // ≤ 2 contribuições (tabela + imagem) por parágrafo tocado por tecla: o parágrafo editado.
    expect(builds).toBeLessThanOrEqual(20 * 2);
    expect(after.length).toBe(before.length);
    // Todo widget de bloco depois das 20 teclas é um dos objetos de antes (mapeado, não recriado).
    const previous = new Set(before.map((d) => d.widget).filter((w) => w !== undefined));
    const widgets = after.map((d) => d.widget).filter((w) => w !== undefined);
    expect(widgets.length).toBeGreaterThan(10);
    expect(widgets.filter((w) => !previous.has(w))).toEqual([]);
    // O caminho incremental rodou (o parágrafo editado foi refeito a cada tecla), sem passada de topo.
    expect(builds).toBeGreaterThanOrEqual(20);
    expectFieldEqualsCompute(state, 'rich-r7-10k');
  });

  it.runIf(PERF_GATE)(
    'tempo por transação (tecla em prosa + decorações de 60 linhas): mediana ≤ 4 ms, p95 ≤ 8 ms',
    () => {
      const doc = generateRichR7Markdown();
      let state = EditorState.create({ doc, extensions: createMarkdownExtensions() });
      ensureSyntaxTree(state, doc.length, 20_000);
      const prose = doc.indexOf('\n\n', doc.length / 2) + 2;
      state = state.update({
        selection: { anchor: prose },
        effects: setEditorFocus.of(true),
      }).state;
      const samples: number[] = [];
      for (let i = 0; i < 200; i++) {
        const t0 = performance.now();
        state = state.update({
          changes: { from: prose + i, insert: 'x' },
          selection: { anchor: prose + i + 1 },
        }).state;
        const first = state.doc.lineAt(prose).number;
        const from = state.doc.line(Math.max(1, first - 30)).from;
        const to = state.doc.line(Math.min(state.doc.lines, first + 30)).to;
        computeInlineDecorations(state, [{ from, to }]);
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      const median = samples[100]!;
      const p95 = samples[189]!;
      console.info(`NFR-43 mediana ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`);
      expect(median).toBeLessThanOrEqual(4);
      expect(p95).toBeLessThanOrEqual(8);
    },
  );
});
