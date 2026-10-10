// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/root/index.ts (árvore de uma lista: itens, notas, seleções, impressão). Mudanças:
// tipos estritos (pais/filhos anuláveis explícitos), `last()` do Obsidian trocado por índice.

export interface Position {
  ch: number;
  line: number;
}

export interface ListLine {
  text: string;
  from: Position;
  to: Position;
}

export interface Range {
  anchor: Position;
  head: Position;
}

export function cmpPos(a: Position, b: Position): number {
  return a.line - b.line || a.ch - b.ch;
}

export function maxPos(a: Position, b: Position): Position {
  return cmpPos(a, b) < 0 ? b : a;
}

export function minPos(a: Position, b: Position): Position {
  return cmpPos(a, b) < 0 ? a : b;
}

export function isRangesIntersects(a: [Position, Position], b: [Position, Position]): boolean {
  return cmpPos(a[1], b[0]) >= 0 && cmpPos(a[0], b[1]) <= 0;
}

/** Renumera `1.`, `2.`… por nível, como o upstream (só os itens numerados contam). */
export function recalculateNumericBullets(root: Root): void {
  function visit(parent: Root | List) {
    let index = 1;
    for (const child of parent.getChildren()) {
      if (/\d+\./.test(child.getBullet())) child.replateBullet(`${index++}.`);
      visit(child);
    }
  }
  visit(root);
}

let idSeq = 0;

export class List {
  private id: number;
  private parent: List | null = null;
  private children: List[] = [];
  private notesIndent: string | null = null;
  private lines: string[] = [];

  constructor(
    private root: Root,
    private indent: string,
    private bullet: string,
    private optionalCheckbox: string,
    private spaceAfterBullet: string,
    firstLine: string,
    private foldRoot: boolean,
  ) {
    this.id = idSeq++;
    this.lines.push(firstLine);
  }

  getID(): number {
    return this.id;
  }

  getNotesIndent(): string | null {
    return this.notesIndent;
  }

  setNotesIndent(notesIndent: string | null): void {
    if (this.notesIndent !== null) throw new Error(`Notes indent already provided`);
    this.notesIndent = notesIndent;
  }

  addLine(text: string): void {
    if (this.notesIndent === null)
      throw new Error(`Unable to add line, notes indent should be provided first`);
    this.lines.push(text);
  }

  replaceLines(lines: string[]): void {
    if (lines.length > 1 && this.notesIndent === null)
      throw new Error(`Unable to add line, notes indent should be provided first`);
    this.lines = lines;
  }

  getLineCount(): number {
    return this.lines.length;
  }

  getRoot(): Root {
    return this.root;
  }

  getChildren(): List[] {
    return this.children.concat();
  }

  getLinesInfo(): ListLine[] {
    const startLine = this.root.getContentLinesRangeOf(this)![0];
    return this.lines.map((row, i) => {
      const line = startLine + i;
      const startCh = i === 0 ? this.getContentStartCh() : this.notesIndent!.length;
      const endCh = startCh + row.length;
      return { text: row, from: { line, ch: startCh }, to: { line, ch: endCh } };
    });
  }

  getLines(): string[] {
    return this.lines.concat();
  }

  getFirstLineContentStart(): Position {
    const startLine = this.root.getContentLinesRangeOf(this)![0];
    return { line: startLine, ch: this.getContentStartCh() };
  }

  getFirstLineContentStartAfterCheckbox(): Position {
    const startLine = this.root.getContentLinesRangeOf(this)![0];
    return { line: startLine, ch: this.getContentStartCh() + this.getCheckboxLength() };
  }

  getLastLineContentEnd(): Position {
    const endLine = this.root.getContentLinesRangeOf(this)![1];
    const endCh =
      this.lines.length === 1
        ? this.getContentStartCh() + this.lines[0]!.length
        : this.notesIndent!.length + this.lines[this.lines.length - 1]!.length;
    return { line: endLine, ch: endCh };
  }

  getContentEndIncludingChildren(): Position {
    return this.getLastChild().getLastLineContentEnd();
  }

  private getLastChild(): List {
    const last = this.children[this.children.length - 1];
    return last ? last.getLastChild() : this;
  }

  private getContentStartCh(): number {
    return this.indent.length + this.bullet.length + 1;
  }

  isFolded(): boolean {
    if (this.foldRoot) return true;
    if (this.parent) return this.parent.isFolded();
    return false;
  }

  isFoldRoot(): boolean {
    return this.foldRoot;
  }

  getTopFoldRoot(): List | null {
    const above = this.parent?.getTopFoldRoot() ?? null;
    return above ?? (this.foldRoot ? this : null);
  }

  getLevel(): number {
    if (!this.parent) return 0;
    return this.parent.getLevel() + 1;
  }

  unindentContent(from: number, till: number): void {
    this.indent = this.indent.slice(0, from) + this.indent.slice(till);
    if (this.notesIndent !== null)
      this.notesIndent = this.notesIndent.slice(0, from) + this.notesIndent.slice(till);
    for (const child of this.children) child.unindentContent(from, till);
  }

  indentContent(indentPos: number, indentChars: string): void {
    this.indent = this.indent.slice(0, indentPos) + indentChars + this.indent.slice(indentPos);
    if (this.notesIndent !== null)
      this.notesIndent =
        this.notesIndent.slice(0, indentPos) + indentChars + this.notesIndent.slice(indentPos);
    for (const child of this.children) child.indentContent(indentPos, indentChars);
  }

  getFirstLineIndent(): string {
    return this.indent;
  }

  getBullet(): string {
    return this.bullet;
  }

  getSpaceAfterBullet(): string {
    return this.spaceAfterBullet;
  }

  getCheckboxLength(): number {
    return this.optionalCheckbox.length;
  }

  replateBullet(bullet: string): void {
    this.bullet = bullet;
  }

  getParent(): List | null {
    return this.parent;
  }

  addBeforeAll(list: List): void {
    this.children.unshift(list);
    list.parent = this;
  }

  addAfterAll(list: List): void {
    this.children.push(list);
    list.parent = this;
  }

  removeChild(list: List): void {
    const i = this.children.indexOf(list);
    this.children.splice(i, 1);
    list.parent = null;
  }

  addBefore(before: List, list: List): void {
    const i = this.children.indexOf(before);
    this.children.splice(i, 0, list);
    list.parent = this;
  }

  addAfter(before: List, list: List): void {
    const i = this.children.indexOf(before);
    this.children.splice(i + 1, 0, list);
    list.parent = this;
  }

  getPrevSiblingOf(list: List): List | null {
    const i = this.children.indexOf(list);
    return i > 0 ? this.children[i - 1]! : null;
  }

  getNextSiblingOf(list: List): List | null {
    const i = this.children.indexOf(list);
    return i >= 0 && i < this.children.length ? (this.children[i + 1] ?? null) : null;
  }

  isEmpty(): boolean {
    return this.children.length === 0;
  }

  print(): string {
    let res = '';
    for (let i = 0; i < this.lines.length; i++) {
      res += i === 0 ? this.indent + this.bullet + this.spaceAfterBullet : this.notesIndent;
      res += this.lines[i];
      res += '\n';
    }
    for (const child of this.children) res += child.print();
    return res;
  }

  clone(newRoot: Root): List {
    const clone = new List(
      newRoot,
      this.indent,
      this.bullet,
      this.optionalCheckbox,
      this.spaceAfterBullet,
      '',
      this.foldRoot,
    );
    clone.id = this.id;
    clone.lines = this.lines.concat();
    clone.notesIndent = this.notesIndent;
    for (const child of this.children) clone.addAfterAll(child.clone(newRoot));
    return clone;
  }
}

export class Root {
  private rootList = new List(this, '', '', '', '', '', false);
  private selections: Range[] = [];

  constructor(
    private start: Position,
    private end: Position,
    selections: Range[],
  ) {
    this.replaceSelections(selections);
  }

  getRootList(): List {
    return this.rootList;
  }

  getContentRange(): [Position, Position] {
    return [this.getContentStart(), this.getContentEnd()];
  }

  getContentStart(): Position {
    return { ...this.start };
  }

  getContentEnd(): Position {
    return { ...this.end };
  }

  getSelections(): Range[] {
    return this.selections.map((s) => ({ anchor: { ...s.anchor }, head: { ...s.head } }));
  }

  hasSingleCursor(): boolean {
    if (!this.hasSingleSelection()) return false;
    const selection = this.selections[0]!;
    return (
      selection.anchor.line === selection.head.line && selection.anchor.ch === selection.head.ch
    );
  }

  hasSingleSelection(): boolean {
    return this.selections.length === 1;
  }

  getSelection(): Range & { from: number; to: number } {
    const selection = this.selections[this.selections.length - 1]!;
    const from = selection.anchor.ch > selection.head.ch ? selection.head.ch : selection.anchor.ch;
    const to = selection.anchor.ch > selection.head.ch ? selection.anchor.ch : selection.head.ch;
    return { ...selection, from, to };
  }

  getCursor(): Position {
    return { ...this.selections[this.selections.length - 1]!.head };
  }

  replaceCursor(cursor: Position): void {
    this.selections = [{ anchor: cursor, head: cursor }];
  }

  replaceSelections(selections: Range[]): void {
    if (selections.length < 1) throw new Error(`Unable to create Root without selections`);
    this.selections = selections;
  }

  getListUnderCursor(): List {
    return this.getListUnderLine(this.getCursor().line)!;
  }

  getListUnderLine(line: number): List | null {
    if (line < this.start.line || line > this.end.line) return null;
    let result: List | null = null;
    let index: number = this.start.line;
    const visitArr = (ll: List[]) => {
      for (const l of ll) {
        const listFromLine = index;
        const listTillLine = listFromLine + l.getLineCount() - 1;
        if (line >= listFromLine && line <= listTillLine) {
          result = l;
        } else {
          index = listTillLine + 1;
          visitArr(l.getChildren());
        }
        if (result !== null) return;
      }
    };
    visitArr(this.rootList.getChildren());
    return result;
  }

  getContentLinesRangeOf(list: List): [number, number] | null {
    let result: [number, number] | null = null;
    let line: number = this.start.line;
    const visitArr = (ll: List[]) => {
      for (const l of ll) {
        const listFromLine = line;
        const listTillLine = listFromLine + l.getLineCount() - 1;
        if (l === list) {
          result = [listFromLine, listTillLine];
        } else {
          line = listTillLine + 1;
          visitArr(l.getChildren());
        }
        if (result !== null) return;
      }
    };
    visitArr(this.rootList.getChildren());
    return result;
  }

  getChildren(): List[] {
    return this.rootList.getChildren();
  }

  print(): string {
    let res = '';
    for (const child of this.rootList.getChildren()) res += child.print();
    return res.replace(/\n$/, '');
  }

  clone(): Root {
    const clone = new Root({ ...this.start }, { ...this.end }, this.getSelections());
    clone.rootList = this.rootList.clone(clone);
    return clone;
  }
}
