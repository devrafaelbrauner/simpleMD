// Portado de retronav/ixora@1734bce24307fd80c4ea538257efb6f612dc9715 (Apache-2.0), © Pranav Karawale. Modificado para o simpleMD.
// Origem: packages/ixora/src/plugins/list.ts (`TaskListsPlugin`/`CheckboxWidget`: `TaskMarker`
// trocado por uma caixa fora do cursor; clique troca o caractere). Mudanças: `span role="checkbox"`
// não focável no lugar do `<input>` (A-32/A-34), 5 estados (R-I9.2), texto atenuado sem tachado,
// a troca passa pela semântica registrada (`tasks/semantics.ts`) e o clique é um handler do editor.
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { isTaskDone, toggleTasks } from '../tasks/semantics';
import type { InlineContributor } from './context';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** `i-check` do sprite r2 (mesmo traço), desenhado em linha: nenhum `href` dentro de `.cm-content`. */
const CHECK_PATH = 'M5 12.5l4.5 4.5L19 7.5';

/** `aria-checked` por estado (UX-R7-D17): `x`/`X` = true, `/` = mixed, demais = false. */
function ariaChecked(status: string): 'true' | 'false' | 'mixed' {
  if (isTaskDone(status)) return 'true';
  return status === '/' ? 'mixed' : 'false';
}

/**
 * Caixa de tarefa (DESIGN §R7.6.2; DA-R7-4): `<span class="cm-md-task" data-testid="cm-task"
 * role="checkbox" aria-checked data-status>`, não focável, sem filhos focáveis nem de texto
 * acessível (o traço de `[-]` e o caractere de um estado desconhecido são `aria-hidden`).
 */
export class TaskCheckboxWidget extends WidgetType {
  constructor(
    readonly status: string,
    readonly text: string,
  ) {
    super();
  }

  override eq(other: TaskCheckboxWidget): boolean {
    return other.status === this.status && other.text === this.text;
  }

  toDOM(): HTMLElement {
    const box = document.createElement('span');
    box.className = 'cm-md-task';
    box.dataset.testid = 'cm-task';
    box.dataset.status = this.status === 'X' ? 'x' : this.status;
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', ariaChecked(this.status));
    box.setAttribute(
      'aria-label',
      this.status === '-' ? `Tarefa cancelada: ${this.text}` : `Tarefa: ${this.text}`,
    );
    if (isTaskDone(this.status)) {
      const svg = box.appendChild(document.createElementNS(SVG_NS, 'svg'));
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      svg.appendChild(document.createElementNS(SVG_NS, 'path')).setAttribute('d', CHECK_PATH);
    } else if (this.status !== ' ' && this.status !== '/') {
      const glyph = box.appendChild(document.createElement('span'));
      glyph.className = 'cm-md-task-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = this.status === '-' ? '–' : this.status;
    }
    return box;
  }

  /** O editor recebe o `mousedown` (alternância em `taskClickHandler`). */
  override ignoreEvent(event: Event): boolean {
    return event.type !== 'mousedown';
  }
}

const doneText = Decoration.mark({ class: 'cm-md-task-done' });

/**
 * Tarefas (R-I1.3): `[c]` vira a caixa fora do cursor (cursor dentro de `[c]` → cru); tarefa feita
 * (`x`/`X`) ou cancelada (`-`) tem o texto `cm-md-task-done` (atenuado, sem tachado). O marcador de
 * lista segue o r1 (`lists.ts`).
 */
export const tasks: InlineContributor = {
  nodes: ['TaskMarker'],
  enter(node, ctx) {
    if (!ctx.once(node)) return;
    const task = node.parent;
    const status = ctx.doc.sliceString(node.from + 1, node.from + 2);
    const textTo = task ? task.to : node.to;
    if ((isTaskDone(status) || status === '-') && textTo > node.to)
      ctx.out.push(doneText.range(node.to, textTo));
    if (ctx.isTouched(node.from, node.to)) return;
    const text = ctx.doc.sliceString(node.to, textTo).replace(/\s+/g, ' ').trim();
    ctx.out.push(
      Decoration.replace({ widget: new TaskCheckboxWidget(status, text) }).range(
        node.from,
        node.to,
      ),
    );
  },
};

/** Marcador `[c]` válido em `pos`? (o DOM pode estar um passo atrás do documento). */
const MARKER = /^\[[^\]\n]\]$/;

/**
 * Clique na caixa (R-I1.3, AC-I1.5): alterna pela semântica em vigor, num passo de desfazer, sem
 * mover o cursor e sem anúncio (gesto visual).
 */
export const taskClickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0) return false;
    const box = (event.target as Element | null)?.closest?.('.cm-md-task');
    if (!box || !view.contentDOM.contains(box) || view.state.readOnly) return false;
    const pos = view.posAtDOM(box);
    const marker = view.state.doc.sliceString(pos, pos + 3);
    if (!MARKER.test(marker)) return false;
    event.preventDefault();
    toggleTasks(view, [{ markerFrom: pos, status: marker.charAt(1) }], false);
    return true;
  },
});
