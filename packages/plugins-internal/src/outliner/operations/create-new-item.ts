// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/operations/CreateNewItem.ts (Enter: novo item no mesmo nível ou no nível dos filhos,
// mantendo `[ ]`). Mudanças: tipos estritos; o Zoom do Obsidian não existe (faixa sempre `null`).

import type { Operation } from '../model/perform';
import { List, recalculateNumericBullets, type Position, type Root } from '../model/root';
import { checkboxRe, isEmptyLineOrEmptyCheckbox } from '../utils/checkbox';

export interface GetZoomRange {
  getZoomRange(): { from: Position; to: Position } | null;
}

export class CreateNewItem implements Operation {
  private stopPropagation = false;
  private updated = false;

  constructor(
    private root: Root,
    private defaultIndentChars: string,
    private getZoomRange: GetZoomRange,
    private after: boolean = true,
  ) {}

  shouldStopPropagation(): boolean {
    return this.stopPropagation;
  }

  shouldUpdate(): boolean {
    return this.updated;
  }

  perform(): void {
    const { root } = this;

    if (!root.hasSingleSelection()) return;

    const selection = root.getSelection();
    if (!selection || selection.anchor.line !== selection.head.line) return;

    const list = root.getListUnderCursor();
    const lines = list.getLinesInfo();

    if (lines.length === 1 && isEmptyLineOrEmptyCheckbox(lines[0]!.text)) return;

    const cursor = root.getCursor();
    const lineUnderCursor = lines.find((l) => l.from.line === cursor.line);

    if (!lineUnderCursor || cursor.ch < lineUnderCursor.from.ch) return;

    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const line of lines) {
      if (cursor.line > line.from.line) {
        oldLines.push(line.text);
      } else if (cursor.line === line.from.line) {
        oldLines.push(line.text.slice(0, selection.from - line.from.ch));
        newLines.push(line.text.slice(selection.to - line.from.ch));
      } else if (cursor.line < line.from.line) {
        newLines.push(line.text);
      }
    }

    const codeBlockBacticks = oldLines.join('\n').split('```').length - 1;
    const isInsideCodeblock = codeBlockBacticks > 0 && codeBlockBacticks % 2 !== 0;

    if (isInsideCodeblock) return;

    this.stopPropagation = true;
    this.updated = true;

    const zoomRange = this.getZoomRange.getZoomRange();
    const listIsZoomingRoot = Boolean(
      zoomRange &&
      list.getFirstLineContentStart().line >= zoomRange.from.line &&
      list.getLastLineContentEnd().line <= zoomRange.from.line,
    );

    const hasChildren = !list.isEmpty();
    const childIsFolded = list.isFoldRoot();
    const endPos = list.getLastLineContentEnd();
    const endOfLine = cursor.line === endPos.line && cursor.ch === endPos.ch;

    const onChildLevel =
      this.after && (listIsZoomingRoot || (hasChildren && !childIsFolded && endOfLine));

    const firstChild = list.getChildren()[0];
    const indent = onChildLevel
      ? firstChild
        ? firstChild.getFirstLineIndent()
        : list.getFirstLineIndent() + this.defaultIndentChars
      : list.getFirstLineIndent();

    const bullet = onChildLevel && firstChild ? firstChild.getBullet() : list.getBullet();

    const spaceAfterBullet =
      onChildLevel && firstChild ? firstChild.getSpaceAfterBullet() : list.getSpaceAfterBullet();

    const prefix = oldLines[0]!.match(checkboxRe) ? '[ ] ' : '';

    const newList = new List(
      list.getRoot(),
      indent,
      bullet,
      prefix,
      spaceAfterBullet,
      prefix + newLines.shift(),
      false,
    );

    if (newLines.length > 0) {
      newList.setNotesIndent(list.getNotesIndent());
      for (const line of newLines) newList.addLine(line);
    }

    if (onChildLevel) {
      list.addBeforeAll(newList);
    } else {
      if (this.after && (!childIsFolded || !endOfLine)) {
        for (const child of list.getChildren()) {
          list.removeChild(child);
          newList.addAfterAll(child);
        }
      }

      if (this.after) list.getParent()!.addAfter(list, newList);
      else list.getParent()!.addBefore(list, newList);
    }

    list.replaceLines(oldLines);

    const newListStart = newList.getFirstLineContentStart();
    root.replaceCursor({ line: newListStart.line, ch: newListStart.ch + prefix.length });

    recalculateNumericBullets(root);
  }
}
