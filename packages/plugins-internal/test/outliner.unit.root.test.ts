// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/root/__tests__/index.test.ts (teste de unidade, Jest → Vitest). Mudanças: imports do porte; editor falso,
// `Logger` e `Parser` de `./outliner.mocks`; ajustes de tipo estrito.
import { describe, expect, test } from 'vitest';
import {
  type Position,
  isRangesIntersects,
  recalculateNumericBullets,
} from '../src/outliner/model/root';

import { makeEditor, makeRoot } from './outliner.mocks';

function parseRanges(str: string): {
  a: [Position, Position];
  b: [Position, Position];
} {
  return {
    a: [
      { line: 0, ch: str.indexOf('[') },
      { line: 0, ch: str.indexOf(']') },
    ],
    b: [
      { line: 0, ch: str.indexOf('(') },
      { line: 0, ch: str.indexOf(')') },
    ],
  };
}

describe('isRangesIntersects', () => {
  const cases = [
    ['[--(-]--)', true],
    ['(--[-)--]', true],
    ['[--(--)--]', true],
    ['(--[--]--)', true],
    ['[--](--)', false],
    ['(--)[--]', false],
  ];

  test.each(cases)("when ranges are '%s' then result is %s", (ranges, result) => {
    const { a, b } = parseRanges(ranges as string);

    expect(isRangesIntersects(a, b)).toBe(result);
  });
});

describe('recalculateNumericBullets', () => {
  test('should return list under line', () => {
    const root = makeRoot({
      editor: makeEditor({
        text: '4. one\n\t3. two\n\t2. three\n1. four',
        cursor: { line: 0, ch: 0 },
      }),
    });

    recalculateNumericBullets(root);

    expect(root.print()).toBe('1. one\n\t1. two\n\t2. three\n2. four');
  });
});

describe('Root', () => {
  describe('getListUnderLine', () => {
    test('should return list under line', () => {
      const root = makeRoot({
        editor: makeEditor({
          text: '- one\n\t- two\n- three',
          cursor: { line: 0, ch: 0 },
        }),
      });

      const list = root.getListUnderLine(1);

      expect(list).toBeDefined();
      expect(list!.print()).toBe('\t- two\n');
    });

    test('should return list under line when line is note', () => {
      const root = makeRoot({
        editor: makeEditor({
          text: '- one\n\tnote1\n\t- two\n\t\tnote2\n- three',
          cursor: { line: 0, ch: 0 },
        }),
      });

      const list = root.getListUnderLine(3);

      expect(list).toBeDefined();
      expect(list!.print()).toBe('\t- two\n\t\tnote2\n');
    });
  });

  describe('getContentLinesRangeOf', () => {
    test('should return range of list', () => {
      const root = makeRoot({
        editor: makeEditor({
          text: '- one\n\t- two\n- three',
          cursor: { line: 0, ch: 0 },
        }),
      });

      const range = root.getContentLinesRangeOf(root.getChildren()[0]!.getChildren()[0]!);

      expect(range).toStrictEqual([1, 1]);
    });

    test('should return range of list when list has notes', () => {
      const root = makeRoot({
        editor: makeEditor({
          text: '- one\n\tnote1\n\t- two\n\t\tnote2\n- three',
          cursor: { line: 0, ch: 0 },
        }),
      });

      const range = root.getContentLinesRangeOf(root.getChildren()[0]!.getChildren()[0]!);

      expect(range).toStrictEqual([2, 3]);
    });
  });
});
