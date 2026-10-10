// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/services/ChangesApplicator.ts (diferença mínima entre a lista antes e depois, com
// as dobras refeitas nas linhas novas). Mudanças: tipos estritos; o editor é a interface mínima
// usada (o `MyEditor` junta tudo numa transação, ver `editor.ts`).

import type { MyEditor } from './editor';
import { isRangesIntersects, type List, type Position, type Root } from './root';

export type ApplyEditor = Pick<
  MyEditor,
  'getRange' | 'unfold' | 'replaceRange' | 'fold' | 'setSelections'
>;

function getAllChildrenReduceFn(acc: Map<number, List>, child: List): Map<number, List> {
  acc.set(child.getID(), child);
  child.getChildren().reduce(getAllChildrenReduceFn, acc);
  return acc;
}

function getAllChildren(root: Root): Map<number, List> {
  return root.getChildren().reduce(getAllChildrenReduceFn, new Map());
}

export class ChangesApplicator {
  apply(editor: ApplyEditor, prevRoot: Root, newRoot: Root): void {
    const changes = this.calculateChanges(editor, prevRoot, newRoot);
    if (changes) {
      const { replacement, changeFrom, changeTo } = changes;
      const { unfold, fold } = this.calculateFoldingOprations(
        prevRoot,
        newRoot,
        changeFrom,
        changeTo,
      );
      for (const line of unfold) editor.unfold(line);
      editor.replaceRange(replacement, changeFrom, changeTo);
      for (const line of fold) editor.fold(line);
    }
    editor.setSelections(newRoot.getSelections());
  }

  private calculateChanges(editor: ApplyEditor, prevRoot: Root, newRoot: Root) {
    const rootRange = prevRoot.getContentRange();
    const oldString = editor.getRange(rootRange[0], rootRange[1]);
    const newString = newRoot.print();

    const changeFrom = { ...rootRange[0] };
    const changeTo = { ...rootRange[1] };
    let oldTmp = oldString;
    let newTmp = newString;

    for (;;) {
      const nlIndex = oldTmp.lastIndexOf('\n');
      if (nlIndex < 0) break;
      const oldLine = oldTmp.slice(nlIndex);
      const newLine = newTmp.slice(-oldLine.length);
      if (oldLine !== newLine) break;
      oldTmp = oldTmp.slice(0, -oldLine.length);
      newTmp = newTmp.slice(0, -oldLine.length);
      const nlIndex2 = oldTmp.lastIndexOf('\n');
      changeTo.ch = nlIndex2 >= 0 ? oldTmp.length - nlIndex2 - 1 : oldTmp.length;
      changeTo.line--;
    }

    for (;;) {
      const nlIndex = oldTmp.indexOf('\n');
      if (nlIndex < 0) break;
      const oldLine = oldTmp.slice(0, nlIndex + 1);
      const newLine = newTmp.slice(0, oldLine.length);
      if (oldLine !== newLine) break;
      changeFrom.line++;
      oldTmp = oldTmp.slice(oldLine.length);
      newTmp = newTmp.slice(oldLine.length);
    }

    if (oldTmp === newTmp) return null;

    return { replacement: newTmp, changeFrom, changeTo };
  }

  private calculateFoldingOprations(
    prevRoot: Root,
    newRoot: Root,
    changeFrom: Position,
    changeTo: Position,
  ) {
    const changedRange: [Position, Position] = [changeFrom, changeTo];
    const prevLists = getAllChildren(prevRoot);
    const newLists = getAllChildren(newRoot);
    const unfold: number[] = [];
    const fold: number[] = [];

    for (const prevList of prevLists.values()) {
      if (!prevList.isFoldRoot()) continue;
      const newList = newLists.get(prevList.getID());
      if (!newList) continue;
      const prevListRange: [Position, Position] = [
        prevList.getFirstLineContentStart(),
        prevList.getContentEndIncludingChildren(),
      ];
      if (isRangesIntersects(prevListRange, changedRange)) {
        unfold.push(prevList.getFirstLineContentStart().line);
        fold.push(newList.getFirstLineContentStart().line);
      }
    }

    unfold.sort((a, b) => b - a);
    fold.sort((a, b) => b - a);

    return { unfold, fold };
  }
}
