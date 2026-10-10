import {
  forEachDiagnostic,
  linter,
  nextDiagnostic,
  openLintPanel,
  previousDiagnostic,
  setDiagnosticsEffect,
  type Diagnostic,
} from '@codemirror/lint';
import {
  EditorState,
  RangeSet,
  StateEffect,
  StateField,
  type EditorState as State,
  type Extension,
} from '@codemirror/state';
import {
  closeHoverTooltips,
  EditorView,
  gutter,
  GutterMarker,
  hoverTooltip,
  keymap,
  showTooltip,
  ViewPlugin,
  type Tooltip,
  type TooltipView,
} from '@codemirror/view';
import type { InternalHostContext, ProblemsCommands } from '@simplemd/plugin-api/internal/host';

/**
 * UI compartilhada dos diagnósticos do lint (S5) e do LanguageTool (S8) — arch-frontend r7 §10.2
 * itens 1–6, DA-R7-13, D-R7-F14b/F26/F29/F30, DESIGN §R7.6.11. O `@codemirror/lint` fica só como
 * estado, painel e navegação; a apresentação é toda daqui:
 *
 * 1. calha própria `cm-gutter-problems` (glifo `info`/`warn` desenhado em linha, o mais forte da
 *    linha vence; nenhum `lintGutter()`, cujo marcador usa `data:`);
 * 2. sublinhados por `markClass` (`cm-lintRange-lint|grammar|spelling`) com `text-decoration`; o tema
 *    zera o `background-image` `data:` do pacote (CSP `img-src 'self' blob:`);
 * 3. painel W5 com frases pt-BR, cabeçalho "Problemas" e ícone de fechar;
 * 4. a dica padrão do pacote escondida (`tooltipFilter`);
 * 5. o cartão do problema W2 (hover sem foco; `Mod-Shift-Enter` com foco no 1º botão);
 * 6. os comandos `problems:*` e o keymap `Mod-Shift-M`/`F8`/`Shift-F8`.
 *
 * O lint e o LT importam a MESMA constante `diagnosticsUi` (o CM elimina a duplicata quando os dois
 * estão ligados); `diagnosticsExtension(host)` junta a constante às ligações de privilégio do host
 * (alvo de interação, dono do Escape `card`, facet dos comandos), que podem repetir sem efeito.
 * Nunca há ação "Corrigir": um cartão só tem as ações que a fonte declara (AC-I5.4).
 */

/** Quem produziu o diagnóstico (`data-source` do cartão). */
export type ProblemSource = 'lint' | 'languagetool';

/** Estilo do sublinhado e do glifo: lint pontilhado `muted`; LT gramática tracejado; ortografia ondulado. */
export type ProblemKind = 'lint' | 'grammar' | 'spelling';

/** `data-action` dos botões do cartão (DESIGN §R7.6.11, arch-frontend §10.2 item 5). */
export type ProblemActionKind = 'replace' | 'ignore' | 'dictionary' | 'disable-rule' | 'learn-more';

export interface ProblemAction {
  readonly action: ProblemActionKind;
  /** Texto visível ("Trocar por “x”", "Ignorar", "Saiba mais"…). */
  readonly label: string;
  /** Nome acessível quando difere do visível; precisa conter o rótulo (WCAG 2.5.3). */
  readonly name?: string;
  /** 1 = substituições (linha que quebra); 2 = gestão, depois do filete. */
  readonly group: 1 | 2;
  /** Mantém o cartão aberto depois da ação ("Saiba mais"); o padrão fecha e devolve o foco. */
  readonly keepOpen?: boolean;
  /** Posição ATUAL do diagnóstico (mapeada pelas edições desde a rodada). */
  run(view: EditorView, from: number, to: number): void;
}

/** O que o cartão, o painel e o anúncio mostram de um diagnóstico. */
export interface ProblemInfo {
  readonly source: ProblemSource;
  readonly kind: ProblemKind;
  /** Título visível: lint "MD009 · no-trailing-spaces" (mono), LT a categoria ("Ortografia"). */
  readonly title: string;
  /** Rótulo do anúncio e do painel: lint "MD009 no-trailing-spaces", LT a categoria (STR-163). */
  readonly label: string;
  /** Corpo como texto puro (`textContent`): descrição pt-BR do lint ou mensagem do LT. */
  readonly body: string;
  /** Rodapé (LT "Regra <ID>"). */
  readonly footer?: string;
  readonly actions: readonly ProblemAction[];
}

const KIND_WEIGHT: Record<ProblemKind, number> = { lint: 1, grammar: 2, spelling: 3 };
const KIND_SEVERITY: Record<ProblemKind, Diagnostic['severity']> = {
  lint: 'info',
  grammar: 'warning',
  spelling: 'error',
};

const infos = new WeakMap<Diagnostic, ProblemInfo>();

/** Texto do anúncio de F8/Shift-F8 e de cada linha do painel: "<rótulo>: <mensagem>". */
function problemLine(info: ProblemInfo): string {
  return `${info.label}: ${info.body}`;
}

/**
 * Diagnóstico do `@codemirror/lint` com o cartão desta UI: `markClass` pelo tipo, sem `actions`
 * (nada de botões do pacote), `renderMessage` só texto + glifo (as linhas do painel, A-38).
 */
export function problemDiagnostic(from: number, to: number, info: ProblemInfo): Diagnostic {
  const diagnostic: Diagnostic = {
    from,
    to,
    severity: KIND_SEVERITY[info.kind],
    markClass: `cm-lintRange-${info.kind}`,
    message: problemLine(info),
    renderMessage: () => {
      const span = document.createElement('span');
      span.className = 'cm-problem-line';
      span.append(glyph(info.kind), document.createTextNode(problemLine(info)));
      return span;
    },
  };
  infos.set(diagnostic, info);
  return diagnostic;
}

/** O `ProblemInfo` de um diagnóstico criado por `problemDiagnostic` (senão `undefined`). */
export function problemInfo(diagnostic: Diagnostic): ProblemInfo | undefined {
  return infos.get(diagnostic);
}

const kindOf = (d: Diagnostic): ProblemKind => infos.get(d)?.kind ?? 'lint';

// ── Glifos (os traços de `packages/ui/src/lib/icons.tsx`, desenhados em linha: nenhum `href`) ──

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  info: [{ circle: [12, 12, 9] }, 'M12 11v5M12 8h.01'],
  warn: ['M12 3.5 21.5 20h-19z', 'M12 10v4M12 17h.01'],
  close: ['M6 6l12 12M18 6 6 18'],
} as const satisfies Record<string, readonly (string | { circle: readonly number[] })[]>;

function icon(name: keyof typeof ICONS, className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const part of ICONS[name]) {
    if (typeof part === 'string') {
      svg.appendChild(document.createElementNS(SVG_NS, 'path')).setAttribute('d', part);
    } else {
      const circle = svg.appendChild(document.createElementNS(SVG_NS, 'circle'));
      const [cx, cy, r] = part.circle;
      circle.setAttribute('cx', String(cx));
      circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', String(r));
    }
  }
  return svg;
}

/** Glifo de 14 px: lint → `info` `muted`; gramática → `warn` `fg`; ortografia → `warn` `danger`. */
function glyph(kind: ProblemKind): SVGSVGElement {
  return icon(kind === 'lint' ? 'info' : 'warn', `cm-problem-glyph cm-problem-glyph-${kind}`);
}

// ── 1. Calha ─────────────────────────────────────────────────────────────────────────────────

class ProblemMarker extends GutterMarker {
  constructor(readonly kind: ProblemKind) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return other instanceof ProblemMarker && other.kind === this.kind;
  }
  override toDOM(): Node {
    return glyph(this.kind);
  }
}

const MARKERS: Record<ProblemKind, ProblemMarker> = {
  lint: new ProblemMarker('lint'),
  grammar: new ProblemMarker('grammar'),
  spelling: new ProblemMarker('spelling'),
};

/** Um marcador por linha com diagnóstico, o tipo mais forte da linha. */
function markersFor(state: State): RangeSet<GutterMarker> {
  const strongest = new Map<number, ProblemKind>();
  forEachDiagnostic(state, (d, from) => {
    const line = state.doc.lineAt(Math.min(from, state.doc.length)).from;
    const kind = kindOf(d);
    const current = strongest.get(line);
    if (!current || KIND_WEIGHT[kind] > KIND_WEIGHT[current]) strongest.set(line, kind);
  });
  return RangeSet.of(
    [...strongest].map(([line, kind]) => MARKERS[kind].range(line)),
    true,
  );
}

const gutterMarkers = StateField.define<RangeSet<GutterMarker>>({
  create: (state) => markersFor(state),
  update(value, tr) {
    if (tr.docChanged || tr.reconfigured || tr.effects.some((e) => e.is(setDiagnosticsEffect)))
      return markersFor(tr.state);
    return value;
  },
});

const problemsGutter = gutter({
  class: 'cm-gutter-problems',
  markers: (view) => view.state.field(gutterMarkers),
});

// ── 5. Cartão do problema (W2) ──────────────────────────────────────────────────────────────

interface Found {
  readonly diagnostic: Diagnostic;
  readonly from: number;
  readonly to: number;
}

/** O diagnóstico mais forte sob `pos` (desempate: o trecho menor). `side` segue a regra do CM. */
function problemAt(state: State, pos: number, side: -1 | 0 | 1 = 0): Found | null {
  let best: Found | null = null;
  forEachDiagnostic(state, (diagnostic, from, to) => {
    if (pos < from || pos > to) return;
    if (from !== to && ((pos === from && side < 0) || (pos === to && side > 0))) return;
    if (
      !best ||
      KIND_WEIGHT[kindOf(diagnostic)] > KIND_WEIGHT[kindOf(best.diagnostic)] ||
      (kindOf(diagnostic) === kindOf(best.diagnostic) && to - from < best.to - best.from)
    )
      best = { diagnostic, from, to };
  });
  return best;
}

/** Posição atual de um diagnóstico (mapeada), ou `null` se a rodada o substituiu. */
function currentRange(state: State, target: Diagnostic): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  forEachDiagnostic(state, (d, from, to) => {
    if (d === target) found = { from, to };
  });
  return found;
}

interface CardSpec extends Found {
  /** Aberto pelo teclado: foco no 1º botão. */
  readonly focus: boolean;
}

const openCard = StateEffect.define<CardSpec>();
const closeCard = StateEffect.define<null>();

/** Cartão aberto pelo teclado (`Mod-Shift-Enter`); fecha com edição, seleção nova ou rodada nova. */
const cardField = StateField.define<CardSpec | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(openCard)) return effect.value;
      if (effect.is(closeCard)) return null;
    }
    if (!value) return value;
    if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(setDiagnosticsEffect)))
      return null;
    return value;
  },
  provide: (field) =>
    showTooltip.from(field, (card): Tooltip | null =>
      card
        ? {
            pos: card.from,
            end: card.to,
            above: true,
            create: (view) => cardView(view, card.diagnostic, card.focus),
          }
        : null,
    ),
});

/** Views com um cartão de hover montado (o Escape só é do cartão quando ele está à vista). */
const hoverCards = new WeakMap<EditorView, number>();

let cardIds = 0;

function closeAndFocus(view: EditorView): void {
  view.dispatch({ effects: [closeCard.of(null), closeHoverTooltips] });
  view.focus();
}

function cardView(view: EditorView, diagnostic: Diagnostic, focus: boolean): TooltipView {
  const info = infos.get(diagnostic);
  const dom = document.createElement('div');
  dom.className = 'cm-problem-card';
  dom.dataset.testid = 'problem-card';
  dom.dataset.source = info?.source ?? 'lint';
  dom.setAttribute('role', 'dialog');
  dom.setAttribute('aria-modal', 'false');
  // Largura `min(360px, coluna − 2 × space-3)`: a coluna é a largura do conteúdo do editor.
  dom.style.setProperty('--cm-problem-column', `${view.contentDOM.clientWidth || 360}px`);

  const titleId = `cm-problem-title-${++cardIds}`;
  dom.setAttribute('aria-labelledby', titleId);
  const title = dom.appendChild(document.createElement('div'));
  title.id = titleId;
  title.className = `cm-problem-title cm-problem-title-${info?.source ?? 'lint'}`;
  const prefix = title.appendChild(document.createElement('span'));
  prefix.className = 'cm-problem-sr';
  prefix.textContent = 'Problema: ';
  title.append(info?.title ?? diagnostic.message);

  const body = dom.appendChild(document.createElement('p'));
  body.className = 'cm-problem-body';
  body.textContent = info?.body ?? diagnostic.message;

  const buttons: HTMLButtonElement[] = [];
  const actions = info?.actions ?? [];
  for (const group of [1, 2] as const) {
    const items = actions.filter((a) => a.group === group);
    if (items.length === 0) continue;
    if (buttons.length > 0)
      dom.appendChild(document.createElement('hr')).className = 'cm-problem-sep';
    const row = dom.appendChild(document.createElement('div'));
    row.className = 'cm-problem-actions';
    row.dataset.group = String(group);
    for (const action of items) {
      const button = row.appendChild(document.createElement('button'));
      button.type = 'button';
      button.className = 'smd-btn smd-btn-secondary cm-problem-action';
      button.dataset.testid = 'problem-action';
      button.dataset.action = action.action;
      if (action.name && action.name !== action.label)
        button.setAttribute('aria-label', action.name);
      button.appendChild(document.createElement('span')).textContent = action.label;
      // O clique não tira o foco do editor antes da ação (hover); o teclado usa o `click`.
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        const range = currentRange(view.state, diagnostic);
        if (range) action.run(view, range.from, range.to);
        if (!action.keepOpen || !range) closeAndFocus(view);
      });
      buttons.push(button);
    }
  }
  if (info?.footer) {
    const footer = dom.appendChild(document.createElement('div'));
    footer.className = 'cm-problem-footer';
    footer.textContent = info.footer;
  }

  // Tab/Shift-Tab circulam só pelos botões; Tab depois do último e Esc fecham e voltam ao editor.
  dom.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeAndFocus(view);
      return;
    }
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.shiftKey && index === buttons.length - 1) closeAndFocus(view);
    else if (event.shiftKey) buttons[(index - 1 + buttons.length) % buttons.length]?.focus();
    else buttons[index + 1]?.focus();
  });

  return {
    dom,
    mount: () => {
      if (focus) buttons[0]?.focus();
      else hoverCards.set(view, (hoverCards.get(view) ?? 0) + 1);
    },
    destroy: () => {
      if (!focus) hoverCards.set(view, Math.max(0, (hoverCards.get(view) ?? 1) - 1));
    },
  };
}

/** Cartão por hover (sem foco), no lugar da dica padrão do pacote. */
const cardHover = hoverTooltip(
  (view, pos, side) => {
    if (view.state.field(cardField, false)) return null;
    const found = problemAt(view.state, pos, side);
    if (!found) return null;
    return {
      pos: found.from,
      end: found.to,
      above: true,
      create: (v) => cardView(v, found.diagnostic, false),
    };
  },
  { hideOn: (tr) => tr.docChanged },
);

/**
 * "Interagir com o elemento sob o cursor" (`Mod-Shift-Enter`, W2 ordem 10): abre o cartão do
 * problema sob `pos` com o foco no 1º botão. Sem problema ali → `false` (o próximo alvo tenta).
 */
export function openProblemCard(view: EditorView, pos: number): boolean {
  const found = problemAt(view.state, pos);
  if (!found) return false;
  view.dispatch({ effects: [closeHoverTooltips, openCard.of({ ...found, focus: true })] });
  return true;
}

/** Dono `card` do Escape: fecha o cartão à vista (teclado ou hover); senão segue (Vim, CM). */
export function closeProblemCard(view: EditorView): boolean {
  if (view.state.field(cardField, false)) {
    closeAndFocus(view);
    return true;
  }
  if ((hoverCards.get(view) ?? 0) > 0) {
    view.dispatch({ effects: closeHoverTooltips });
    return true;
  }
  return false;
}

// ── 6. Comandos e navegação ─────────────────────────────────────────────────────────────────

function announceAtSelection(view: EditorView): void {
  const { from } = view.state.selection.main;
  const found = problemAt(view.state, from, 1) ?? problemAt(view.state, from);
  if (!found) return;
  const info = infos.get(found.diagnostic);
  const text = info ? problemLine(info) : found.diagnostic.message;
  const line = view.state.doc.lineAt(found.from).number;
  // STR-163 "<rótulo>: <mensagem>. Linha <n>." — sem repetir o ponto final da mensagem.
  view.dispatch({ effects: EditorView.announce.of(`${text.replace(/\.$/, '')}. Linha ${line}.`) });
}

function step(move: (view: EditorView) => boolean) {
  return (view: EditorView): boolean => {
    if (!move(view)) {
      view.dispatch({ effects: EditorView.announce.of('Nenhum problema.') });
      return true;
    }
    announceAtSelection(view);
    return true;
  };
}

/** Comandos `problems:panel|next|prev` (a paleta do app chama esta facet; o keymap também). */
export const problemsCommands: ProblemsCommands = {
  openPanel: (view) => openLintPanel(view),
  next: step(nextDiagnostic),
  prev: step(previousDiagnostic),
};

const problemsKeymap = keymap.of([
  { key: 'Mod-Shift-m', run: problemsCommands.openPanel, preventDefault: true },
  { key: 'F8', run: problemsCommands.next, preventDefault: true },
  { key: 'Shift-F8', run: problemsCommands.prev, preventDefault: true },
]);

// ── 3. Painel W5 ────────────────────────────────────────────────────────────────────────────

/** Cabeçalho "Problemas" (o nome da lista já é "Problemas") e ícone `i-x` no "Fechar" (D-R7-F29). */
const panelDecorator = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      this.decorate();
    }
    update(): void {
      this.decorate();
    }
    decorate(): void {
      let bottom: Element | null = null;
      for (const child of this.view.dom.children)
        if (child.classList.contains('cm-panels-bottom')) bottom = child;
      const panel = bottom?.querySelector('.cm-panel-lint');
      if (!(panel instanceof HTMLElement) || panel.dataset.testid === 'problems-panel') return;
      panel.dataset.testid = 'problems-panel';
      const list = panel.querySelector('ul');
      const header = document.createElement('div');
      header.className = 'cm-problems-header';
      header.setAttribute('aria-hidden', 'true');
      header.textContent = 'Problemas';
      panel.insertBefore(header, list);
      const close = panel.querySelector('button[name=close]');
      if (close) {
        close.classList.add('smd-btn', 'smd-btn-ghost', 'cm-problems-close');
        close.replaceChildren(icon('close', 'cm-problems-close-icon'));
      }
    }
  },
);

// ── 2/3/4/5. Tema (só tokens; nada de `url(`/`data:`) ──────────────────────────────────────

const underline = (style: string, color: string) => ({
  textDecorationLine: 'underline',
  textDecorationStyle: style,
  textDecorationColor: color,
  textDecorationThickness: '0.12em',
  textUnderlineOffset: '0.2em',
  textDecorationSkipInk: 'none',
});

const HAIRLINE = 'color-mix(in srgb, var(--color-border) 45%, var(--color-bg))';

const diagnosticsTheme = EditorView.theme({
  '.cm-lintRange, .cm-lintRange-error, .cm-lintRange-warning, .cm-lintRange-info, .cm-lintRange-hint':
    { backgroundImage: 'none', paddingBottom: '0' },
  // Ordem = precedência na sobreposição: o LT é desenhado por último e vence (DESIGN §R7.6.11).
  '.cm-lintRange-lint': underline('dotted', 'var(--color-muted)'),
  '.cm-lintRange-grammar': underline('dashed', 'var(--color-fg)'),
  '.cm-lintRange-spelling': underline('wavy', 'var(--color-danger)'),
  '.cm-lintRange-active': { backgroundColor: 'var(--color-selection)' },
  '.cm-lintPoint::after, .cm-lintPoint-info::after, .cm-lintPoint-hint::after': {
    borderBottomColor: 'var(--color-muted)',
  },
  '.cm-lintPoint-warning::after': { borderBottomColor: 'var(--color-fg)' },
  '.cm-lintPoint-error::after': { borderBottomColor: 'var(--color-danger)' },
  // 1. Calha sobre `bg`, sem borda, sem dica.
  '.cm-gutters': {
    backgroundColor: 'var(--color-bg)',
    border: 'none',
    color: 'var(--color-muted)',
  },
  '.cm-gutter-problems': { width: 'calc(var(--dimension-space-4) + var(--dimension-space-1))' },
  '.cm-gutter-problems .cm-gutterElement': {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  '.cm-problem-glyph': {
    width: '14px',
    height: '14px',
    flex: 'none',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '1.6',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  },
  '.cm-gutter-problems .cm-problem-glyph': { marginTop: 'calc((1.6em - 14px) / 2)' },
  '.cm-problem-glyph-lint': { color: 'var(--color-muted)' },
  '.cm-problem-glyph-grammar': { color: 'var(--color-fg)' },
  '.cm-problem-glyph-spelling': { color: 'var(--color-danger)' },
  // 4. A dica padrão do pacote fica vazia (`tooltipFilter`) e some.
  '.cm-tooltip-lint:empty': { display: 'none' },
  '.cm-tooltip-hover:has(> .cm-tooltip-lint:empty:only-child)': { display: 'none' },
  '.cm-tooltip-hover > .cm-tooltip-lint:empty + .cm-tooltip-section': { borderTop: 'none' },
  // 5. W2 (nível 1: a superfície do hover já vem do tema do editor; a do teclado, daqui).
  '.cm-tooltip.cm-problem-card': {
    backgroundColor: 'var(--color-bg)',
    border: `1px solid ${HAIRLINE}`,
    borderRadius: 'var(--dimension-radius)',
    boxShadow: 'var(--shadow-dialog)',
  },
  '.cm-problem-card': {
    boxSizing: 'border-box',
    width: 'min(360px, calc(var(--cm-problem-column, 360px) - 2 * var(--dimension-space-3)))',
    padding: 'var(--dimension-space-3)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--dimension-space-2)',
    fontFamily: 'var(--fontFamily-ui)',
    fontSize: 'var(--dimension-ui-font-size)',
    lineHeight: '1.45',
    color: 'var(--color-fg)',
    overflowWrap: 'anywhere',
  },
  '.cm-problem-title': { fontWeight: 'var(--fontWeight-semibold)' },
  '.cm-problem-title-lint': {
    fontFamily: 'var(--fontFamily-mono)',
    fontSize: '12px',
    fontWeight: 'var(--fontWeight-bold)',
  },
  '.cm-problem-sr': {
    position: 'absolute',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  },
  '.cm-problem-body': { margin: '0' },
  '.cm-problem-actions': { display: 'flex', flexWrap: 'wrap', gap: 'var(--dimension-space-2)' },
  '.cm-problem-action': { maxWidth: '100%' },
  '.cm-problem-action > span': {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  '.cm-problem-sep': {
    border: '0',
    borderTop: `1px solid ${HAIRLINE}`,
    margin: '0',
    width: '100%',
  },
  '.cm-problem-footer': { fontSize: '12px', color: 'var(--color-muted)' },
  // 3. W5: faixa `sidebar-bg` com filete no topo, até 30% do editor.
  '.cm-panels.cm-panels-bottom': { borderTop: 'none' },
  '.cm-panel.cm-panel-lint': {
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '30%',
    backgroundColor: 'var(--color-sidebar-bg)',
    boxShadow: `inset 0 1px 0 ${HAIRLINE}`,
    fontFamily: 'var(--fontFamily-ui)',
    fontSize: 'var(--dimension-ui-font-size)',
    color: 'var(--color-fg)',
  },
  '.cm-problems-header': {
    display: 'flex',
    alignItems: 'center',
    height: '2rem',
    paddingInline: 'var(--dimension-space-3)',
    fontWeight: 'var(--fontWeight-semibold)',
  },
  '.cm-panel.cm-panel-lint [name=close].cm-problems-close': {
    position: 'absolute',
    top: 'calc((2rem - var(--dimension-space-6)) / 2)',
    right: 'var(--dimension-space-3)',
    width: 'var(--dimension-space-6)',
    height: 'var(--dimension-space-6)',
    padding: '0',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--color-fg)',
  },
  '.cm-problems-close-icon': {
    width: '14px',
    height: '14px',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '1.6',
    strokeLinecap: 'round',
  },
  '.cm-panel.cm-panel-lint ul': {
    maxHeight: 'none',
    overflowY: 'auto',
    paddingBottom: 'var(--dimension-space-1)',
  },
  '.cm-panel.cm-panel-lint ul:focus-visible': {
    outline: 'var(--dimension-focus-ring) solid var(--color-accent)',
    outlineOffset: 'calc(-1 * var(--dimension-focus-ring))',
  },
  '.cm-panel.cm-panel-lint .cm-diagnostic': {
    position: 'relative',
    display: 'flex',
    alignItems: 'flex-start',
    minHeight: 'var(--dimension-explorer-row-height)',
    boxSizing: 'border-box',
    padding: 'var(--dimension-space-1) var(--dimension-space-3)',
    marginLeft: '0',
    border: 'none',
    whiteSpace: 'normal',
  },
  '.cm-panel.cm-panel-lint .cm-diagnostic-error, .cm-panel.cm-panel-lint .cm-diagnostic-warning, .cm-panel.cm-panel-lint .cm-diagnostic-info, .cm-panel.cm-panel-lint .cm-diagnostic-hint':
    { borderLeft: 'none' },
  '.cm-panel.cm-panel-lint ul [aria-selected], .cm-panel.cm-panel-lint ul:focus [aria-selected]': {
    backgroundColor: 'var(--color-hover)',
    color: 'var(--color-fg)',
  },
  '.cm-panel.cm-panel-lint ul [aria-selected]::before': {
    content: '""',
    position: 'absolute',
    insetBlock: '0',
    insetInlineStart: '0',
    width: 'calc(var(--dimension-space-1) / 2)',
    backgroundColor: 'var(--color-accent)',
  },
  '.cm-problem-line': {
    display: 'flex',
    gap: 'var(--dimension-space-2)',
    alignItems: 'flex-start',
  },
  '.cm-problem-line .cm-problem-glyph': { marginTop: '0.15rem' },
  '.cm-panel.cm-panel-lint .cm-diagnostic-info:only-child .cm-diagnosticText': {
    color: 'var(--color-muted)',
  },
});

/** STR-162: frases do painel do CM em pt-BR. */
const phrases = EditorState.phrases.of({
  Diagnostics: 'Problemas',
  close: 'Fechar',
  'No diagnostics': 'Nenhum problema',
});

/**
 * A UI inteira, UMA constante para lint e LT (o CM deduplica a mesma instância). O `linter(null)`
 * só configura: esconde a dica padrão (`tooltipFilter` → nenhum item) sem acrescentar fonte.
 */
export const diagnosticsUi: Extension = [
  linter(null, { tooltipFilter: () => [] }),
  gutterMarkers,
  problemsGutter,
  cardField,
  cardHover,
  problemsKeymap,
  panelDecorator,
  phrases,
  diagnosticsTheme,
];

/**
 * A UI compartilhada + as ligações de privilégio do host (só lint e LT as recebem): alvo de
 * "Interagir" (W2), dono `card` do Escape e a facet dos comandos `problems:*` da paleta.
 */
export function diagnosticsExtension(host: Pick<InternalHostContext, 'editor'>): Extension {
  return [
    diagnosticsUi,
    host.editor.interact((view, pos) => openProblemCard(view, pos)),
    host.editor.escape('card', (view) => closeProblemCard(view)),
    host.editor.problems ? host.editor.problems(problemsCommands) : [],
  ];
}
