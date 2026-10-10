// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/features/DragAndDrop.ts (arrastar pelo marcador, variantes de destino antes/depois/
// dentro, Esc cancela). Mudanças: sem `Notice`/`Platform`/classes no `body`; o marcador é o `•`
// do live preview (`.cm-md-bullet`), o número (`.cm-md-list-number`) ou o marcador cru; a medida
// do layout é uma interface (`DndLayout`) para os testes-ouro sem layout; indicador 2 px `accent`
// dentro do editor (sem SVG `data:`); linhas arrastadas com fundo `hover` e links em `fg` (brand
// E-1, DESIGN §R7.6.13); conteúdo mudado durante o arrasto cancela em silêncio (a soltura vira
// nada, como no upstream, sem o aviso).

import { getIndentUnit, indentString } from '@codemirror/language';
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from '@codemirror/view';
import { defaultIndentChars, type OutlinerContext } from '../context';
import { MyEditor } from '../model/editor';
import { cmpPos, type List, type Root } from '../model/root';
import {
  MoveListToDifferentPosition,
  type WhereToMove,
} from '../operations/move-list-to-different-position';

/** Medidas do layout usadas pelo arrasto (coordenadas da janela, como as do mouse). */
export interface DndLayout {
  /** x do início do texto de nível 1. */
  readonly leftPadding: number;
  /** Largura de um nível de indentação. */
  readonly tabWidth: number;
  /** Topo e altura da linha (0-based) na janela, ou `null` fora da área desenhada. */
  lineBox(line: number): { top: number; height: number } | null;
}

interface DropVariant {
  line: number;
  level: number;
  left: number;
  top: number;
  placeToMove: List;
  whereToMove: WhereToMove;
}

const dndStarted = StateEffect.define<number[]>({
  map: (lines, change) => lines.map((l) => change.mapPos(l)),
});
const dndEnded = StateEffect.define<null>();

const draggingLineDecoration = Decoration.line({ class: 'cm-outliner-dragging' });

const draggingLinesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(lines, tr) {
    lines = lines.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(dndStarted))
        lines = lines.update({ add: effect.value.map((l) => draggingLineDecoration.range(l)) });
      if (effect.is(dndEnded)) lines = Decoration.none;
    }
    return lines;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function isSameRoots(a: Root, b: Root | null): boolean {
  if (!b) return false;
  const [aStart, aEnd] = a.getContentRange();
  const [bStart, bEnd] = b.getContentRange();
  if (cmpPos(aStart, bStart) !== 0 || cmpPos(aEnd, bEnd) !== 0) return false;
  return a.print() === b.print();
}

/** Estado de um arrasto (upstream `DragAndDropState`). */
export class DragAndDropState {
  private dropVariants = new Map<string, DropVariant>();
  dropVariant: DropVariant | null = null;

  constructor(
    readonly view: EditorView,
    readonly editor: MyEditor,
    readonly root: Root,
    readonly list: List,
    readonly layout: DndLayout,
  ) {
    this.collectDropVariants();
  }

  hasDropVariants(): boolean {
    return this.dropVariants.size > 0;
  }

  calculateNearestDropVariant(x: number, y: number): void {
    const possible: DropVariant[] = [];
    for (const v of this.dropVariants.values()) {
      const { placeToMove } = v;
      const positionAfterList = v.whereToMove === 'after' || v.whereToMove === 'inside';
      const line = positionAfterList
        ? placeToMove.getContentEndIncludingChildren().line
        : placeToMove.getFirstLineContentStart().line;
      const box = this.layout.lineBox(line);
      if (!box) continue;
      v.left = this.layout.leftPadding + (v.level - 1) * this.layout.tabWidth;
      v.top = box.top + (positionAfterList ? box.height : 0);
      // Alinhamento vertical melhor (upstream).
      v.top -= 8;
      possible.push(v);
    }
    const nearestTop = possible.sort((a, b) => Math.abs(y - a.top) - Math.abs(y - b.top))[0]?.top;
    if (nearestTop === undefined) {
      this.dropVariant = null;
      return;
    }
    this.dropVariant =
      possible
        .filter((v) => Math.abs(v.top - nearestTop) <= 4)
        .sort((a, b) => Math.abs(x - a.left) - Math.abs(x - b.left))[0] ?? null;
  }

  private addDropVariant(v: DropVariant): void {
    this.dropVariants.set(`${v.line} ${v.level}`, v);
  }

  private collectDropVariants(): void {
    const visit = (lists: List[]) => {
      for (const placeToMove of lists) {
        const lineBefore = placeToMove.getFirstLineContentStart().line;
        const lineAfter = placeToMove.getContentEndIncludingChildren().line + 1;
        const level = placeToMove.getLevel();
        const base = { left: 0, top: 0, placeToMove };
        this.addDropVariant({ ...base, line: lineBefore, level, whereToMove: 'before' });
        this.addDropVariant({ ...base, line: lineAfter, level, whereToMove: 'after' });
        if (placeToMove === this.list) continue;
        if (placeToMove.isEmpty())
          this.addDropVariant({
            ...base,
            line: lineAfter,
            level: level + 1,
            whereToMove: 'inside',
          });
        else visit(placeToMove.getChildren());
      }
    };
    visit(this.root.getChildren());
  }
}

/** Medida real do layout (o `DndLayout` de produção). */
export function measureLayout(view: EditorView): DndLayout {
  const firstLine = view.contentDOM.querySelector('.cm-line');
  const leftPadding =
    firstLine?.getBoundingClientRect().left ?? view.contentDOM.getBoundingClientRect().left;
  const unit = indentString(view.state, getIndentUnit(view.state));
  let tabWidth = view.defaultCharacterWidth * getIndentUnit(view.state);
  for (let i = 1; i <= view.state.doc.lines; i++) {
    const line = view.state.doc.line(i);
    if (!line.text.startsWith(unit)) continue;
    const a = view.coordsAtPos(line.from, -1);
    const b = view.coordsAtPos(line.from + unit.length, -1);
    if (!a || !b) continue;
    tabWidth = b.left - a.left;
    break;
  }
  return {
    leftPadding,
    tabWidth,
    lineBox(line) {
      const pos = view.state.doc.line(Math.min(line + 1, view.state.doc.lines)).from;
      const coords = view.coordsAtPos(pos, -1);
      return coords ? { top: coords.top, height: view.lineBlockAt(pos).height } : null;
    },
  };
}

/**
 * Controlador do arrasto de UM editor: `start` (pelo marcador), `move`, `drop`, `cancel` (Esc). Os
 * eventos de mouse da produção chamam estes métodos; os testes-ouro também.
 */
export class DragAndDropController {
  private state: DragAndDropState | null = null;
  private indicator: HTMLElement | null = null;

  constructor(
    private ctx: OutlinerContext,
    readonly view: EditorView,
    private measure: (view: EditorView) => DndLayout = measureLayout,
  ) {}

  get dragging(): boolean {
    return this.state !== null;
  }

  /** Começa no item da posição `pos` (offset); `false` sem lista ou sem destino possível. */
  start(pos: number): boolean {
    const editor = new MyEditor(this.view);
    const cursor = editor.offsetToPos(pos);
    const root = this.ctx.parser.parse(editor, cursor);
    const list = root?.getListUnderLine(cursor.line);
    if (!root || !list) return false;
    const state = new DragAndDropState(this.view, editor, root, list, this.measure(this.view));
    if (!state.hasDropVariants()) return false;
    this.state = state;
    const lines: number[] = [];
    const fromLine = list.getFirstLineContentStart().line;
    const tillLine = list.getContentEndIncludingChildren().line;
    for (let i = fromLine; i <= tillLine; i++) lines.push(editor.posToOffset({ line: i, ch: 0 }));
    this.view.dispatch({ effects: dndStarted.of(lines) });
    this.view.dom.classList.add('cm-outliner-dnd-active');
    return true;
  }

  move(x: number, y: number): void {
    if (!this.state) return;
    this.state.calculateNearestDropVariant(x, y);
    this.drawIndicator();
  }

  drop(): void {
    if (!this.state) return;
    const { state } = this;
    this.stop();
    const { dropVariant, editor, root, list } = state;
    if (!dropVariant) return;
    if (!isSameRoots(root, this.ctx.parser.parse(editor, root.getContentStart()))) return;
    this.ctx.performer.eval(
      root,
      new MoveListToDifferentPosition(
        root,
        list,
        dropVariant.placeToMove,
        dropVariant.whereToMove,
        defaultIndentChars(this.view.state),
      ),
      editor,
      'move.drop',
    );
  }

  /** Esc: nada muda. `quiet` = sem transação (o view está sendo destruído/reconfigurado). */
  cancel(quiet = false): void {
    if (this.state) this.stop(quiet);
  }

  private stop(quiet = false): void {
    this.state = null;
    this.indicator?.remove();
    this.indicator = null;
    this.view.dom.classList.remove('cm-outliner-dnd-active');
    if (!quiet) this.view.dispatch({ effects: dndEnded.of(null) });
  }

  private drawIndicator(): void {
    const variant = this.state?.dropVariant;
    if (!variant) {
      this.indicator?.remove();
      this.indicator = null;
      return;
    }
    if (!this.indicator) {
      this.indicator = document.createElement('div');
      this.indicator.className = 'cm-outliner-drop';
      this.indicator.setAttribute('aria-hidden', 'true');
      this.view.dom.appendChild(this.indicator);
    }
    const box = this.view.dom.getBoundingClientRect();
    const content = this.view.contentDOM.getBoundingClientRect();
    this.indicator.style.top = `${variant.top + 8 - box.top}px`;
    this.indicator.style.left = `${variant.left - box.left}px`;
    this.indicator.style.width = `${Math.max(0, content.right - variant.left)}px`;
  }
}

/** Posição do marcador sob o mouse (`•`, número ou marcador cru), ou `null`. */
function bulletPosAt(view: EditorView, event: MouseEvent): number | null {
  const target = event.target as HTMLElement | null;
  const rendered = target?.closest('.cm-md-bullet, .cm-md-list-number');
  if (rendered && view.contentDOM.contains(rendered)) return view.posAtDOM(rendered);
  if (!target || !view.contentDOM.contains(target)) return null;
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  const line = view.state.doc.lineAt(pos);
  const match = /^([ \t]*)([-*+]|\d+\.)[ \t]/.exec(line.text);
  if (!match) return null;
  const from = line.from + (match[1]?.length ?? 0);
  return pos >= from && pos < from + (match[2]?.length ?? 0) ? pos : null;
}

/** Arrastar e soltar pelo marcador (mouse; equivalente de teclado = mover/indentar). */
export function dragAndDropExtension(ctx: OutlinerContext): Extension {
  return [
    draggingLinesField,
    ViewPlugin.define((view) => {
      const controller = new DragAndDropController(ctx, view);
      let preStart: number | null = null;
      const onMouseMove = (event: MouseEvent) => {
        if (preStart !== null) {
          const pos = preStart;
          preStart = null;
          controller.start(pos);
        }
        if (controller.dragging) controller.move(event.clientX, event.clientY);
      };
      const onMouseUp = () => {
        preStart = null;
        if (controller.dragging) controller.drop();
        detach();
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (controller.dragging && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          controller.cancel();
          detach();
        }
      };
      const detach = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.removeEventListener('keydown', onKeyDown, true);
      };
      const onMouseDown = (event: MouseEvent) => {
        if (event.button !== 0 || event.detail > 1) return;
        const pos = bulletPosAt(view, event);
        if (pos === null) return;
        event.preventDefault();
        event.stopPropagation();
        preStart = pos;
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        document.addEventListener('keydown', onKeyDown, true);
      };
      view.contentDOM.addEventListener('mousedown', onMouseDown, true);
      return {
        destroy() {
          view.contentDOM.removeEventListener('mousedown', onMouseDown, true);
          detach();
          controller.cancel(true);
        },
      };
    }),
  ];
}
