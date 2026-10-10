// @vitest-environment jsdom
import { undo, undoDepth } from '@codemirror/commands';
import type { Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { loadTableEngine, runTableCommand } from '../src';
import { PERF_GATE } from './helpers/perf';
import { destroyTableViews, mountTable } from './helpers/tables';

/**
 * r7 S3 — AC-I3.1 (R-I3.3): tabelas-ouro formatadas byte a byte e idempotência (formatar de novo =
 * 0 bytes de diferença). Largura visual East Asian do `meaw` (CJK e emoji = 2 colunas, Q-R7-F05).
 * Divergências do upstream documentadas (D-R7-F22, Q-R7-F03): crase protege `|`; `[[a|b]]` vira
 * `[[a\|b]]`.
 */
beforeAll(async () => {
  await loadTableEngine();
});
afterEach(destroyTableViews);

const GOLDEN: readonly { name: string; input: string; output: string }[] = [
  {
    name: 'ASCII',
    input: '|Name|Qty|\n|-|-|\n|apple|3|\n|kiwi|12|',
    output: '| Name  | Qty |\n| ----- | --- |\n| apple | 3   |\n| kiwi  | 12  |',
  },
  {
    name: 'acentos (NFC e NFD contam 1 coluna)',
    input: '|Ação|Preço|\n|---|---|\n|Café com pão|R$ 5|\n|Pe\u0301|ç|',
    output:
      '| Ação         | Preço |\n| ------------ | ----- |\n| Café com pão | R$ 5  |\n| Pe\u0301           | ç     |',
  },
  {
    name: 'CJK (2 colunas por caractere)',
    input: '|名前|説明|\n|--|--|\n|日本語|テキスト|\n|a|中|',
    output:
      '| 名前   | 説明     |\n| ------ | -------- |\n| 日本語 | テキスト |\n| a      | 中       |',
  },
  {
    name: 'emoji (2 colunas; tom de pele, ZWJ, keycap e bandeira = 2)',
    input: '|Emoji|Nome|\n|-|-|\n|😀|sorriso|\n|👍🏽|joinha|\n|👨‍👩‍👧|família|\n|1️⃣|um|\n|🇧🇷|bandeira|',
    output: [
      '| Emoji | Nome     |',
      '| ----- | -------- |',
      '| 😀    | sorriso  |',
      '| 👍🏽    | joinha   |',
      '| 👨‍👩‍👧    | família  |',
      '| 1️⃣    | um       |',
      '| 🇧🇷    | bandeira |',
    ].join('\n'),
  },
  {
    name: '`\\|` escapado fica numa célula',
    input: '|Expr|Valor|\n|-|-|\n|a \\| b|1|\n|x|\\||',
    output: '| Expr   | Valor |\n| ------ | ----- |\n| a \\| b | 1     |\n| x      | \\|    |',
  },
  {
    name: 'crase com `|` (protegido, divergência D-R7-F22)',
    input: '|Código|Nota|\n|-|-|\n|`a|b`|crase|\n|``x|y``|dupla|',
    output: '| Código  | Nota  |\n| ------- | ----- |\n| `a|b`   | crase |\n| ``x|y`` | dupla |',
  },
  {
    name: 'células faltando viram vazias',
    input: '|a|b|c|\n|-|-|-|\n|1|\n|1|2|',
    output: '| a   | b   | c   |\n| --- | --- | --- |\n| 1   |     |     |\n| 1   | 2   |     |',
  },
  {
    name: 'alinhamentos :--, :-:, --: e sem',
    input: '|Esq|Centro|Dir|Nenhum|\n|:--|:-:|--:|---|\n|a|b|c|d|\n|longo texto|x|1234|y|',
    output:
      '| Esq         | Centro |  Dir | Nenhum |\n|:----------- |:------:| ----:| ------ |\n| a           |   b    |    c | d      |\n| longo texto |   x    | 1234 | y      |',
  },
  {
    name: 'wikilink com apelido vira [[a\\|b]] (Q-R7-F03)',
    input: '|Link|Obs|\n|-|-|\n|[[nota|apelido]]|ok|',
    output:
      '| Link              | Obs |\n| ----------------- | --- |\n| [[nota\\|apelido]] | ok  |',
  },
  {
    name: 'GFM sem | inicial (D-R7-S3-06)',
    input: 'a | b\n--|--\n1 | 2',
    output: '| a   | b   |\n| --- | --- |\n| 1   | 2   |',
  },
  {
    name: 'indentação de até 3 espaços preservada',
    input: '  |a|b|\n  |-|-|\n  |1|2|',
    output: '  | a   | b   |\n  | --- | --- |\n  | 1   | 2   |',
  },
];

describe('AC-I3.1 tabelas-ouro', () => {
  test.each(GOLDEN)(
    '$name: saída byte a byte e formatar de novo = 0 bytes',
    ({ input, output }) => {
      const doc = `Antes\n\n${input}\n\nDepois`;
      const { view } = mountTable(doc, doc.indexOf(input) + 1);
      expect(runTableCommand(view, 'format')).toBe(true);
      expect(view.state.doc.toString()).toBe(`Antes\n\n${output}\n\nDepois`);
      expect(undoDepth(view.state)).toBe(1);
      const once = view.state.doc;
      runTableCommand(view, 'format');
      // Idempotente: nenhuma mudança, nem passo de desfazer novo.
      expect(view.state.doc.eq(once)).toBe(true);
      expect(undoDepth(view.state)).toBe(1);
      undo(view);
      expect(view.state.doc.toString()).toBe(doc);
    },
  );

  test('só o espaço em volta muda: espaços internos e crases ficam como estavam', () => {
    const input = '|  x  |y|\n|-|-|\n|  Ação  com   espaço|`a | b`|';
    const { view } = mountTable(input, 1);
    runTableCommand(view, 'format');
    expect(view.state.doc.toString()).toBe(
      '| x                  | y       |\n| ------------------ | ------- |\n| Ação  com   espaço | `a | b` |',
    );
  });

  test('Formatar todas as tabelas: só as de topo, um passo de desfazer, cursor mapeado', () => {
    const doc = '|a|b|\n|-|-|\n|1|2|\n\ntexto\n\n- item\n\n  |n|m|\n  |-|-|\n\n|c|\n|-|\n|long|';
    const { view } = mountTable(doc, 1);
    runTableCommand(view, 'format-all');
    expect(view.state.doc.toString()).toBe(
      '| a   | b   |\n| --- | --- |\n| 1   | 2   |\n\ntexto\n\n- item\n\n  |n|m|\n  |-|-|\n\n| c    |\n| ---- |\n| long |',
    );
    expect(undoDepth(view.state)).toBe(1);
    expect(view.state.selection.main.head).toBe(2);
    undo(view);
    expect(view.state.doc.toString()).toBe(doc);
  });

  test('Formatar todas numa tabela sem `|` inicial deixa o cursor na mesma célula que Formatar (CR-S3-02)', () => {
    const doc = 'one | two\n--- | ---\nthree | four';
    const at = doc.indexOf('four') + 2;
    const single = mountTable(doc, at).view;
    runTableCommand(single, 'format');
    const all = mountTable(doc, at).view;
    runTableCommand(all, 'format-all');
    expect(all.state.doc.toString()).toBe(single.state.doc.toString());
    const { head } = all.state.selection.main;
    expect(head).toBe(single.state.selection.main.head);
    const line = all.state.doc.lineAt(head);
    expect(line.text.slice(0, head - line.from)).toBe('| three | fo');
  });

  test.each([
    ['U+FDD0', '\uFDD0'],
    ['U+1FFFE', '\u{1FFFE}'],
  ])(
    'não-caractere literal (%s) numa célula fica como está ao lado de emoji (CR-S3-01)',
    (_, nc) => {
      const doc = `|a${nc}|b|\n|-|-|\n|👍🏽|x|`;
      const { view } = mountTable(doc, 1);
      runTableCommand(view, 'format');
      const out = view.state.doc.toString();
      expect(out.split(nc)).toHaveLength(2);
      expect(out.split('👍🏽')).toHaveLength(2);
      expect(out.replace(/[ \-|\n]/g, '')).toBe(`a${nc}b👍🏽x`);
      expect(out).toBe(`| a${nc} | b   |\n| --- | --- |\n| 👍🏽  | x   |`);
    },
  );
});

describe('NFR-50 (Should) — tempos', () => {
  const big = (rows: number, cols: number) => {
    const line = (r: number) =>
      `|${Array.from({ length: cols }, (_, c) => (r < 0 ? `col${c}` : `v${r}x${c}${'é'.repeat(c % 3)}`)).join('|')}|`;
    return [
      line(-1),
      `|${'-|'.repeat(cols)}`,
      ...Array.from({ length: rows }, (_, r) => line(r)),
    ].join('\n');
  };

  test('100 linhas × 10 colunas: formatar duas vezes = 0 bytes (sempre)', () => {
    const { view } = mountTable(big(100, 10), 1);
    runTableCommand(view, 'format');
    const once = view.state.doc;
    runTableCommand(view, 'format');
    expect(view.state.doc.eq(once)).toBe(true);
  });

  /**
   * Tempo do COMANDO (motor + transação + campos do estado, inclusive o parse incremental): formatar
   * = mediana de 5 tabelas novas; Tab = p95 de 100. A atualização da view fica de fora: no jsdom ela
   * é ~75 % do tempo (DOM emulado; RUN/impl-perf-fixes.md §5) e o desenho real no Chromium é a
   * metade PW do NFR-50. A amostra única com a view pegava o DOM do jsdom: 94,8/53,2 ms no CI.
   */
  test.runIf(PERF_GATE)('formatar 100×10 ≤ 50 ms; Tab de célula 20×5 p95 ≤ 16,7 ms', () => {
    let viewMs = 0;
    const dispatchTransactions = (trs: readonly Transaction[], target: EditorView) => {
      const start = performance.now();
      target.update(trs);
      viewMs += performance.now() - start;
    };
    const format: number[] = [];
    for (let i = 0; i < 5; i++) {
      const { view } = mountTable(big(100, 10), 1, { dispatchTransactions });
      const before = view.state.doc;
      viewMs = 0;
      const t0 = performance.now();
      runTableCommand(view, 'format');
      format.push(performance.now() - t0 - viewMs);
      expect(view.state.doc.eq(before)).toBe(false);
    }
    format.sort((a, b) => a - b);
    expect(format[2]).toBeLessThanOrEqual(50);
    const small = mountTable(big(20, 5), 1, { dispatchTransactions }).view;
    const times: number[] = [];
    for (let i = 0; i < 100; i++) {
      viewMs = 0;
      const start = performance.now();
      runTableCommand(small, 'next-cell');
      times.push(performance.now() - start - viewMs);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]).toBeLessThanOrEqual(16.7);
  });
});
