// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/services/__tests__/ChangesApplicator.test.ts (teste de unidade, Jest → Vitest). Mudanças: imports do porte; editor falso,
// `Logger` e `Parser` de `./outliner.mocks`; ajustes de tipo estrito.
import { describe, expect, test } from 'vitest';
import { makeEditor, makeRoot, type MockEditor } from './outliner.mocks';
import { List, type Root } from '../src/outliner/model/root';
import { ChangesApplicator, type ApplyEditor } from '../src/outliner/model/apply';

describe('changesApplicator', () => {
  test('should not touch folded lists if they are not changed', () => {
    const { actions, editor, prevRoot, newRoot } = makeArgs({
      editor: makeEditor({
        text: `
- 1
  - 2
    - 3
  - [ ] 4
- 5
`,
        cursor: { line: 4, ch: 9 },
        getAllFoldedLines: () => [2],
      }),

      changes: (root) => {
        root.getChildren()[0]!.addAfterAll(new List(root, '  ', '-', '[ ]', ' ', '[ ] ', false));
        root.replaceCursor({ line: 5, ch: 8 });
      },
    });
    const changesApplicator = new ChangesApplicator();

    changesApplicator.apply(editor, prevRoot, newRoot);

    expect(actions).toStrictEqual([
      ['getRange', ...newRoot.getContentRange()],
      ['replaceRange', '  - [ ] 4\n  - [ ] ', { line: 4, ch: 0 }, { line: 4, ch: 9 }],
      ['setSelections', [{ anchor: { line: 5, ch: 8 }, head: { line: 5, ch: 8 } }]],
    ]);
  });

  test('should touch folded lists if they are changed', () => {
    const { actions, editor, prevRoot, newRoot } = makeArgs({
      editor: makeEditor({
        text: `
- 1
  - 2
    - 3
  - [ ] 4
- 5
`,
        cursor: { line: 5, ch: 3 },
        getAllFoldedLines: () => [2],
      }),

      changes: (root) => {
        const list5 = root.getChildren()[1]!;
        const list5Parent = list5.getParent()!;
        list5Parent.removeChild(list5);
        list5Parent.addBeforeAll(list5);
        root.replaceCursor({ line: 1, ch: 3 });
      },
    });
    const changesApplicator = new ChangesApplicator();

    changesApplicator.apply(editor, prevRoot, newRoot);

    expect(actions).toStrictEqual([
      ['getRange', ...newRoot.getContentRange()],
      ['unfold', 2],
      [
        'replaceRange',
        '- 5\n- 1\n  - 2\n    - 3\n  - [ ] 4',
        { line: 1, ch: 0 },
        { line: 5, ch: 3 },
      ],
      ['fold', 3],
      ['setSelections', [{ anchor: { line: 1, ch: 3 }, head: { line: 1, ch: 3 } }]],
    ]);
  });
});

function makeArgs(opts: { editor: MockEditor; changes: (root: Root) => void }) {
  const actions: unknown[] = [];
  const prevRoot = makeRoot({
    editor: opts.editor,
  });
  const newRoot = prevRoot.clone();
  opts.changes(newRoot);
  const mockedEditor: ApplyEditor = {
    getRange: (...args) => {
      actions.push(['getRange', ...args]);
      return prevRoot.print();
    },
    unfold: (...args) => {
      actions.push(['unfold', ...args]);
    },
    replaceRange: (...args) => {
      actions.push(['replaceRange', ...args]);
    },
    setSelections: (...args) => {
      actions.push(['setSelections', ...args]);
    },
    fold: (...args) => {
      actions.push(['fold', ...args]);
    },
  };

  return {
    actions,
    editor: mockedEditor,
    prevRoot,
    newRoot,
  };
}
