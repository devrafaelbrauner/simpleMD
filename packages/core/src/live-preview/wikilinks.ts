import type { EditorState } from '@codemirror/state';
import {
  Decoration,
  ViewPlugin,
  WidgetType,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view';
import { visibleText } from '../links/target';
import { resolveInEditor, wikilinkIndexFacet, type WikilinkIndex } from '../wikilinks/facet';
import {
  readWikilink,
  WIKILINK_HEADING_SEPARATOR,
  wikilinkLabel,
  wikilinkLabelRange,
} from '../wikilinks/parse';
import { WIKILINK_NODES } from '../wikilinks/syntax';
import { hide, redecorate, type InlineContributor } from './context';

/** O `#` entre alvo e título aparece como ` › ` (R-I2.2). */
class HeadingSeparator extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-md-wikilink-sep';
    span.textContent = WIKILINK_HEADING_SEPARATOR;
    return span;
  }

  override eq(): boolean {
    return true;
  }
}

const separator = Decoration.replace({ widget: new HeadingSeparator() });

/**
 * Wikilinks no live preview (R-I2.2; DESIGN §R7.6.4; DA-R7-7). Fora do cursor: `[[`, `]]`, alvo
 * (quando há apelido) e `|` escondidos; rótulo = apelido > `alvo › Título` > alvo, numa marca
 * `cm-md-link cm-md-wikilink` (look de link, gesto e E-1 de S1; JEV D-R7-S2-05) com `role="link"`,
 * `data-testid="cm-wikilink"`, `data-resolved` e nome STR-147. Inexistente: `cm-md-wikilink-missing`
 * (atenuado + sublinhado tracejado; nunca só a cor, P33). `![[x]]` não é nó `WikiLink` (fica cru).
 */
export const wikilinks: InlineContributor = {
  nodes: [WIKILINK_NODES.link],
  enter(node, ctx) {
    if (!ctx.once(node) || ctx.isTouched(node.from, node.to)) return false;
    const info = readWikilink(node, ctx.doc);
    const [from, to] = wikilinkLabelRange(info);
    const resolution = resolveInEditor(ctx.state, info.target);
    const label = wikilinkLabel(info);
    const resolved = resolution.kind === 'resolved';
    const where = resolved
      ? info.heading === null
        ? resolution.path
        : `${resolution.path}${WIKILINK_HEADING_SEPARATOR}${info.heading}`
      : null;
    if (from > node.from) ctx.out.push(hide.range(node.from, from));
    ctx.out.push(
      Decoration.mark({
        class: resolved
          ? 'cm-md-link cm-md-wikilink'
          : 'cm-md-link cm-md-wikilink cm-md-wikilink-missing',
        attributes: {
          role: 'link',
          'data-testid': 'cm-wikilink',
          'data-resolved': String(resolved),
          // Controle/formatação invisível (bidi, largura zero) vira `%HH` no que se lê (CR-S2-02).
          'aria-label': visibleText(
            where === null ? `${label} (nota inexistente)` : `${label} (nota: ${where})`,
          ),
        },
      }).range(from, to),
    );
    if (!info.aliasRange && info.targetRange && info.headingRange)
      ctx.out.push(separator.range(info.targetRange[1], info.headingRange[0]));
    if (to < node.to) ctx.out.push(hide.range(to, node.to));
    return false;
  },
};

/** Pedaço da dica W1 (`dest` = caminho em mono; `hint` = atenuado; `text` = comum). */
export interface TipPart {
  readonly kind: 'dest' | 'hint' | 'text';
  readonly text: string;
}

/**
 * Texto da dica W1 de um wikilink (STR-148): existente "<caminho> · ⌘-clique para abrir";
 * ambíguo "Abre <caminho>. Outras notas com este nome: <até 3> (+<k>)"; inexistente
 * "Nota inexistente. ⌘-clique cria “<caminho>”." (Ctrl-clique fora do macOS); inexistente com nome
 * que o clique recusaria → "Nota inexistente. <aviso STR-150>" (CR-S2-03: dica = clique). Caminhos
 * com controle/formatação invisível aparecem codificados (`%HH`; CR-S2-02).
 */
export function wikilinkTipParts(state: EditorState, target: string, mac: boolean): TipPart[] {
  const gesture = mac ? '⌘-clique' : 'Ctrl-clique';
  const resolution = resolveInEditor(state, target);
  if (resolution.kind === 'missing') {
    if (resolution.refused !== undefined)
      return [{ kind: 'text', text: `Nota inexistente. ${resolution.refused}` }];
    if (resolution.createPath === '') return [{ kind: 'text', text: 'Nota inexistente.' }];
    return [
      { kind: 'text', text: `Nota inexistente. ${gesture} cria “` },
      { kind: 'dest', text: visibleText(resolution.createPath) },
      { kind: 'text', text: '”.' },
    ];
  }
  if (resolution.otherCount === 0) {
    return [
      { kind: 'dest', text: visibleText(resolution.path) },
      { kind: 'hint', text: ` · ${gesture} para abrir` },
    ];
  }
  const extra = resolution.otherCount - resolution.others.length;
  return [
    { kind: 'text', text: 'Abre ' },
    { kind: 'dest', text: visibleText(resolution.path) },
    { kind: 'text', text: '. Outras notas com este nome: ' },
    { kind: 'dest', text: visibleText(resolution.others.join(', ')) },
    ...(extra > 0 ? [{ kind: 'text' as const, text: ` (+${extra})` }] : []),
  ];
}

/**
 * Assina o índice de wikilinks do app e, quando a versão muda (o conjunto de notas mudou), pede ao
 * driver em linha que refaça só o viewport (efeito `redecorate`; nenhuma mudança de texto).
 */
export const wikilinkIndexWatcher = ViewPlugin.fromClass(
  class {
    #index: WikilinkIndex | null = null;
    #off: (() => void) | null = null;
    #version = -1;
    #destroyed = false;

    constructor(readonly view: EditorView) {
      this.#watch(view.state.facet(wikilinkIndexFacet));
    }

    update(update: ViewUpdate) {
      const index = update.state.facet(wikilinkIndexFacet);
      if (index !== this.#index) {
        this.#watch(index);
        this.#schedule();
      }
    }

    #watch(index: WikilinkIndex | null) {
      this.#off?.();
      this.#index = index;
      this.#version = index?.version ?? -1;
      this.#off = index
        ? index.subscribe(() => {
            if (index.version === this.#version) return;
            this.#version = index.version;
            this.#schedule();
          })
        : null;
    }

    /** Fora do ciclo de atualização do CM (o aviso pode chegar durante um `dispatch`). */
    #schedule() {
      queueMicrotask(() => {
        if (!this.#destroyed) this.view.dispatch({ effects: redecorate.of(null) });
      });
    }

    destroy() {
      this.#off?.();
      this.#destroyed = true;
      this.#off = null;
    }
  },
);
