import { EditorState } from '@codemirror/state';
import { beforeAll, describe, expect, test } from 'vitest';
import { CLUSTER_SLOTS, loadTableEngine, type TableEngine } from '../src/tables/engine';
import { StateTextEditor } from '../src/tables/adapter';

/**
 * r7 S3 — adaptador `ITextEditor` sobre o `EditorState` (arch-frontend r7 §7): edições de linha do
 * upstream compostas num único `ChangeSet`, seleção mapeada, emoji de vários pontos de código.
 */
let engine: TableEngine;
beforeAll(async () => {
  engine = await loadTableEngine();
});

function session(doc: string, head = 0) {
  const state = EditorState.create({ doc });
  const editor = new StateTextEditor(engine, state, head, () => true);
  const result = () => {
    const edit = editor.finish();
    return { text: edit.changes.apply(state.doc).toString(), selection: edit.selection.main };
  };
  return { editor, result };
}

describe('linhas', () => {
  test('insertLine no meio e depois da última linha', () => {
    const { editor, result } = session('a\nb');
    editor.insertLine(1, 'x');
    editor.insertLine(3, 'fim');
    expect(result().text).toBe('a\nx\nb\nfim');
    expect(editor.getLastRow()).toBe(3);
  });

  test('deleteLine: do meio, a última e a única', () => {
    const middle = session('a\nb\nc');
    middle.editor.deleteLine(1);
    expect(middle.result().text).toBe('a\nc');
    const last = session('a\nb');
    last.editor.deleteLine(1);
    expect(last.result().text).toBe('a');
    const only = session('só');
    only.editor.deleteLine(0);
    expect(only.result().text).toBe('');
  });

  test('replaceLines: troca mínima, inserção (fim ≤ início) e remoção (lista vazia)', () => {
    const swap = session('| a |\n| b |\nfim');
    swap.editor.replaceLines(0, 2, ['| a  |', '| bb |']);
    expect(swap.result().text).toBe('| a  |\n| bb |\nfim');
    const same = session('x\ny');
    same.editor.replaceLines(0, 2, ['x', 'y']);
    expect(same.editor.finish().changes.empty).toBe(true);
    const insert = session('a\nb');
    insert.editor.replaceLines(1, 1, ['n1', 'n2']);
    expect(insert.result().text).toBe('a\nn1\nn2\nb');
    const remove = session('a\nb\nc\nd');
    remove.editor.replaceLines(1, 3, []);
    expect(remove.result().text).toBe('a\nd');
  });

  test('troca mínima não parte um par substituto (emoji astral)', () => {
    const { editor, result } = session('|😀|');
    editor.replaceLines(0, 1, ['|😁|']);
    const { text } = result();
    expect(text).toBe('|😁|');
    // Mantém 1, troca os 2 code units do par (😀 → 😁), mantém 1.
    expect(editor.finish().changes.desc.toJSON()).toEqual([1, -1, 2, 2, 1, -1]);
  });
});

describe('seleção e posições', () => {
  test('transact só executa; seleção mapeada pelas edições anteriores a ela', () => {
    const { editor, result } = session('a\nb', 2);
    editor.transact(() => editor.insertLine(0, 'novo'));
    expect(result().selection.head).toBe(7);
    editor.select(1, 0);
    expect(editor.snapshot()).toEqual({ anchor: 1, head: 0, length: 8 });
  });

  test('pontos fora da linha são limitados; emoji de vários pontos de código = 1 coluna do upstream', () => {
    const { editor } = session('|👍🏽|x|', '|👍🏽|'.length);
    expect(editor.getLine(0)).toHaveLength('|?|x|'.length);
    expect(editor.getCursorPosition().column).toBe(3);
    expect(editor.offsetOf(new engine.Point(0, 3))).toBe('|👍🏽|'.length);
    expect(editor.offsetOf(new engine.Point(9, 99))).toBe('|👍🏽|x|'.length);
    expect(editor.offsetOf(new engine.Point(-1, -5))).toBe(0);
    editor.replaceLines(0, 1, [editor.getLine(0).replace('x', 'y')]);
    expect(
      editor
        .finish()
        .changes.apply(EditorState.create({ doc: '|👍🏽|x|' }).doc)
        .toString(),
    ).toBe('|👍🏽|y|');
  });
});

describe('não-caracteres literais no texto (CR-S3-01)', () => {
  // 50 emoji de vários pontos de código distintos (5 tons de pele × 10): os reservados alocados
  // passam de U+FDD0 e chegam a U+1FFFE (índice 34 de `CLUSTER_SLOTS`).
  const bases = ['👍', '👋', '👌', '✌', '🤞', '🤟', '🤘', '🤙', '👈', '👉'];
  const clusters = bases.flatMap((base) =>
    [0x1f3fb, 0x1f3fc, 0x1f3fd, 0x1f3fe, 0x1f3ff].map((tone) => base + String.fromCodePoint(tone)),
  );

  test.each([
    ['U+FDD0', '\uFDD0'],
    ['U+1FFFE', '\u{1FFFE}'],
  ])('%s literal nunca vira reservado: ida e volta preserva o texto', (_, nc) => {
    const line = `|${nc}|${clusters.join('|')}|`;
    const { editor, result } = session(`${line}\n|outra${nc}|`);
    const encoded = editor.getLine(0);
    // Cada aglomerado ganhou um reservado próprio, diferente do não-caractere literal.
    const slots = [...encoded].filter((char) => CLUSTER_SLOTS.includes(char));
    expect(slots).toHaveLength(clusters.length + 1);
    expect(new Set(slots).size).toBe(clusters.length + 1);
    editor.replaceLines(0, 2, [`${encoded}z`, editor.getLine(1)]);
    expect(result().text).toBe(`${line}z\n|outra${nc}|`);
  });

  test('reservados esgotados: o aglomerado fica como está (largura do meaw), sem perder texto', () => {
    const many = [...clusters, ...clusters.map((c) => `${c}\u200D`)].slice(0, 70);
    const line = `|\uFDD0|${many.join('|')}|`;
    const { editor, result } = session(line);
    const encoded = editor.getLine(0);
    expect([...encoded].filter((char) => CLUSTER_SLOTS.includes(char))).toHaveLength(
      CLUSTER_SLOTS.length,
    );
    editor.replaceLines(0, 1, [`${encoded}!`]);
    expect(result().text).toBe(`${line}!`);
  });

  test('cursor no meio de um aglomerado: coluna do início dele (CR-S3-04)', () => {
    const { editor } = session('|👍🏽|x|', 1 + '👍'.length);
    expect(editor.getCursorPosition().column).toBe(1);
  });
});
