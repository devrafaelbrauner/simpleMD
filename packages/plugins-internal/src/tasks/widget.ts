/**
 * Widget de consulta W3 (R-I9.6/R-I9.8, AC-I9.8/AC-I9.9; DESIGN §R7.6.14, arch-ux §3.6/§5.10,
 * UX-R7-D5/D19). Campo de blocos próprio do plugin (o CM só aceita decorações de bloco vindas de
 * campo): cercas ```` ```tasks ````/```` ```dataview ````/```` ```dataviewjs ```` de topo fechadas,
 * fora do cursor, viram o widget. O campo é MAPEADO em edições fora dos blocos (sem nova varredura e
 * sem `toDOM`); a avaliação roda só no `toDOM` (o que o CM desenha) e, depois de uma publicação do
 * catálogo, só nos widgets visíveis (espera de 500 ms). Nenhum descendente tabbável: os itens têm
 * `tabindex=-1`; o foco entra por `Mod-Shift-Enter` e circula em roving.
 */
import { syntaxTree } from '@codemirror/language';
import {
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Transaction,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import type { InternalHostContext } from '@simplemd/plugin-api/internal/host';
import type { TaskRef, TasksCatalog } from '@simplemd/plugin-api/internal/tasks-catalog';
import {
  isTouched,
  pluginFocus,
  pluginFocusField,
  revealAt,
  setPluginFocus,
  warnGlyph,
} from '../shared/reveal';
import { localIsoDate, msUntilLocalMidnight } from './query/dates';
import type { NoteRow, QueryResult, ResultGroup, TaskRow } from './query/evaluate';
import {
  evaluateBlock,
  queryFailure,
  queryFenceOf,
  resultCountLabel,
  type QueryFence,
} from './render';
import { queryTheme } from './theme';

/** Espera depois de uma publicação do catálogo (R-I9.8: ≤ 1 s com 500 ms incluídos). */
export const QUERY_REFRESH_MS = 500;
/** "Consultando…" só depois de 150 ms; STR-46 depois de 15 s (DESIGN §R7.6.14). */
export const QUERY_LOADING_MS = 150;
export const QUERY_SLOW_MS = 15_000;
const PAGE_STEP = 10;
const SLOW_TEXT = 'Isto está demorando mais que o esperado.';
const SVG_NS = 'http://www.w3.org/2000/svg';
const CHECK_PATH = 'M5 12.5l4.5 4.5L19 7.5';

export interface QueryBlock {
  /** Início da linha da cerca de abertura e fim da linha da cerca de fechamento. */
  readonly from: number;
  readonly to: number;
  readonly fence: QueryFence;
  readonly source: string;
}

/** Cercas de consulta de topo e fechadas (cerca sem fechamento fica crua). */
export function queryBlocks(state: EditorState): QueryBlock[] {
  const doc = state.doc;
  const out: QueryBlock[] = [];
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    if (node.name !== 'FencedCode') continue;
    const info = node.getChild('CodeInfo');
    const fence = info ? queryFenceOf(doc.sliceString(info.from, info.to)) : null;
    if (!fence || node.getChildren('CodeMark').length < 2) continue;
    const text = node.getChild('CodeText');
    out.push({
      from: doc.lineAt(node.from).from,
      to: doc.lineAt(node.to).to,
      fence,
      source: text ? doc.sliceString(text.from, text.to) : '',
    });
  }
  return out;
}

/** O que o widget usa do plugin: catálogo, opções, anúncio e o caminho da nota do editor. */
export interface QueryHost {
  readonly catalog: TasksCatalog;
  readonly host: Pick<InternalHostContext, 'platform' | 'options' | 'editor'>;
  notePathOf(state: EditorState): string | null;
  now(): Date;
}

/** Widgets desenhados e a agenda de reavaliação de UMA ativação do plugin. */
export class QueryController {
  readonly live = new Set<QueryView>();
  #timer: number | undefined;
  #midnight: number | undefined;
  /** Campo de blocos desta ativação (posto por {@link queryWidgetExtension}). */
  field: StateField<QueryFieldValue> | null = null;
  readonly #unsubscribe: () => void;
  readonly #onFocus = () => this.refreshDay();
  /** Tarefas com alternância em voo (um clique = no máximo uma gravação; NFR-49). */
  readonly #toggling = new Set<string>();

  constructor(readonly env: QueryHost) {
    this.#unsubscribe = env.catalog.subscribe(() => this.#schedule());
    this.#armMidnight();
    globalThis.addEventListener?.('focus', this.#onFocus);
  }

  #schedule(): void {
    window.clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => {
      for (const view of this.live) view.catalogChanged();
    }, QUERY_REFRESH_MS);
  }

  #armMidnight(): void {
    window.clearTimeout(this.#midnight);
    this.#midnight = window.setTimeout(() => {
      this.refreshDay();
      this.#armMidnight();
    }, msUntilLocalMidnight(this.env.now()));
  }

  /** `today` virou (meia-noite ou foco da janela): reavalia as consultas da data antiga. */
  refreshDay(): void {
    const today = localIsoDate(this.env.now());
    for (const view of this.live) view.dayChanged(today);
  }

  /** Viewport mudou: widgets visíveis com reavaliação pendente avaliam agora. */
  viewportChanged(): void {
    for (const view of this.live) view.flushIfVisible();
  }

  async toggle(ref: TaskRef): Promise<void> {
    const key = `${ref.path}\u0000${ref.task.line}`;
    if (this.#toggling.has(key)) return;
    this.#toggling.add(key);
    try {
      const wasDone = ref.task.status === 'x' || ref.task.status === 'X';
      const result = await this.env.catalog.toggleTask(ref, {
        recordDoneDate: this.env.host.options.get<boolean>('recordDoneDate') !== false,
      });
      if (result.ok)
        this.env.host.editor.announce(wasDone ? 'Tarefa reaberta.' : 'Tarefa concluída.');
    } finally {
      this.#toggling.delete(key);
    }
  }

  /** "Interagir com o elemento sob o cursor" (UX-R7-D5, QRY-ENTER): no bloco ou na linha vizinha. */
  interact(view: EditorView, pos: number): boolean {
    if (!this.field) return false;
    const doc = view.state.doc;
    const line = doc.lineAt(pos).number;
    const block = view.state
      .field(this.field)
      .blocks.find(
        (b) => line >= doc.lineAt(b.from).number - 1 && line <= doc.lineAt(b.to).number + 1,
      );
    if (!block) return false;
    // Sem mover o cursor: o campo de foco do plugin vai a falso e o bloco volta a ser widget (W4).
    if (isTouched(view.state, block.from, block.to))
      view.dispatch({ effects: setPluginFocus.of(false) });
    const target = [...this.live].find(
      (candidate) =>
        candidate.view === view && candidate.dom.isConnected && candidate.start() === block.from,
    );
    if (!target) return false;
    return target.enter();
  }

  /** Bloco que começa em `from` (posição do widget). */
  blockAt(state: EditorState, from: number): QueryBlock | undefined {
    return this.field ? state.field(this.field).blocks.find((b) => b.from === from) : undefined;
  }

  dispose(): void {
    this.#unsubscribe();
    window.clearTimeout(this.#timer);
    window.clearTimeout(this.#midnight);
    globalThis.removeEventListener?.('focus', this.#onFocus);
    for (const view of this.live) view.dispose();
    this.live.clear();
  }
}

type Item = { readonly el: HTMLElement; readonly task?: TaskRef; readonly path: string };

/** Um widget desenhado: avalia, desenha, reavalia no lugar e cuida do teclado. */
export class QueryView {
  #version = -1;
  #day = '';
  #stale = false;
  #timers: number[] = [];
  #items: Item[] = [];
  #count = 0;

  constructor(
    readonly dom: HTMLElement,
    readonly view: EditorView,
    readonly fence: QueryFence,
    readonly source: string,
    readonly controller: QueryController,
  ) {
    dom.addEventListener('keydown', (event) => this.#key(event));
    dom.addEventListener('mousedown', (event) => this.#mouse(event));
    dom.addEventListener('focusin', (event) => this.#activate(event.target as HTMLElement));
    dom.addEventListener('focusout', (event) => {
      if (!dom.contains(event.relatedTarget as Node | null)) this.#activate(null);
    });
  }

  /** Posição do bloco no documento (o widget substitui as linhas da cerca). */
  start(): number {
    return this.view.posAtDOM(this.dom);
  }

  #visible(): boolean {
    if (!this.dom.isConnected) return false;
    const from = this.start();
    const to = this.controller.blockAt(this.view.state, from)?.to ?? from;
    return this.view.visibleRanges.some((range) => range.from <= to && range.to >= from);
  }

  catalogChanged(): void {
    if (this.fence === 'dataviewjs') return;
    if (this.#visible()) {
      if (this.#stale || this.controller.env.catalog.getSnapshot().version !== this.#version)
        this.refresh();
    } else {
      this.#stale = true;
    }
  }

  dayChanged(today: string): void {
    if (this.fence === 'dataviewjs' || this.#day === today) return;
    if (this.#visible()) this.refresh();
    else this.#stale = true;
  }

  flushIfVisible(): void {
    if (this.#stale && this.#visible()) this.refresh();
  }

  /** Avalia (se o índice está pronto) e redesenha, preservando o foco (arch-ux §7.4 item 4). */
  refresh(): void {
    const focused = this.dom.ownerDocument.activeElement;
    const inside = focused instanceof HTMLElement && this.dom.contains(focused);
    const index = this.#items.findIndex((item) => item.el === focused);
    this.#clearTimers();
    this.#stale = false;
    const { catalog, now } = this.controller.env;
    const snapshot = catalog.getSnapshot();
    if (this.fence !== 'dataviewjs' && snapshot.status !== 'ready') {
      this.#stale = true;
      this.#renderPending(snapshot.status);
    } else {
      const date = now();
      this.#version = snapshot.version;
      this.#day = localIsoDate(date);
      try {
        const notePath = this.controller.env.notePathOf(this.view.state) ?? '';
        this.#render(evaluateBlock(this.fence, this.source, catalog, notePath, date));
      } catch {
        // Defesa em profundidade (CR-S9b-B01): o `toDOM` do CodeMirror não captura exceções.
        this.#render(queryFailure(this.source));
      }
      globalThis.performance?.mark?.('simplemd:query-painted');
    }
    if (inside) {
      const next = this.#items[Math.min(Math.max(index, 0), this.#items.length - 1)];
      (next?.el ?? this.dom).focus();
    }
    if (this.dom.isConnected) this.view.requestMeasure();
  }

  #clearTimers(): void {
    for (const timer of this.#timers) window.clearTimeout(timer);
    this.#timers = [];
  }

  #frame(state: string, label: string): Document {
    const doc = this.dom.ownerDocument;
    this.dom.replaceChildren();
    this.dom.dataset.state = state;
    this.dom.setAttribute('aria-label', label);
    if (state === 'loading' || state === 'indexing') this.dom.setAttribute('aria-busy', 'true');
    else this.dom.removeAttribute('aria-busy');
    this.#items = [];
    this.#count = 0;
    return doc;
  }

  #head(doc: Document, text: string, strong: boolean): HTMLElement {
    const head = this.dom.appendChild(doc.createElement('div'));
    head.className = 'cm-query-head';
    const label = head.appendChild(doc.createElement('span'));
    label.className = strong ? 'cm-query-count' : 'cm-query-msg';
    label.textContent = text;
    const kind = head.appendChild(doc.createElement('span'));
    kind.className = 'cm-query-kind';
    kind.textContent = this.fence === 'tasks' ? 'tasks' : 'dataview';
    return head;
  }

  #kindName(): string {
    return this.fence === 'tasks' ? 'tasks' : 'dataview';
  }

  #renderPending(status: 'loading' | 'building'): void {
    const doc = this.#frame(
      status === 'building' ? 'indexing' : 'loading',
      `Resultados da consulta ${this.#kindName()}`,
    );
    if (status === 'building') {
      this.#head(doc, 'Indexando…', false);
      return;
    }
    const head = this.#head(doc, '', false);
    const message = head.firstElementChild as HTMLElement;
    this.#timers.push(
      window.setTimeout(() => (message.textContent = 'Consultando…'), QUERY_LOADING_MS),
      window.setTimeout(() => {
        const slow = this.dom.appendChild(doc.createElement('p'));
        slow.className = 'cm-query-slow';
        slow.textContent = SLOW_TEXT;
      }, QUERY_SLOW_MS),
    );
  }

  #render(result: QueryResult): void {
    const kind = this.#kindName();
    if (result.kind === 'error') {
      const doc = this.#frame('error', 'Resultados da consulta');
      const alert = this.dom.appendChild(doc.createElement('div'));
      alert.className = 'cm-query-alert';
      alert.appendChild(warnGlyph(doc));
      alert.appendChild(doc.createElement('p')).textContent = result.message;
      return;
    }
    const label = `Resultados da consulta ${kind}: ${result.count} resultados`;
    if (result.count === 0) {
      const doc = this.#frame('empty', label);
      this.#head(doc, 'Nenhum resultado', false);
      return;
    }
    const doc = this.#frame('results', label);
    this.#count = result.count;
    this.#head(doc, resultCountLabel(result.count), true).classList.add('cm-query-head-rows');
    let group = 0;
    const each = <Row>(
      groups: readonly ResultGroup<Row>[],
      body: (rows: readonly Row[], list: HTMLElement | null) => void,
    ) => {
      for (const g of groups) {
        let labelledBy: string | null = null;
        if (g.label !== null) {
          const title = this.dom.appendChild(doc.createElement('div'));
          title.className = 'cm-query-group';
          title.id = `cm-query-g${++QueryView.ids}-${++group}`;
          title.textContent = g.label;
          labelledBy = title.id;
        }
        if (result.kind === 'table') {
          body(g.rows, null);
          continue;
        }
        const list = this.dom.appendChild(doc.createElement('ul'));
        list.className = 'cm-query-list';
        if (labelledBy) {
          list.setAttribute('role', 'list');
          list.setAttribute('aria-labelledby', labelledBy);
        }
        body(g.rows, list);
      }
    };
    if (result.kind === 'tasks')
      each(result.groups, (rows, list) => rows.forEach((row) => this.#taskRow(doc, list!, row)));
    else if (result.kind === 'list')
      each(result.groups, (rows, list) => rows.forEach((row) => this.#listRow(doc, list!, row)));
    else each(result.groups, (rows) => this.#table(doc, result.columns, rows));
  }

  static ids = 0;

  #link(doc: Document, text: string, origin: boolean): HTMLElement {
    const link = doc.createElement('span');
    link.className = 'cm-md-link';
    link.setAttribute('role', 'link');
    link.tabIndex = -1;
    if (origin) link.dataset.testid = 'query-origin';
    link.textContent = text;
    return link;
  }

  #taskRow(doc: Document, list: HTMLElement, row: TaskRow): void {
    const { task } = row.ref;
    const li = list.appendChild(doc.createElement('li'));
    li.className = 'cm-query-row';
    li.dataset.testid = 'query-row';
    const box = li.appendChild(doc.createElement('span'));
    box.className = 'cm-md-task';
    box.tabIndex = -1;
    box.setAttribute('role', 'checkbox');
    const done = task.status === 'x' || task.status === 'X';
    box.dataset.status = task.status === 'X' ? 'x' : task.status;
    box.setAttribute('aria-checked', done ? 'true' : task.status === '/' ? 'mixed' : 'false');
    box.setAttribute(
      'aria-label',
      task.status === '-' ? `Tarefa cancelada: ${task.text}` : `Tarefa: ${task.text}`,
    );
    if (done) {
      const svg = box.appendChild(doc.createElementNS(SVG_NS, 'svg'));
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      svg.appendChild(doc.createElementNS(SVG_NS, 'path')).setAttribute('d', CHECK_PATH);
    } else if (task.status !== ' ' && task.status !== '/') {
      const glyph = box.appendChild(doc.createElement('span'));
      glyph.className = 'cm-md-task-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = task.status === '-' ? '–' : task.status;
    }
    const desc = li.appendChild(doc.createElement('span'));
    desc.className =
      done || task.status === '-' ? 'cm-query-desc cm-md-task-done' : 'cm-query-desc';
    desc.textContent = task.text;
    if (row.meta.length > 0 || row.origin !== null) {
      const meta = li.appendChild(doc.createElement('span'));
      meta.className = 'cm-query-meta';
      meta.append(row.meta.join(' · '));
      if (row.origin !== null) {
        if (row.meta.length > 0) meta.append(' · ');
        meta.appendChild(this.#link(doc, row.origin, true));
      }
    }
    this.#items.push({ el: box, task: row.ref, path: row.ref.path });
  }

  #listRow(doc: Document, list: HTMLElement, row: NoteRow): void {
    const li = list.appendChild(doc.createElement('li'));
    li.className = 'cm-query-row cm-query-row-note';
    li.dataset.testid = 'query-row';
    const link = li.appendChild(this.#link(doc, row.title, false));
    if (row.cells[0] !== undefined) {
      li.append(' ');
      const value = li.appendChild(doc.createElement('span'));
      value.className = 'cm-query-meta cm-query-value';
      value.textContent = row.cells[0];
    }
    this.#items.push({ el: link, path: row.path });
  }

  #table(doc: Document, columns: readonly string[], rows: readonly NoteRow[]): void {
    const table = this.dom.appendChild(doc.createElement('table'));
    table.className = 'cm-query-table';
    const head = table.appendChild(doc.createElement('thead')).appendChild(doc.createElement('tr'));
    for (const column of columns) {
      const th = head.appendChild(doc.createElement('th'));
      th.scope = 'col';
      th.textContent = column;
    }
    const body = table.appendChild(doc.createElement('tbody'));
    for (const row of rows) {
      const tr = body.appendChild(doc.createElement('tr'));
      tr.className = 'cm-query-row';
      tr.dataset.testid = 'query-row';
      const link = tr
        .appendChild(doc.createElement('td'))
        .appendChild(this.#link(doc, row.title, false));
      for (const cell of row.cells) tr.appendChild(doc.createElement('td')).textContent = cell;
      this.#items.push({ el: link, path: row.path });
    }
  }

  /** Roving: só o item ativo fica com `tabindex=0`, e só enquanto o foco está dentro (A-32). */
  #activate(target: HTMLElement | null): void {
    for (const item of this.#items) {
      const active = item.el === target;
      item.el.tabIndex = active ? 0 : -1;
      item.el.closest('.cm-query-row')?.classList.toggle('cm-query-active', active);
    }
  }

  /** Entra no widget: anúncio (antes do foco) e foco no 1º item; sem itens, só o anúncio. */
  enter(): boolean {
    const announce = this.controller.env.host.editor.announce;
    const first = this.#items[0];
    if (!first) {
      const text = this.dom.textContent?.trim();
      if (text) announce(text);
      return true;
    }
    announce(
      this.fence === 'tasks' || first.task
        ? `Resultados da consulta: ${this.#count}. Setas percorrem, Espaço marca, Enter abre a nota, Esc volta ao editor.`
        : `Resultados da consulta: ${this.#count}. Setas percorrem, Enter abre a nota, Esc volta ao editor.`,
    );
    first.el.focus();
    return true;
  }

  #open(item: Item): void {
    const { catalog } = this.controller.env;
    if (item.task) catalog.openSource(item.task);
    else catalog.openNote(item.path);
  }

  /** Volta ao editor: início do bloco (Esc/Shift-Tab) ou a linha depois dele (Tab). */
  #back(after: boolean): void {
    const from = this.start();
    const block = this.controller.blockAt(this.view.state, from);
    const doc = this.view.state.doc;
    const anchor = after && block ? Math.min(block.to + 1, doc.length) : from;
    this.view.focus();
    this.view.dispatch({ selection: { anchor }, scrollIntoView: true });
  }

  #key(event: KeyboardEvent): void {
    const focused = this.dom.ownerDocument.activeElement;
    const index = this.#items.findIndex((item) => item.el === focused);
    const focusAt = (i: number) =>
      this.#items[Math.max(0, Math.min(this.#items.length - 1, i))]?.el.focus();
    switch (event.key) {
      case 'ArrowDown':
        focusAt(index + 1);
        break;
      case 'ArrowUp':
        focusAt(index - 1);
        break;
      case 'Home':
        focusAt(0);
        break;
      case 'End':
        focusAt(this.#items.length - 1);
        break;
      case 'PageDown':
        focusAt(index + PAGE_STEP);
        break;
      case 'PageUp':
        focusAt(index - PAGE_STEP);
        break;
      case ' ': {
        const task = this.#items[index]?.task;
        if (!task) return;
        void this.controller.toggle(task);
        break;
      }
      case 'Enter': {
        const item = this.#items[index];
        if (!item) return;
        this.#open(item);
        break;
      }
      case 'Escape':
        this.#back(false);
        break;
      case 'Tab':
        this.#back(!event.shiftKey);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  /**
   * Clique na caixa alterna (sem mover o cursor); ⌘/Ctrl-clique na origem ou no link da nota abre;
   * qualquer outro clique revela o bloco cru (R-I9.6; QRY-REVEAL).
   */
  #mouse(event: MouseEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.target as Element | null;
    const box = target?.closest?.('.cm-md-task');
    const boxItem = box ? this.#items.find((item) => item.el === box) : undefined;
    if (boxItem?.task) {
      void this.controller.toggle(boxItem.task);
      return;
    }
    const mac = this.controller.env.host.platform === 'mac';
    const mod =
      (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && !event.altKey;
    const link = target?.closest?.('.cm-md-link');
    if (mod && link) {
      const row = link.closest('.cm-query-row');
      const item = this.#items.find((candidate) => candidate.el.closest('.cm-query-row') === row);
      if (item) {
        this.#open(item);
        return;
      }
    }
    revealAt(this.view, this.start());
  }

  dispose(): void {
    this.#clearTimers();
    this.controller.live.delete(this);
  }
}

const views = new WeakMap<HTMLElement, QueryView>();

class QueryWidget extends WidgetType {
  constructor(
    readonly block: QueryBlock,
    readonly controller: QueryController,
  ) {
    super();
  }

  override eq(other: QueryWidget): boolean {
    return (
      other.controller === this.controller &&
      other.block.fence === this.block.fence &&
      other.block.source === this.block.source
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = view.dom.ownerDocument.createElement('div');
    dom.className = 'cm-query';
    dom.dataset.testid = 'query-widget';
    dom.dataset.kind = this.block.fence === 'tasks' ? 'tasks' : 'dataview';
    dom.setAttribute('role', 'group');
    // Alvo de foco de reserva quando o item focado some numa reavaliação; nunca tabbável.
    dom.tabIndex = -1;
    const query = new QueryView(dom, view, this.block.fence, this.block.source, this.controller);
    views.set(dom, query);
    this.controller.live.add(query);
    query.refresh();
    return dom;
  }

  override destroy(dom: HTMLElement): void {
    views.get(dom)?.dispose();
    views.delete(dom);
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

export interface QueryFieldValue {
  readonly blocks: readonly QueryBlock[];
  readonly touched: readonly number[];
  readonly decorations: DecorationSet;
}

function touchedBlocks(state: EditorState, blocks: readonly QueryBlock[]): number[] {
  const out: number[] = [];
  blocks.forEach((block, i) => {
    if (isTouched(state, block.from, block.to)) out.push(i);
  });
  return out;
}

function sameList(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, i) => b[i] === value);
}

const FENCE_CHARS = /[`~]/;

/** A edição pode criar, desfazer ou mudar uma cerca de consulta? (senão o campo só mapeia) */
function needsRescan(blocks: readonly QueryBlock[], tr: Transaction): boolean {
  let rescan = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (rescan) return;
    if (
      FENCE_CHARS.test(inserted.toString()) ||
      FENCE_CHARS.test(tr.startState.doc.sliceString(fromA, toA))
    )
      rescan = true;
    else if (blocks.some((block) => block.from <= toA && block.to >= fromA)) rescan = true;
  });
  return rescan;
}

/** Campo de blocos de consulta + a extensão do widget para um controlador. */
export function queryWidgetExtension(controller: QueryController): {
  extension: Extension;
  field: StateField<QueryFieldValue>;
} {
  const decorationsFor = (blocks: readonly QueryBlock[], touched: readonly number[]) => {
    const out: Range<Decoration>[] = [];
    blocks.forEach((block, i) => {
      if (touched.includes(i)) return;
      out.push(
        Decoration.replace({ block: true, widget: new QueryWidget(block, controller) }).range(
          block.from,
          block.to,
        ),
      );
    });
    return Decoration.set(out);
  };
  const build = (state: EditorState): QueryFieldValue => {
    const blocks = queryBlocks(state);
    const touched = touchedBlocks(state, blocks);
    return { blocks, touched, decorations: decorationsFor(blocks, touched) };
  };

  const field = StateField.define<QueryFieldValue>({
    create: build,
    update(value, tr) {
      if (tr.docChanged) {
        if (needsRescan(value.blocks, tr)) return build(tr.state);
        const blocks = value.blocks.map((block) => ({
          ...block,
          from: tr.changes.mapPos(block.from),
          to: tr.changes.mapPos(block.to),
        }));
        const touched = touchedBlocks(tr.state, blocks);
        return {
          blocks,
          touched,
          decorations: sameList(touched, value.touched)
            ? value.decorations.map(tr.changes)
            : decorationsFor(blocks, touched),
        };
      }
      if (syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
        const next = build(tr.state);
        return next;
      }
      const focus =
        tr.startState.field(pluginFocusField, false) !== tr.state.field(pluginFocusField, false);
      if (!tr.selection && !focus) return value;
      const touched = touchedBlocks(tr.state, value.blocks);
      if (sameList(touched, value.touched)) return value;
      return { blocks: value.blocks, touched, decorations: decorationsFor(value.blocks, touched) };
    },
    provide: (f) => EditorView.decorations.from(f, (value) => value.decorations),
  });

  const viewport = ViewPlugin.fromClass(
    class {
      update(update: ViewUpdate) {
        if (update.viewportChanged || update.geometryChanged) controller.viewportChanged();
      }
    },
  );

  controller.field = field;
  return { field, extension: [pluginFocus, field, viewport, queryTheme] };
}
