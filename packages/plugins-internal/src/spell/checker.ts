import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import type { SpellErrorCode } from '@simplemd/plugin-api/internal/spell';
import {
  insertable,
  spellClearAll,
  spellField,
  spellResults,
  spellSuggestions,
  type Range,
  type SpellDiag,
} from './present';
import { tokensIn, type SpellToken } from './tokenize';

/**
 * Agendador do corretor offline (design-r35 §1 e §6, r35c). Uma instância por ativação do plugin,
 * ligada ao `EditorView` do grupo com foco (r39), com relógio injetável.
 *
 * - A tecla só mapeia o campo e marca o trecho como sujo (nada de tokenizar nem de IPC). 400 ms
 *   depois da última edição (150 ms depois de rolar ou de o cursor sair da palavra que esperava),
 *   o sujo que está na tela é tokenizado (sem árvore até lá → espera); fora da tela não é
 *   verificado (D-R35-4) — quando aparece, a rolagem o traz.
 * - As palavras vão ao motor deduplicadas e só as que o cache (palavra → conhecida, até 50.000,
 *   esvaziado a cada recarga do motor) ainda não tem, até 20.000 por chamada; uma chamada por vez
 *   ao motor (verificação ou sugestão: a fila do Rust é de um, r34). A resposta vale por palavra,
 *   então uma edição no meio não a invalida.
 * - A palavra que o cursor está escrevendo espera ele sair (não é sublinhada no meio da digitação; um
 *   sublinhado que já estava nela fica); a palavra em que o cursor só parou é verificada. Palavras do
 *   dicionário do usuário (`known`) e as ignoradas na sessão não são sublinhadas.
 * - Sugestões: uma por vez, para os até 20 sublinhados visíveis mais perto do cursor, com cache.
 * - `CANCELLED` (outro pedido venceu, de fora do plugin): tenta de novo na espera de uma edição;
 *   `TIMEOUT` e outros erros: tenta de novo em 2 s, sem pedir antes disso (nada de rajada).
 * - Língua: a da nota (`language`); `null` (fora da cobertura) → nenhum sublinhado, nada vai ao
 *   motor. Trocar de língua esvazia os caches.
 * - Privacidade: o log recebe só contagens.
 */

export interface SpellClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const SPELL_TIMING = {
  /** Espera depois da última edição. */
  editMs: 400,
  /** Espera depois de rolar, de o cursor sair da palavra que esperava ou de a árvore faltar. */
  scrollMs: 150,
  /** Depois de `TIMEOUT` ou de um erro do motor: nenhum pedido antes disso. */
  retryMs: 2_000,
} as const;

export const SPELL_LIMITS = {
  /** Palavras por `spell_check` (o teto do Rust, `TOO_MANY_WORDS` acima). */
  maxWords: 20_000,
  /** Respostas guardadas (palavra → conhecida); as mais antigas saem primeiro. */
  cacheWords: 50_000,
  /** Sublinhados visíveis, os mais perto do cursor, que pedem sugestões. */
  suggestNearest: 20,
} as const;

/** Só `check` e `suggest` (code-review r35a N3): recarregar o motor nunca é do plugin. */
export interface SpellEngine {
  /** Índices, em `words`, das palavras que o motor não conhece. */
  check(lang: string, words: readonly string[]): Promise<readonly number[]>;
  /** Até 5 sugestões para `word`. */
  suggest(lang: string, word: string): Promise<readonly string[]>;
}

export interface SpellCheckerDeps {
  readonly engine: SpellEngine;
  readonly clock: SpellClock;
  /** A língua do motor para a nota (`null` = fora da cobertura: nada é verificado nem sublinhado). */
  language(state: EditorState): string | null;
  /** A palavra está no dicionário do usuário (filtro no cliente, sem esperar a recarga do motor). */
  known(word: string): boolean;
  /** A palavra foi ignorada nesta sessão. */
  ignored(word: string): boolean;
  /** Só contagens (nunca palavras nem texto da nota). */
  log(event: string, counts: Readonly<Record<string, number>>): void;
}

type Call =
  | {
      readonly kind: 'check';
      readonly seq: number;
      readonly lang: string;
      readonly words: readonly string[];
    }
  | {
      readonly kind: 'suggest';
      readonly seq: number;
      readonly lang: string;
      readonly word: string;
    };

/** Funde intervalos sobrepostos ou encostados. */
function normalize(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const out: { from: number; to: number }[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push({ from: r.from, to: r.to });
  }
  return out;
}

/** Linhas inteiras de `range` (uma palavra nunca atravessa uma quebra de linha). */
function wholeLines(state: EditorState, range: Range): Range {
  return { from: state.doc.lineAt(range.from).from, to: state.doc.lineAt(range.to).to };
}

const visibleOf = (view: EditorView): Range[] =>
  view.visibleRanges.map((r) => ({ from: r.from, to: r.to }));

export class SpellChecker {
  readonly #deps: SpellCheckerDeps;
  #view: EditorView | null = null;
  /** Trechos alterados (ou ainda não verificados), em posições do documento atual. */
  #dirty: Range[] = [];
  #timer: unknown = null;
  /** Edição esperando os 400 ms: a rolagem não a adianta. */
  #editPending = false;
  /** Nenhum pedido ao motor antes disto (`TIMEOUT` ou erro). */
  #retryAt = 0;
  #inflight: Call | null = null;
  #seq = 0;
  /** A língua dos caches (trocar esvazia). */
  #lang: string | null = null;
  readonly #known = new Map<string, boolean>();
  readonly #suggestions = new Map<string, readonly string[]>();
  /** A palavra sendo escrita, sob o cursor: espera ele sair. */
  #held: Range | null = null;
  /** O trecho da última edição (a palavra que o cursor escreve nele é a que espera). */
  #typing: Range | null = null;
  #destroyed = false;

  constructor(deps: SpellCheckerDeps) {
    this.#deps = deps;
  }

  /** O view verificado (o do grupo com foco); `null` sem nenhum. */
  get view(): EditorView | null {
    return this.#view;
  }

  /** Nota aberta (ou o foco passou a este view): o trecho visível dela, na hora. */
  attach(view: EditorView): void {
    if (this.#view && this.#view !== view) this.detach(this.#view);
    this.#view = view;
    this.#dirty = visibleOf(view);
    this.#held = null;
    this.#typing = null;
    this.#editPending = false;
    this.#schedule(0);
  }

  /** O view saiu (destruído ou o foco foi a outro grupo): os sublinhados dele ficam. */
  detach(view: EditorView): void {
    if (this.#view !== view) return;
    this.#clearTimer();
    this.#view = null;
    this.#dirty = [];
    this.#held = null;
    this.#typing = null;
  }

  /** Plugin desligado: nada mais roda; a verificação em voo é cancelada no motor (`check([])`). */
  destroy(): void {
    if (this.#view) this.detach(this.#view);
    this.#destroyed = true;
    const inflight = this.#inflight;
    this.#inflight = null;
    if (inflight?.kind === 'check')
      this.#deps.engine.check(inflight.lang, []).catch(() => undefined);
  }

  update(update: ViewUpdate): void {
    if (update.view !== this.#view) return;
    const { state } = update;
    let edited = false;
    let soon = false;
    if (update.docChanged) {
      const changes = update.changes;
      const touched: Range[] = [];
      let from = Number.POSITIVE_INFINITY;
      let to = Number.NEGATIVE_INFINITY;
      changes.iterChangedRanges((_fA, _tA, fromB, toB) => {
        touched.push(wholeLines(state, { from: fromB, to: toB }));
        from = Math.min(from, fromB);
        to = Math.max(to, toB);
      });
      // Só a digitação (inserir, colar, apagar) segura a palavra; desfazer ou uma troca pelo
      // cartão não são escrita em curso.
      const typed = update.transactions.some(
        (tr) =>
          tr.isUserEvent('input.type') || tr.isUserEvent('input.paste') || tr.isUserEvent('delete'),
      );
      this.#typing = typed ? { from, to } : null;
      this.#dirty = normalize([
        ...this.#dirty.map((r) => ({
          from: changes.mapPos(r.from, -1),
          to: changes.mapPos(r.to, 1),
        })),
        ...touched,
      ]);
      const held = this.#held;
      this.#held =
        held && !changes.touchesRange(held.from, held.to)
          ? { from: changes.mapPos(held.from), to: changes.mapPos(held.to) }
          : null;
      // A edição do front matter trocou a língua da nota: o visível inteiro é verificado de novo.
      if (this.#languageFlipped(update))
        this.#dirty = normalize([...this.#dirty, ...visibleOf(update.view)]);
      edited = true;
    }
    if (update.viewportChanged) {
      this.#dirty = normalize([...this.#dirty, ...visibleOf(update.view)]);
      soon = true;
    }
    const held = this.#held;
    if (update.selectionSet && held) {
      const head = state.selection.main.head;
      if (head <= held.from || head > held.to) {
        this.#dirty = normalize([...this.#dirty, wholeLines(state, held)]);
        this.#held = null;
        this.#typing = null;
        soon = true;
      }
    }
    if (edited) {
      this.#editPending = true;
      this.#schedule(SPELL_TIMING.editMs);
    } else if (soon && !this.#editPending) this.#schedule(SPELL_TIMING.scrollMs);
  }

  /** A cobertura ou a língua padrão mudou: o trecho visível é verificado de novo, já. */
  languageChanged(): void {
    const view = this.#view;
    if (!view) return;
    this.#dirty = visibleOf(view);
    this.#schedule(0);
  }

  /** O motor recarregou (o dicionário mudou): as respostas guardadas não valem mais. */
  engineReloaded(): void {
    this.#known.clear();
    this.#suggestions.clear();
  }

  // --- interno ---------------------------------------------------------------------------------

  #clearTimer(): void {
    if (this.#timer !== null) this.#deps.clock.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(ms: number): void {
    if (this.#destroyed) return;
    this.#clearTimer();
    const wait = Math.max(ms, this.#retryAt - this.#deps.clock.now());
    this.#timer = this.#deps.clock.setTimeout(() => {
      this.#timer = null;
      this.#editPending = false;
      this.#run();
    }, wait);
  }

  /** O front matter mudou e com ele a língua da nota (`lang: en-US` ↔ sem `lang:`). */
  #languageFlipped(update: ViewUpdate): boolean {
    const end = (state: EditorState) => {
      const node = syntaxTree(state).topNode.firstChild;
      return node?.name === 'FrontMatter' ? node.to : 0;
    };
    const before = end(update.startState);
    const after = end(update.state);
    let touched = false;
    update.changes.iterChangedRanges((fromA, _tA, fromB) => {
      if (fromA <= before || fromB <= after) touched = true;
    });
    return touched && this.#deps.language(update.startState) !== this.#deps.language(update.state);
  }

  /** O sujo na tela, em linhas inteiras. */
  #work(view: EditorView): Range[] {
    const state = view.state;
    const out: Range[] = [];
    for (const visible of view.visibleRanges)
      for (const dirty of this.#dirty) {
        const from = Math.max(visible.from, dirty.from);
        const to = Math.min(visible.to, dirty.to);
        if (from < to || (from === to && dirty.from === dirty.to))
          out.push(wholeLines(state, { from, to }));
      }
    return normalize(out);
  }

  #run(): void {
    const view = this.#view;
    if (!view || this.#destroyed || this.#inflight) return;
    const state = view.state;
    const lang = this.#deps.language(state);
    if (lang !== this.#lang) {
      this.#lang = lang;
      this.#known.clear();
      this.#suggestions.clear();
    }
    if (lang === null) {
      this.#dirty = [];
      this.#held = null;
      if (state.field(spellField).length > 0) view.dispatch({ effects: spellClearAll.of(null) });
      return;
    }
    const work = this.#work(view);
    if (work.length === 0) {
      this.#dirty = [];
      this.#suggestNext(view, lang);
      return;
    }
    // Sem a árvore até o fim do trecho (parse de fundo), as exclusões ainda não valem: espera.
    if (!syntaxTreeAvailable(state, work[work.length - 1]?.to)) {
      this.#schedule(SPELL_TIMING.scrollMs);
      return;
    }
    const head = state.selection.main.head;
    const typing = this.#typing;
    const tokens = work.flatMap((r) => tokensIn(state, r.from, r.to));
    let held: SpellToken | null = null;
    const missing = new Set<string>();
    for (const token of tokens) {
      if (
        typing &&
        token.from < head &&
        head <= token.to &&
        token.from <= typing.to &&
        typing.from <= token.to
      )
        held = token;
      else if (!this.#known.has(token.word)) missing.add(token.word);
    }
    if (missing.size > 0) {
      // Depois de um TIMEOUT ou erro, nenhum pedido antes da hora (a espera da edição pode vencer antes).
      if (this.#deps.clock.now() < this.#retryAt) this.#schedule(0);
      else this.#check(lang, [...missing].slice(0, SPELL_LIMITS.maxWords));
      return;
    }
    const before = state.field(spellField);
    const diags: SpellDiag[] = [];
    for (const token of tokens) {
      const expected = state.sliceDoc(token.from, token.to);
      if (token === held) {
        // A palavra sob o cursor espera; o sublinhado que já estava nela (mesmo texto) fica.
        const kept = before.find(
          (d) => d.from === token.from && d.to === token.to && d.expected === expected,
        );
        if (kept) diags.push(kept);
        continue;
      }
      if (this.#known.get(token.word) !== false) continue;
      if (this.#deps.ignored(token.word) || this.#deps.known(token.word)) continue;
      diags.push({
        from: token.from,
        to: token.to,
        expected,
        word: token.word,
        lang,
        suggestions: this.#suggestions.get(token.word) ?? null,
      });
    }
    this.#held = held ? { from: held.from, to: held.to } : null;
    this.#dirty = [];
    view.dispatch({ effects: spellResults.of({ ranges: work, diags }) });
    this.#deps.log('result', { words: tokens.length, shown: diags.length });
    this.#suggestNext(view, lang);
  }

  #check(lang: string, words: readonly string[]): void {
    const seq = ++this.#seq;
    this.#inflight = { kind: 'check', seq, lang, words };
    this.#deps.log('check', { words: words.length });
    this.#deps.engine.check(lang, words).then(
      (unknown) => this.#checked(seq, unknown),
      (error: unknown) => this.#failed(seq, error),
    );
  }

  #take(seq: number): Call | null {
    const inflight = this.#inflight;
    if (!inflight || inflight.seq !== seq) return null;
    this.#inflight = null;
    return inflight;
  }

  #checked(seq: number, unknown: readonly number[]): void {
    const call = this.#take(seq);
    if (call?.kind !== 'check') return;
    this.#retryAt = 0;
    if (call.lang === this.#lang) {
      const bad = new Set(unknown);
      call.words.forEach((word, i) => {
        this.#known.delete(word);
        this.#known.set(word, !bad.has(i));
      });
      // As mais antigas saem primeiro (o `Map` guarda a ordem de entrada).
      for (const word of this.#known.keys()) {
        if (this.#known.size <= SPELL_LIMITS.cacheWords) break;
        this.#known.delete(word);
      }
    }
    this.#next();
  }

  #suggestNext(view: EditorView, lang: string): void {
    if (this.#inflight || this.#destroyed) return;
    const head = view.state.selection.main.head;
    const visible = view.visibleRanges;
    const distance = (d: SpellDiag) =>
      head < d.from ? d.from - head : head > d.to ? head - d.to : 0;
    const nearest = view.state
      .field(spellField)
      .filter((d) => visible.some((r) => d.from < r.to && d.to > r.from))
      .sort((a, b) => distance(a) - distance(b))
      .slice(0, SPELL_LIMITS.suggestNearest);
    for (const diag of nearest) {
      if (diag.suggestions !== null) continue;
      const cached = this.#suggestions.get(diag.word);
      if (cached) {
        view.dispatch({ effects: spellSuggestions.of({ word: diag.word, suggestions: cached }) });
        continue;
      }
      if (this.#deps.clock.now() < this.#retryAt) {
        this.#schedule(0);
        return;
      }
      const seq = ++this.#seq;
      this.#inflight = { kind: 'suggest', seq, lang, word: diag.word };
      this.#deps.log('suggest', { words: 1 });
      this.#deps.engine.suggest(lang, diag.word).then(
        (list) => this.#suggested(seq, list),
        (error: unknown) => this.#failed(seq, error),
      );
      return;
    }
  }

  #suggested(seq: number, list: readonly string[]): void {
    const call = this.#take(seq);
    if (call?.kind !== 'suggest') return;
    this.#retryAt = 0;
    if (call.lang === this.#lang) this.#remember(call.word, insertable(list));
    this.#next();
  }

  /** As sugestões de `word` valem para as ocorrências dela no view verificado. */
  #remember(word: string, suggestions: readonly string[]): void {
    this.#suggestions.set(word, suggestions);
    const view = this.#view;
    if (view?.state.field(spellField).some((d) => d.word === word))
      view.dispatch({ effects: spellSuggestions.of({ word, suggestions }) });
  }

  #failed(seq: number, error: unknown): void {
    const call = this.#take(seq);
    if (!call) return;
    const code: SpellErrorCode | null =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error.code as SpellErrorCode)
        : null;
    this.#deps.log('error', {
      cancelled: code === 'CANCELLED' ? 1 : 0,
      timeout: code === 'TIMEOUT' ? 1 : 0,
    });
    if (code === 'CANCELLED') {
      // Outro pedido venceu (um plugin aprovado chamou o motor): tenta de novo depois, sem rajada.
      this.#retry(call, SPELL_TIMING.editMs);
      return;
    }
    if (call.kind === 'suggest' && code !== 'TIMEOUT') {
      // Sem sugestões para esta palavra (o cartão fica só com "Ignorar" e "Adicionar").
      if (call.lang === this.#lang) this.#remember(call.word, []);
      this.#next();
      return;
    }
    // TIMEOUT (fila do motor ocupada ou par Hunspell lento) ou erro: tenta de novo em 2 s.
    this.#retryAt = this.#deps.clock.now() + SPELL_TIMING.retryMs;
    this.#retry(call, SPELL_TIMING.retryMs);
  }

  /** O que a chamada levava volta a esperar: o trecho visível (verificação) ou a fila de sugestões. */
  #retry(call: Call, ms: number): void {
    const view = this.#view;
    if (!view || this.#destroyed) return;
    if (call.kind === 'check') this.#dirty = normalize([...this.#dirty, ...visibleOf(view)]);
    if (!this.#editPending) this.#schedule(ms);
  }

  /** Depois de uma resposta: a espera da edição em curso decide; sem ela, segue já. */
  #next(): void {
    if (this.#timer !== null || this.#destroyed) return;
    this.#run();
  }
}
