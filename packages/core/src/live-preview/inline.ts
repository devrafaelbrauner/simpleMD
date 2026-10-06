import { syntaxTree } from '@codemirror/language';
import type { EditorState, Range } from '@codemirror/state';
import {
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { editorFocusField, isTouched } from './focus';
import { isTopLevel } from './table';

export interface VisibleRange {
  from: number;
  to: number;
}

/** Marcador de lista renderizado: `•` com a largura de 1ch do caractere que substitui (AC-3.5). */
export class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-md-bullet';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = '•';
    return span;
  }
}

// Especificações constantes no módulo: nenhuma alocação de spec por atualização (arch-frontend §2.5).
const hide = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });
const strongMark = Decoration.mark({ class: 'cm-md-strong' });
const emMark = Decoration.mark({ class: 'cm-md-em' });
const linkMark = Decoration.mark({ class: 'cm-md-link' });
const listNumberMark = Decoration.mark({ class: 'cm-md-list-number' });
const fenceDimMark = Decoration.mark({ class: 'cm-md-fence-dim' });
const codeLine = Decoration.line({ class: 'cm-md-codeblock' });
const tableSourceLine = Decoration.line({ class: 'cm-md-table-src' });
const headingLines = [1, 2, 3, 4, 5, 6].map((level) =>
  Decoration.line({ class: `cm-md-h${level}` }),
);

const HEADING = /^ATXHeading([1-6])$/;
const BLANK = /^[ \t]$/;

/**
 * Decorações em linha do live preview (R-3.1/R-3.2): função pura do `EditorState` e das faixas
 * visíveis. Só os nós que cruzam `ranges` são visitados (R-3.3, NFR-5). Código cercado e tabelas
 * não são percorridos por dentro, então nada de markdown é decorado dentro deles (AC-3.6).
 */
export function computeInlineDecorations(
  state: EditorState,
  ranges: readonly VisibleRange[],
): DecorationSet {
  const tree = syntaxTree(state);
  const doc = state.doc;
  const out: Range<Decoration>[] = [];
  // Um nó que cruza duas faixas visíveis é visitado duas vezes; só decora na primeira.
  const seen = new Set<string>();
  const once = (node: SyntaxNode): boolean => {
    const key = `${node.type.id}@${node.from}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const decoratedLines = new Set<number>();

  for (const range of ranges) {
    /** Classe de bloco em cada linha do nó que cai dentro desta faixa visível. */
    const blockLines = (node: SyntaxNode, deco: Decoration): void => {
      const start = Math.max(node.from, range.from);
      const end = Math.min(node.to, range.to);
      if (start > end) return;
      const last = doc.lineAt(end).number;
      for (let n = doc.lineAt(start).number; n <= last; n++) {
        const from = doc.line(n).from;
        if (decoratedLines.has(from)) continue;
        decoratedLines.add(from);
        out.push(deco.range(from));
      }
    };

    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (ref) => {
        const name = ref.name;
        const node = ref.node;

        const heading = HEADING.exec(name);
        if (heading) {
          if (!once(node)) return;
          const line = doc.lineAt(node.from);
          // A classe de nível fica sempre, para o tamanho da linha não pular ao revelar.
          out.push((headingLines[Number(heading[1]) - 1] ?? headingLines[0]!).range(line.from));
          if (!isTouched(state, line.from, line.to)) hideHeaderMarks(node, line.to);
          return;
        }

        switch (name) {
          case 'Emphasis':
          case 'StrongEmphasis': {
            if (!once(node) || isTouched(state, node.from, node.to)) return;
            const marks = node.getChildren('EmphasisMark');
            const first = marks[0];
            const last = marks[marks.length - 1];
            if (!first || !last || first === last || first.to >= last.from) return;
            for (const mark of marks) out.push(hide.range(mark.from, mark.to));
            out.push((name === 'Emphasis' ? emMark : strongMark).range(first.to, last.from));
            return;
          }
          case 'Link': {
            if (!once(node) || isTouched(state, node.from, node.to)) return;
            decorateLink(node);
            return;
          }
          case 'ListMark': {
            if (!once(node)) return;
            const list = node.parent?.parent?.name;
            const line = doc.lineAt(node.from);
            if (isTouched(state, line.from, line.to)) return;
            if (list === 'BulletList') out.push(bullet.range(node.from, node.to));
            else if (list === 'OrderedList') out.push(listNumberMark.range(node.from, node.to));
            return;
          }
          case 'FencedCode': {
            blockLines(node, codeLine);
            if (once(node) && !isTouched(state, node.from, node.to)) {
              for (const child of [
                ...node.getChildren('CodeMark'),
                ...node.getChildren('CodeInfo'),
              ]) {
                out.push(fenceDimMark.range(child.from, child.to));
              }
            }
            return false;
          }
          case 'Table': {
            // Tabela de topo revelada: fonte crua com fundo de bloco. Fora disso, o widget vem do
            // StateField (table.ts). Tabelas aninhadas em listas/citações ficam cruas (MELHORIAS).
            if (isTopLevel(node) && isTouched(state, node.from, node.to)) {
              blockLines(node, tableSourceLine);
            }
            return false;
          }
          default:
            return;
        }
      },
    });
  }

  return Decoration.set(out, true);

  /** Esconde `#…# ` no início e, se houver, ` #…#` no fim (título ATX fechado). */
  function hideHeaderMarks(node: SyntaxNode, lineEnd: number): void {
    let hiddenUpTo = node.from;
    for (const mark of node.getChildren('HeaderMark')) {
      if (mark.from === node.from) {
        let end = mark.to;
        while (end < lineEnd && BLANK.test(doc.sliceString(end, end + 1))) end++;
        out.push(hide.range(mark.from, end));
        hiddenUpTo = end;
      } else {
        let start = mark.from;
        while (start > hiddenUpTo && BLANK.test(doc.sliceString(start - 1, start))) start--;
        if (mark.to > start) out.push(hide.range(start, mark.to));
      }
    }
  }

  /**
   * Só o link em linha `[t](u)`: link de referência, autolink e imagem ficam crus (A-6). Esconde `[`
   * e `](u…)`; `t` vira `cm-md-link`. O link é um `<span>` sem `href` nem handler: não abre nada.
   */
  function decorateLink(node: SyntaxNode): void {
    if (doc.sliceString(node.from, node.from + 1) !== '[') return;
    let close: SyntaxNode | null = null;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name !== 'LinkMark') continue;
      if (doc.sliceString(child.from, child.to) === '(' && child.prevSibling?.name === 'LinkMark') {
        close = child.prevSibling;
        break;
      }
    }
    if (!close || close.from <= node.from + 1) return;
    // Plugins não podem substituir quebras de linha: um destino com `\n` fica cru.
    if (doc.sliceString(close.from, node.to).includes('\n')) return;
    out.push(hide.range(node.from, node.from + 1));
    out.push(linkMark.range(node.from + 1, close.from));
    out.push(hide.range(close.from, node.to));
  }
}

/** Decorações em linha só sobre `view.visibleRanges` (R-3.3, NFR-5). */
export const inlinePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = computeInlineDecorations(view.state, view.visibleRanges);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.startState.field(editorFocusField, false) !==
          update.state.field(editorFocusField, false) ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = computeInlineDecorations(update.state, update.view.visibleRanges);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
