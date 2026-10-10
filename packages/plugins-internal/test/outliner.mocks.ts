// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/__mocks__.ts (`makeEditor`, `makeLogger`, `makeSettings`, `makeRoot`). Mudanças: Vitest
// (`vi.fn`) no lugar do Jest; o editor falso é o `Reader` do parser; o `Logger` do upstream virou o
// retorno `onReject` do `Parser` (o `makeParser` liga um ao outro com o método "parseList", como o
// `logger.bind("parseList")` do upstream); `makeRoot` falha quando o parser recusa a lista.

import { vi, type Mock } from 'vitest';
import { Parser, type Reader, type ReaderPosition } from '../src/outliner/model/parser';
import type { Root } from '../src/outliner/model/root';
import type { OutlinerSettings } from '../src/outliner/model/settings';

export interface EditorMockParams {
  text: string;
  cursor: ReaderPosition;
  getAllFoldedLines?: () => number[];
}

export type MockEditor = Reader & { lineCount(): number };

export function makeEditor(params: EditorMockParams): MockEditor {
  const text = params.text;
  const cursor = { ...params.cursor };

  return {
    getCursor: () => cursor,
    listSelections: () => [{ anchor: cursor, head: cursor }],
    getLine: (l: number) => text.split('\n')[l] ?? '',
    lastLine: () => text.split('\n').length - 1,
    lineCount: () => text.split('\n').length,
    getAllFoldedLines: params.getAllFoldedLines ?? (() => []),
  };
}

export interface Logger {
  log: Mock<(method: string, ...args: unknown[]) => void>;
}

export function makeLogger(): Logger {
  return { log: vi.fn<(method: string, ...args: unknown[]) => void>() };
}

export function makeSettings(): OutlinerSettings {
  return { keepCursorWithinContent: 'bullet-and-checkbox' };
}

export function makeParser(options: { logger?: Logger; settings?: OutlinerSettings } = {}): Parser {
  const { logger, settings } = { logger: makeLogger(), settings: makeSettings(), ...options };
  return new Parser(settings, (reason) => logger.log('parseList', reason));
}

export function makeRoot(options: {
  editor: Reader;
  settings?: OutlinerSettings;
  logger?: Logger;
}): Root {
  const root = makeParser(options).parse(options.editor);
  if (!root) throw new Error('makeRoot: o parser recusou a lista');
  return root;
}
