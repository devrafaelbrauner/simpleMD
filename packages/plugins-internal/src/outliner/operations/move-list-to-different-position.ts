// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/operations/MoveListToDifferentPosition.ts (soltura do arrastar: antes/depois/dentro
// de outro item, com a subárvore e o cursor preservados). Mudanças: tipos estritos.

import type { Operation } from '../model/perform';
import { recalculateNumericBullets, type List, type Root } from '../model/root';

interface CursorAnchor {
  cursorList: List;
  lineDiff: number;
  chDiff: number;
}

export type WhereToMove = 'before' | 'after' | 'inside';

export class MoveListToDifferentPosition implements Operation {
  private stopPropagation = false;
  private updated = false;

  constructor(
    private root: Root,
    private listToMove: List,
    private placeToMove: List,
    private whereToMove: WhereToMove,
    private defaultIndentChars: string,
  ) {}

  shouldStopPropagation(): boolean {
    return this.stopPropagation;
  }

  shouldUpdate(): boolean {
    return this.updated;
  }

  perform(): void {
    if (this.listToMove === this.placeToMove) return;

    this.stopPropagation = true;
    this.updated = true;

    const cursorAnchor = this.calculateCursorAnchor();
    this.moveList();
    this.changeIndent();
    this.restoreCursor(cursorAnchor);
    recalculateNumericBullets(this.root);
  }

  private calculateCursorAnchor(): CursorAnchor | null {
    const cursorLine = this.root.getCursor().line;

    const lines = [
      this.listToMove.getFirstLineContentStart().line,
      this.listToMove.getLastLineContentEnd().line,
      this.placeToMove.getFirstLineContentStart().line,
      this.placeToMove.getLastLineContentEnd().line,
    ];
    const listStartLine = Math.min(...lines);
    const listEndLine = Math.max(...lines);

    if (cursorLine < listStartLine || cursorLine > listEndLine) return null;

    const cursor = this.root.getCursor();
    const cursorList = this.root.getListUnderLine(cursor.line)!;
    const cursorListStart = cursorList.getFirstLineContentStart();
    const lineDiff = cursor.line - cursorListStart.line;
    const chDiff = cursor.ch - cursorListStart.ch;

    return { cursorList, lineDiff, chDiff };
  }

  private moveList(): void {
    this.listToMove.getParent()!.removeChild(this.listToMove);

    switch (this.whereToMove) {
      case 'before':
        this.placeToMove.getParent()!.addBefore(this.placeToMove, this.listToMove);
        break;
      case 'after':
        this.placeToMove.getParent()!.addAfter(this.placeToMove, this.listToMove);
        break;
      case 'inside':
        this.placeToMove.addBeforeAll(this.listToMove);
        break;
    }
  }

  private changeIndent(): void {
    const oldIndent = this.listToMove.getFirstLineIndent();
    const newIndent =
      this.whereToMove === 'inside'
        ? this.placeToMove.getFirstLineIndent() + this.defaultIndentChars
        : this.placeToMove.getFirstLineIndent();
    this.listToMove.unindentContent(0, oldIndent.length);
    this.listToMove.indentContent(0, newIndent);
  }

  private restoreCursor(cursorAnchor: CursorAnchor | null): void {
    if (cursorAnchor) {
      const cursorListStart = cursorAnchor.cursorList.getFirstLineContentStart();
      this.root.replaceCursor({
        line: cursorListStart.line + cursorAnchor.lineDiff,
        ch: cursorListStart.ch + cursorAnchor.chDiff,
      });
    } else {
      // Ao mover, a tela rola até o cursor: melhor trazer o cursor para a área visível do item.
      this.root.replaceCursor(this.listToMove.getLastLineContentEnd());
    }
  }
}
