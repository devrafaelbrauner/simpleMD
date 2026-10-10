import { createHash } from 'node:crypto';
import { undo } from '@codemirror/commands';
import { foldedRanges } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { runScopeHandlers } from '@codemirror/view';
import { createMarkdownExtensions } from '@simplemd/core';
import { afterEach, describe, expect, test } from 'vitest';
import { DragAndDropController } from '../src/outliner/features/drag-and-drop';
import { foldGuideOwner, guideSpecs } from '../src/outliner/features/guides';
import { MyEditor } from '../src/outliner/model/editor';
import { goldenEditor, gridLayout, type GoldenEditor } from './outliner.harness';

/**
 * r7 S7 (I-7): critérios VT além dos casos-ouro (AC-I7.1). AC-I7.2 preservação + um passo de
 * desfazer; AC-I7.3 dobra sem bytes e sem persistência; AC-I7.4 cadeia de Tab com e sem a chave;
 * AC-I7.5/7.6 lógica de arrasto (Esc) e guias. O PW (harness) cobre o layout real.
 */

let open: GoldenEditor[] = [];
afterEach(() => {
  for (const g of open) g.destroy();
  open = [];
});

/** Editor do simpleMD com o outliner, o documento e o cursor no início da linha `line` (0-based). */
function editorWith(doc: string, line: number, options: { captureTab?: boolean } = {}) {
  const g = goldenEditor('other', true, { ...options, doc });
  open.push(g);
  const { view } = g;
  view.dispatch({ selection: { anchor: view.state.doc.line(line + 1).to } });
  return g;
}

function run(g: GoldenEditor, id: string): void {
  const command = g.commands.find((c) => c.id === `simplemd.outliner:${id}`);
  if (!command) throw new Error(`sem comando ${id}`);
  command.run(g.view);
}

function key(g: GoldenEditor, init: KeyboardEventInit): boolean {
  return runScopeHandlers(g.view, new KeyboardEvent('keydown', init), 'editor');
}

const text = (g: GoldenEditor) => g.view.state.doc.toString();
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('AC-I7.2 — preservação de marcador, numeração e indentação; um passo de desfazer', () => {
  test('mover e indentar com `*` e `+` mantém os marcadores', () => {
    const g = editorWith('* a\n* b\n  + b1\n* c', 1);
    run(g, 'move-down');
    expect(text(g)).toBe('* a\n* c\n* b\n  + b1');
    run(g, 'indent');
    expect(text(g)).toBe('* a\n* c\n  * b\n    + b1');
    run(g, 'outdent');
    expect(text(g)).toBe('* a\n* c\n* b\n  + b1');
  });

  test('lista ordenada renumerada como o upstream ao mover e indentar', () => {
    const g = editorWith('1. a\n2. b\n3. c', 2);
    run(g, 'move-up');
    expect(text(g)).toBe('1. a\n2. c\n3. b');
    run(g, 'indent');
    // O cursor segue o item movido (`c`): indentado com a `indentUnit` (nenhum item indentado no
    // documento), vira `1.` do novo nível e `b` é renumerado para `2.`.
    expect(text(g)).toBe('1. a\n  1. c\n2. b');
  });

  test.each([
    ['tab', '\t'],
    ['2 espaços', '  '],
    ['4 espaços', '    '],
  ])('indentação detectada (%s) num item sem irmão nem filho de onde copiar', (_, unit) => {
    const g = editorWith(`- a\n${unit}- a1\n- b\n- c`, 3);
    run(g, 'indent');
    expect(text(g)).toBe(`- a\n${unit}- a1\n- b\n${unit}- c`);
  });

  test('mover 2× e desfazer 1× volta exatamente um passo (cada operação = um passo)', () => {
    const g = editorWith('- a\n  - a1\n- b\n- c\n- d', 0);
    run(g, 'move-down');
    const afterFirst = text(g);
    expect(afterFirst).toBe('- b\n- a\n  - a1\n- c\n- d');
    run(g, 'move-down');
    expect(text(g)).toBe('- b\n- c\n- a\n  - a1\n- d');
    expect(undo(g.view)).toBe(true);
    expect(text(g)).toBe(afterFirst);
  });

  test('indentar com subárvore e desfazer 1× volta ao original', () => {
    const doc = '- a\n- b\n  - b1\n    - b2';
    const g = editorWith(doc, 1);
    run(g, 'indent');
    expect(text(g)).toBe('- a\n  - b\n    - b1\n      - b2');
    expect(undo(g.view)).toBe(true);
    expect(text(g)).toBe(doc);
  });
});

describe('AC-I7.3 — dobra só visual', () => {
  test('dobrar/desdobrar (item e tudo) não muda o sha256; estado novo do texto tem 0 dobras', () => {
    const g = editorWith('- a\n  - a1\n  - a2\n- b\n  - b1', 0);
    const before = sha256(text(g));
    run(g, 'fold');
    expect(foldedRanges(g.view.state).size).toBe(1);
    expect(g.announcements).toContain('Item dobrado.');
    run(g, 'fold-all');
    expect(foldedRanges(g.view.state).size).toBe(2);
    expect(sha256(text(g))).toBe(before);
    // Reabrir = estado novo a partir do texto (sem e com o outliner): nenhuma dobra volta.
    expect(
      foldedRanges(EditorState.create({ doc: text(g), extensions: createMarkdownExtensions() }))
        .size,
    ).toBe(0);
    expect(foldedRanges(editorWith(text(g), 0).view.state).size).toBe(0);
    run(g, 'unfold-all');
    expect(foldedRanges(g.view.state).size).toBe(0);
    expect(sha256(text(g))).toBe(before);
  });
});

describe('AC-I7.4 — cadeia de Tab', () => {
  test('chave ligada: Tab indenta com a subárvore e anuncia; Shift-Tab desindenta', () => {
    const g = editorWith('- a\n- b\n  - b1', 1, { captureTab: true });
    expect(key(g, { key: 'Tab' })).toBe(true);
    expect(text(g)).toBe('- a\n  - b\n    - b1');
    expect(g.announcements).toEqual(['Item indentado.']);
    expect(key(g, { key: 'Tab', shiftKey: true })).toBe(true);
    expect(text(g)).toBe('- a\n- b\n  - b1');
    expect(g.announcements).toEqual(['Item indentado.', 'Item desindentado.']);
  });

  test('chave desligada: Tab não é tratado (sai do editor); `Mod-]`/`Mod-[` fazem o mesmo', () => {
    const g = editorWith('- a\n- b\n  - b1', 1, { captureTab: false });
    expect(key(g, { key: 'Tab' })).toBe(false);
    expect(key(g, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(text(g)).toBe('- a\n- b\n  - b1');
    expect(key(g, { key: ']', ctrlKey: true })).toBe(true);
    expect(text(g)).toBe('- a\n  - b\n    - b1');
    expect(key(g, { key: '[', ctrlKey: true })).toBe(true);
    expect(text(g)).toBe('- a\n- b\n  - b1');
    expect(g.announcements).toEqual(['Item indentado.', 'Item desindentado.']);
  });
});

describe('AC-I7.5 — arrastar e soltar (lógica; layout em grade)', () => {
  const doc = '- one\n  - two\n- three\n  - four';
  const dragged = (g: GoldenEditor) => g.view.dom.querySelectorAll('.cm-outliner-dragging').length;
  const indicators = (g: GoldenEditor) => g.view.dom.querySelectorAll('.cm-outliner-drop').length;

  test('soltar move a subárvore em uma transação; desfazer 1× volta ao original', () => {
    const g = editorWith(doc, 2);
    const dnd = new DragAndDropController(g.ctx, g.view, gridLayout);
    expect(dnd.start(new MyEditor(g.view).posToOffset({ line: 2, ch: 0 }))).toBe(true);
    expect(dragged(g)).toBe(2);
    dnd.move(10, -10);
    expect(indicators(g)).toBe(1);
    dnd.drop();
    expect(text(g)).toBe('- three\n  - four\n- one\n  - two');
    expect([dragged(g), indicators(g)]).toEqual([0, 0]);
    expect(undo(g.view)).toBe(true);
    expect(text(g)).toBe(doc);
  });

  test('Esc (cancelar) não muda nada e tira linhas marcadas e indicador', () => {
    const g = editorWith(doc, 2);
    const before = sha256(text(g));
    const dnd = new DragAndDropController(g.ctx, g.view, gridLayout);
    dnd.start(new MyEditor(g.view).posToOffset({ line: 2, ch: 0 }));
    dnd.move(10, -10);
    expect([dragged(g), indicators(g)]).toEqual([2, 1]);
    dnd.cancel();
    expect(dnd.dragging).toBe(false);
    expect(sha256(text(g))).toBe(before);
    expect([dragged(g), indicators(g)]).toEqual([0, 0]);
    expect(undo(g.view)).toBe(false);
  });
});

describe('AC-I7.6 — guias (lógica)', () => {
  test('uma guia por item com filhos visíveis; clique dobra o DONO e anuncia', () => {
    const g = editorWith('- a\n  - a1\n    - a11\n  - a2\n- b', 4);
    const editor = new MyEditor(g.view);
    const specs = guideSpecs(g.ctx, editor, 0, editor.lastLine());
    expect(specs.map((s) => [s.ownerLine, s.fromLine, s.toLine, s.title])).toEqual([
      [0, 1, 3, 'Dobrar “a”'],
      [1, 2, 2, 'Dobrar “a1”'],
    ]);
    const before = sha256(text(g));
    foldGuideOwner(g.ctx, g.view, specs[1]!);
    expect(new MyEditor(g.view).getAllFoldedLines()).toEqual([1]);
    expect(g.announcements).toEqual(['Item dobrado.']);
    expect(sha256(text(g))).toBe(before);
    const folded = guideSpecs(g.ctx, new MyEditor(g.view), 0, editor.lastLine());
    expect(folded.map((s) => s.ownerLine)).toEqual([0]);
  });
});
