import { closeCompletion, completionStatus } from '@codemirror/autocomplete';
import { indentLess, indentMore } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { Facet, Prec, type Extension } from '@codemirror/state';
import { keymap, type EditorView } from '@codemirror/view';

/**
 * Cadeia de contexto das teclas de comportamento (arch-frontend r7 §4.4, D-R7-F08; arch-ux §6.4).
 * Tab/Shift-Tab (só com `editor.captureTab`), `Mod-]`/`Mod-[` e `Mod-Alt-→/←` (sempre) são
 * oferecidos aos contribuidores nesta ordem: parada de snippet LaTeX (400) > célula de tabela (300)
 * > item de lista (200) > indentação (100). Dentro do slot, `priority` maior primeiro; empate =
 * ordem de configuração. O primeiro que devolve `true` encerra.
 */
export type ContextSlot = 'snippet' | 'table' | 'list' | 'indent';
/** `tab` = Tab/Shift-Tab; `move` = `Mod-Alt-→/←`; `indent` = `Mod-]`/`Mod-[`. */
export type ContextKind = 'tab' | 'move' | 'indent';

export interface ContextAction {
  /** Subprioridade dentro do slot (outliner 10 > fallback do núcleo 0). */
  readonly priority?: number;
  readonly kinds: readonly ContextKind[];
  run(view: EditorView, dir: 1 | -1, kind: ContextKind): boolean;
}

interface SlotAction extends ContextAction {
  readonly slot: ContextSlot;
}

const SLOT_RANK: Record<ContextSlot, number> = { snippet: 400, table: 300, list: 200, indent: 100 };

export const contextActionFacet = Facet.define<SlotAction>();

/** Registra uma ação num slot da cadeia (núcleo, S3 e, pelo contexto do host, S6/S7). */
export function contextAction(slot: ContextSlot, action: ContextAction): Extension {
  return contextActionFacet.of({ ...action, slot });
}

/**
 * Executa a primeira ação que aceitar a tecla. Com o popup do autocompletar aberto, Tab fecha o
 * popup sem aceitar (regra do r2 "Tab nunca aceita sugestão") e segue a cadeia.
 */
export function runContextChain(view: EditorView, dir: 1 | -1, kind: ContextKind): boolean {
  if (kind === 'tab' && completionStatus(view.state) !== null) closeCompletion(view);
  const actions = view.state
    .facet(contextActionFacet)
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => action.kinds.includes(kind))
    .sort(
      (a, b) =>
        SLOT_RANK[b.action.slot] - SLOT_RANK[a.action.slot] ||
        (b.action.priority ?? 0) - (a.action.priority ?? 0) ||
        a.index - b.index,
    );
  return actions.some(({ action }) => action.run(view, dir, kind));
}

/**
 * Última etapa (slot `indent`): Tab insere UMA unidade de indentação (seleção não vazia → indenta
 * as linhas) e Shift-Tab desindenta; `Mod-]`/`Mod-[` mantêm o `indentMore`/`indentLess` do CM.
 */
export const indentContextAction: Extension = contextAction('indent', {
  kinds: ['tab', 'indent'],
  run(view, dir, kind) {
    if (dir === -1) return indentLess(view);
    const { state } = view;
    // Somente leitura: não consome a tecla (como `indentMore`/`indentLess`; CR-ST-12).
    if (state.readOnly) return false;
    if (kind === 'indent' || state.selection.ranges.some((range) => !range.empty))
      return indentMore(view);
    view.dispatch(
      state.update(state.replaceSelection(state.facet(indentUnit)), {
        scrollIntoView: true,
        userEvent: 'input.indent',
      }),
    );
    return true;
  },
});

/** Tab/Shift-Tab pela cadeia; só existe no compartimento `#hostKeys` com a chave ligada. */
export const tabChainKeymap: Extension = Prec.highest(
  keymap.of([
    {
      key: 'Tab',
      run: (view) => runContextChain(view, 1, 'tab'),
      shift: (view) => runContextChain(view, -1, 'tab'),
    },
  ]),
);

/**
 * Classe B sempre ativa (arch-ux §6.4): `Mod-]`/`Mod-[` (item de lista → `indentMore/Less`) e
 * `Mod-Alt-→/←` (parada LaTeX → célula). Substitui na MESMA tecla o `Mod-]`/`Mod-[` do
 * `defaultKeymap`, cuja ação é a última etapa da cadeia.
 */
export const contextChainKeymap: Extension = Prec.high(
  keymap.of([
    { key: 'Mod-]', run: (view) => runContextChain(view, 1, 'indent') },
    { key: 'Mod-[', run: (view) => runContextChain(view, -1, 'indent') },
    { key: 'Mod-Alt-ArrowRight', run: (view) => runContextChain(view, 1, 'move') },
    { key: 'Mod-Alt-ArrowLeft', run: (view) => runContextChain(view, -1, 'move') },
  ]),
);
