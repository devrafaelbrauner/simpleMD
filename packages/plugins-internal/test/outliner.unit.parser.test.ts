// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/services/__tests__/Parser.test.ts (teste de unidade, Jest → Vitest). Mudanças: imports do porte; editor falso,
// `Logger` e `Parser` de `./outliner.mocks`; ajustes de tipo estrito.
import { describe, expect, test } from 'vitest';
import { makeEditor, makeLogger, makeParser } from './outliner.mocks';

describe('parseList', () => {
  test('should parse list with notes and sublists', () => {
    const parser = makeParser();
    const editor = makeEditor({
      text: `
- one
  side
\t- two
\t\t- three
\t\t\tnote
\t- four
`.trim(),
      cursor: { line: 0, ch: 0 },
    });

    const list = parser.parse(editor);

    expect(list).toBeDefined();
    expect(list).toMatchObject(
      expect.objectContaining({
        rootList: expect.objectContaining({
          children: [
            expect.objectContaining({
              indent: '',
              bullet: '-',
              notesIndent: '  ',
              lines: ['one', 'side'],
              children: [
                expect.objectContaining({
                  indent: '\t',
                  bullet: '-',
                  notesIndent: null,
                  lines: ['two'],
                  children: [
                    expect.objectContaining({
                      indent: '\t\t',
                      bullet: '-',
                      notesIndent: '\t\t\t',
                      lines: ['three', 'note'],
                    }),
                  ],
                }),
                expect.objectContaining({
                  indent: '\t',
                  bullet: '-',
                  notesIndent: null,
                  lines: ['four'],
                }),
              ],
            }),
          ],
        }),
      }),
    );
    expect(list!.print()).toBe('- one\n  side\n\t- two\n\t\t- three\n\t\t\tnote\n\t- four');
  });

  test('should parse second list', () => {
    const parser = makeParser();
    const editor = makeEditor({
      text: `
- one
- two

- three
- four
`.trim(),
      cursor: { line: 3, ch: 3 },
    });

    const list = parser.parse(editor);

    expect(list).toBeDefined();
    expect(list!.print()).toBe('- three\n- four');
  });

  test('should error if indent is not match 1', () => {
    const logger = makeLogger();
    const parser = makeParser({ logger });
    const editor = makeEditor({
      text: '- one\n  - two\n\t- three',
      cursor: { line: 0, ch: 0 },
    });

    const list = parser.parse(editor);

    expect(list).toBeNull();
    expect(logger.log).toHaveBeenCalledWith(
      'parseList',
      `Unable to parse list: expected indent "S", got "T"`,
    );
  });

  test('should error if indent is not match 2', () => {
    const logger = makeLogger();
    const parser = makeParser({ logger });
    const editor = makeEditor({
      text: '- one\n\t- two\n  - three',
      cursor: { line: 0, ch: 0 },
    });

    const list = parser.parse(editor);

    expect(list).toBeNull();
    expect(logger.log).toHaveBeenCalledWith(
      'parseList',
      `Unable to parse list: expected indent "T", got "S"`,
    );
  });

  test('should error if note indent is not match', () => {
    const logger = makeLogger();
    const parser = makeParser({ logger });
    const editor = makeEditor({
      text: '- one\n\t- two\n  three',
      cursor: { line: 0, ch: 0 },
    });

    const list = parser.parse(editor);

    expect(list).toBeNull();
    expect(logger.log).toHaveBeenCalledWith(
      'parseList',
      `Unable to parse list: expected indent "T", got "SS"`,
    );
  });

  test('should parse list with tab just after the list', () => {
    const logger = makeLogger();
    const parser = makeParser({ logger });
    const editor = makeEditor({
      text: '- one\n\t- two\n\t\n',
      cursor: { line: 0, ch: 0 },
    });

    const list = parser.parse(editor);

    expect(logger.log).not.toHaveBeenCalled();
    expect(list).toBeTruthy();
  });
});
