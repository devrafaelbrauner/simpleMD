// @vitest-environment jsdom
import { undo, undoDepth } from '@codemirror/commands';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  loadTableEngine,
  runTableCommand,
  TABLE_COMMANDS,
  TABLE_TEXT,
  type TableCommandId,
} from '../src';
import { destroyTableViews, mountTable, selected } from './helpers/tables';

/**
 * r7 S3 — AC-I3.2 (cada comando de R-I3.1 tem um teste-ouro e exatamente um passo de desfazer) e
 * AC-I3.3 (fora de tabela / tabela aninhada: aviso STR-155 e 0 mudanças), mais os anúncios STR-156
 * e a ordenação pt-BR.
 */
beforeAll(async () => {
  await loadTableEngine();
});
afterEach(destroyTableViews);

const TABLE = '| a | b |c|\n|:-|-:|---|\n| 1 | 22 |\n| x | y | z |';
const DOC = `antes\n\n${TABLE}\n\ndepois\n`;
/** Cursor dentro de "22" (linha 1 do corpo, coluna 2). */
const AT_22 = DOC.indexOf('22') + 1;
const wrap = (...lines: string[]) => `antes\n\n${lines.join('\n')}\n\ndepois\n`;
const FORMATTED = [
  '| a   |   b | c   |',
  '|:--- | ---:| --- |',
  '| 1   |  22 |     |',
  '| x   |   y | z   |',
];

const GOLDEN: Record<TableCommandId, { lines: string[]; selected?: string }> = {
  format: { lines: FORMATTED },
  'format-all': { lines: FORMATTED },
  'next-cell': { lines: FORMATTED, selected: '' },
  'prev-cell': { lines: FORMATTED, selected: '1' },
  'next-row': { lines: FORMATTED, selected: 'y' },
  'insert-row-above': {
    lines: [FORMATTED[0], FORMATTED[1], '|     |     |     |', FORMATTED[2], FORMATTED[3]].map(
      String,
    ),
  },
  'insert-row-below': {
    lines: [FORMATTED[0], FORMATTED[1], FORMATTED[2], '|     |     |     |', FORMATTED[3]].map(
      String,
    ),
  },
  'delete-row': { lines: [FORMATTED[0], FORMATTED[1], FORMATTED[3]].map(String) },
  'insert-col-left': {
    lines: [
      '| a   |     |   b | c   |',
      '|:--- | --- | ---:| --- |',
      '| 1   |     |  22 |     |',
      '| x   |     |   y | z   |',
    ],
  },
  'insert-col-right': {
    lines: [
      '| a   |   b |     | c   |',
      '|:--- | ---:| --- | --- |',
      '| 1   |  22 |     |     |',
      '| x   |   y |     | z   |',
    ],
  },
  'delete-col': { lines: ['| a   | c   |', '|:--- | --- |', '| 1   |     |', '| x   | z   |'] },
  'move-row-up': { lines: FORMATTED },
  'move-row-down': {
    lines: [FORMATTED[0], FORMATTED[1], FORMATTED[3], FORMATTED[2]].map(String),
  },
  'move-col-left': {
    lines: [
      '|   b | a   | c   |',
      '| ---:|:--- | --- |',
      '|  22 | 1   |     |',
      '|   y | x   | z   |',
    ],
  },
  'move-col-right': {
    lines: [
      '| a   | c   |   b |',
      '|:--- | --- | ---:|',
      '| 1   |     |  22 |',
      '| x   | z   |   y |',
    ],
  },
  'align-left': {
    lines: [
      '| a   | b   | c   |',
      '|:--- |:--- | --- |',
      '| 1   | 22  |     |',
      '| x   | y   | z   |',
    ],
  },
  'align-center': {
    lines: [
      '| a   |  b  | c   |',
      '|:--- |:---:| --- |',
      '| 1   | 22  |     |',
      '| x   |  y  | z   |',
    ],
  },
  'align-right': { lines: FORMATTED },
  'align-none': {
    lines: [
      '| a   | b   | c   |',
      '|:--- | --- | --- |',
      '| 1   | 22  |     |',
      '| x   | y   | z   |',
    ],
  },
  'sort-asc': { lines: FORMATTED },
  'sort-desc': { lines: [FORMATTED[0], FORMATTED[1], FORMATTED[3], FORMATTED[2]].map(String) },
  transpose: {
    lines: [
      '| a   | 1   | x   |',
      '| --- | --- | --- |',
      '| b   | 22  | y   |',
      '| c   |     | z   |',
    ],
  },
};

describe('AC-I3.2 — teste-ouro e um passo de desfazer por comando', () => {
  test('a paleta tem os 22 comandos de R-I3.1, com os rótulos STR-154', () => {
    expect(TABLE_COMMANDS.map((c) => c.id).sort()).toEqual(Object.keys(GOLDEN).sort());
    expect(TABLE_COMMANDS).toHaveLength(22);
    for (const command of TABLE_COMMANDS) expect(command.title).toMatch(/^Tabela: [A-ZÁ-Ú]/);
  });

  test.each(TABLE_COMMANDS.map((c) => c.id))('%s', (id) => {
    const { view, notices } = mountTable(DOC, AT_22);
    const before = view.state.selection.main;
    expect(runTableCommand(view, id)).toBe(true);
    const golden = GOLDEN[id];
    expect(view.state.doc.toString()).toBe(wrap(...golden.lines));
    if (golden.selected !== undefined) expect(selected(view)).toBe(golden.selected);
    expect(undoDepth(view.state)).toBe(1);
    expect(notices).toEqual([]);
    undo(view);
    expect(view.state.doc.toString()).toBe(DOC);
    expect(view.state.selection.main.head).toBe(before.head);
    expect(undoDepth(view.state)).toBe(0);
  });

  test('o passo fica isolado: digitar logo depois não entra no mesmo passo de desfazer', () => {
    const { view } = mountTable(DOC, AT_22);
    runTableCommand(view, 'next-cell');
    view.dispatch(view.state.replaceSelection('novo'), { userEvent: 'input.type' });
    undo(view);
    expect(view.state.doc.toString()).toBe(wrap(...FORMATTED));
    undo(view);
    expect(view.state.doc.toString()).toBe(DOC);
  });
});

describe('navegação: célula ativa = seleção, anúncios STR-156', () => {
  const T = '|h1|h2|\n|-|-|\n|a|b|\n|c|d|';

  test('próxima célula percorre a linha e passa à 1ª da linha seguinte; na última cria linha', () => {
    const { view, announced } = mountTable(T, 1);
    const steps: string[] = [];
    for (let i = 0; i < 6; i++) {
      runTableCommand(view, 'next-cell');
      steps.push(selected(view));
    }
    expect(steps).toEqual(['h2', 'a', 'b', 'c', 'd', '']);
    expect(announced).toEqual([
      TABLE_TEXT.header(2),
      TABLE_TEXT.row(1, 1),
      TABLE_TEXT.row(1, 2),
      TABLE_TEXT.row(2, 1),
      TABLE_TEXT.row(2, 2),
      TABLE_TEXT.created,
    ]);
    expect(view.state.doc.toString()).toBe(
      '| h1  | h2  |\n| --- | --- |\n| a   | b   |\n| c   | d   |\n|     |     |',
    );
    expect(announced).toContain('Linha 2, coluna 1');
    expect(announced[0]).toBe('Cabeçalho, coluna 2');
    expect(announced.at(-1)).toBe('Linha nova criada.');
  });

  test('célula anterior volta pela linha e à última célula da linha de cima', () => {
    const { view, announced } = mountTable(T, T.indexOf('c') + 1);
    runTableCommand(view, 'prev-cell');
    expect(selected(view)).toBe('b');
    runTableCommand(view, 'prev-cell');
    expect(selected(view)).toBe('a');
    runTableCommand(view, 'prev-cell');
    expect(selected(view)).toBe('h2');
    expect(announced).toEqual([TABLE_TEXT.row(1, 2), TABLE_TEXT.row(1, 1), TABLE_TEXT.header(2)]);
  });

  test('próxima linha mantém a coluna; no fim cria linha (D-43)', () => {
    const { view, announced } = mountTable(T, T.indexOf('h2') + 1);
    runTableCommand(view, 'next-row');
    expect(selected(view)).toBe('b');
    runTableCommand(view, 'next-row');
    expect(selected(view)).toBe('d');
    runTableCommand(view, 'next-row');
    expect(view.state.doc.lines).toBe(5);
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    expect(line.number).toBe(5);
    expect(view.state.selection.main.head - line.from).toBe('|     | '.length);
    expect(announced).toEqual([TABLE_TEXT.row(1, 2), TABLE_TEXT.row(2, 2), TABLE_TEXT.created]);
  });

  test('comandos que não navegam não anunciam', () => {
    const { view, announced } = mountTable(T, 1);
    runTableCommand(view, 'format');
    runTableCommand(view, 'insert-row-below');
    expect(announced).toEqual([]);
  });

  test('emoji de vários pontos de código: a seleção cobre o emoji inteiro', () => {
    const doc = '|😀|👍🏽|x|\n|-|-|-|\n|👨‍👩‍👧|b|1️⃣|';
    const { view } = mountTable(doc, 1);
    const steps: string[] = [];
    for (let i = 0; i < 5; i++) {
      runTableCommand(view, 'next-cell');
      steps.push(selected(view));
    }
    expect(steps).toEqual(['👍🏽', 'x', '👨‍👩‍👧', 'b', '1️⃣']);
    runTableCommand(view, 'prev-cell');
    expect(selected(view)).toBe('b');
    expect(view.state.doc.toString()).toBe(
      '| 😀  | 👍🏽  | x   |\n| --- | --- | --- |\n| 👨‍👩‍👧  | b   | 1️⃣  |',
    );
  });
});

describe('ordenar (texto pt-BR ou número)', () => {
  const sort = (cells: string[], id: 'sort-asc' | 'sort-desc') => {
    const doc = `|v|i|\n|-|-|\n${cells.map((c, i) => `|${c}|${i}|`).join('\n')}`;
    const { view } = mountTable(doc, 1);
    runTableCommand(view, id);
    return view.state.doc
      .toString()
      .split('\n')
      .slice(2)
      .map((line) => line.split('|')[1]?.trim());
  };

  test('números com vírgula ou ponto decimal ordenam como números; vazias primeiro', () => {
    expect(sort(['10,5', '9,75', '', '100', '-1.5', '2e1'], 'sort-asc')).toEqual([
      '',
      '-1.5',
      '9,75',
      '10,5',
      '2e1',
      '100',
    ]);
    expect(sort(['10,5', '9,75', '', '100'], 'sort-desc')).toEqual(['100', '10,5', '9,75', '']);
  });

  test('texto pelo Collator pt-BR (acentos junto da letra, número no texto em ordem numérica)', () => {
    expect(
      sort(['Zebra', 'élan', 'abacate', 'Ábaco', 'item 10', 'item 2', '**bold**'], 'sort-asc'),
    ).toEqual(['abacate', 'Ábaco', '**bold**', 'élan', 'item 2', 'item 10', 'Zebra']);
  });
});

describe('AC-I3.3 — fora de tabela ou em tabela aninhada: aviso STR-155 e 0 mudanças', () => {
  const OUTSIDE = 'Texto solto.\n\n| a | b |\n|---|---|\n| 1 | 2 |';
  const NESTED_LIST = '- item\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |';
  const NESTED_QUOTE = '> | a | b |\n> |---|---|\n> | 1 | 2 |';

  test.each(TABLE_COMMANDS.map((c) => c.id))('%s', (id) => {
    for (const [doc, pos, text] of [
      [OUTSIDE, 3, TABLE_TEXT.outside],
      [NESTED_LIST, NESTED_LIST.indexOf('| 1') + 2, TABLE_TEXT.nested],
      [NESTED_QUOTE, NESTED_QUOTE.indexOf('| 1') + 2, TABLE_TEXT.nested],
    ] as const) {
      const { view, notices } = mountTable(doc, pos);
      expect(runTableCommand(view, id)).toBe(false);
      expect(notices).toEqual([text]);
      expect(view.state.doc.toString()).toBe(doc);
      expect(undoDepth(view.state)).toBe(0);
    }
  });

  test('textos vinculantes', () => {
    expect(TABLE_TEXT.outside).toBe('Coloque o cursor numa tabela');
    expect(TABLE_TEXT.nested).toBe('Tabelas dentro de listas ou citações não são suportadas');
  });
});
