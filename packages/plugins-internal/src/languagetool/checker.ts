import { ChangeSet, type EditorState, type Text } from '@codemirror/state';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import type { LtStatus } from '@simplemd/plugin-api/internal/host';
import type {
  LanguageToolTransport,
  LtCheckRequest,
} from '@simplemd/plugin-api/internal/languagetool';
import { planRequests, unitsIn, type PlannedRequest } from './annotate';
import { ltClearAll, ltDrop, ltField, ltResults, type LtDiag, type Range } from './field';
import { frontMatterLang, requestLanguage, type ServerLanguage } from './language';
import { isSpelling, parseCheckResponse, parseLanguages } from './response';

/**
 * Agendador do LanguageTool (arch-frontend r7 §10.5 `scheduler.ts`; R-I8.4, R-I8.7, R-I8.8,
 * R-I8.9, NFR-51). Uma instância por ativação do plugin; liga-se ao `EditorView` da nota aberta
 * (`attach`/`detach` pelo `ViewPlugin`). Relógio injetável (VT com relógio falso).
 *
 * - Automático: 1.000 ms depois da última edição, só os parágrafos alterados; ao abrir a nota, os
 *   do viewport (JEV D-R7-S8-03b: só na abertura). Manual: só pelo comando, que verifica a nota
 *   inteira. Nos dois: ≤ 20.000 unidades por pedido, ≤ 1 pedido em voo, o resto em fila.
 * - Edição com pedido em voo (automático): o pedido é cancelado na hora e os parágrafos voltam a
 *   pendentes; o próximo pedido o substitui (JEV D-R7-S8-02 A). No manual o pedido segue, e a
 *   resposta é remapeada pelas edições (o que elas tocam sai).
 * - Sonda `GET /v2/languages` (2 s) ao ligar e antes da primeira verificação; servidor ausente →
 *   "não encontrado", 1 aviso por sessão, sem diagnósticos, novas sondas em 30/60/120/300 s (e
 *   300 s daí em diante), na hora em "Tentar de novo" e no foco da janela.
 * - Verificação com 15 s → "sem resposta": saem os diagnósticos dos parágrafos alterados; nova
 *   tentativa na próxima edição ou em 30 s. Erros → resposta inteira descartada, "erro <código>",
 *   1 aviso por tipo por sessão.
 * - Privacidade (R-I8.10, AC-I8.11): o log recebe só contagens e tempos (o tipo só aceita números).
 */

export interface LtClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const LT_TIMING = {
  debounceMs: 1_000,
  probeMs: 2_000,
  checkMs: 15_000,
  /** Novas sondas com o servidor ausente; a última se repete. */
  retryMs: [30_000, 60_000, 120_000, 300_000],
  /** Depois de "sem resposta", sem nova edição. */
  timeoutRetryMs: 30_000,
} as const;

export interface LtConfig {
  readonly mode: 'auto' | 'manual';
  readonly language: string;
  readonly disabledRules: readonly string[];
  readonly dictionary: readonly string[];
}

export interface LtCheckerDeps {
  readonly transport: LanguageToolTransport;
  readonly clock: LtClock;
  config(): LtConfig;
  setStatus(status: LtStatus): void;
  notify(text: string, level: 'warn' | 'error'): void;
  /** Só contagens/tempos (nunca texto da nota). */
  log(event: string, counts: Readonly<Record<string, number>>): void;
}

/**
 * STR-169 sem o prefixo "Ortografia e gramática:" — o host já põe o nome do plugin na frente
 * ("Ortografia e gramática (LanguageTool): …"), como em todo aviso de plugin.
 */
export const NOT_FOUND_NOTICE =
  'servidor LanguageTool não encontrado em localhost:8081. Veja “Como instalar”.';
export const errorNotice = (code: string) => `o servidor respondeu com erro ${code}.`;

type Server = 'unknown' | 'probing' | 'ok' | 'not-found' | 'error';

interface InFlight {
  readonly id: number;
  readonly plan: PlannedRequest;
  readonly doc: Text;
  /** Mudanças desde o envio (modo manual: a resposta é remapeada por elas). */
  changes: ChangeSet;
  readonly guard: unknown;
  readonly sentAt: number;
}

/** Erro do transporte: `{ code, detail? }` do Rust; outra forma (sem `code`) = falha do app (F-08). */
export function transportError(error: unknown): { code: string | null; status: number | null } {
  if (typeof error !== 'object' || error === null) return { code: null, status: null };
  const code = 'code' in error && typeof error.code === 'string' ? error.code : null;
  const detail = 'detail' in error ? error.detail : null;
  const status =
    typeof detail === 'object' &&
    detail !== null &&
    'status' in detail &&
    typeof detail.status === 'number'
      ? detail.status
      : null;
  return { code, status };
}

const MAX_REQUEST_ID = 2 ** 32 - 1;

/** Funde intervalos sobrepostos ou encostados (ordenados). */
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

export class LtChecker {
  readonly #deps: LtCheckerDeps;
  #view: EditorView | null = null;
  #server: Server = 'unknown';
  #languages: readonly ServerLanguage[] = [];
  #retryIndex = 0;
  #retryTimer: unknown = null;
  #probeGuard: unknown = null;
  #probeSeq = 0;
  #debounce: unknown = null;
  #timeoutRetry: unknown = null;
  #inflight: InFlight | null = null;
  #nextId = 0;
  /** Trechos alterados (ou ainda não verificados) a verificar, em posições do documento atual. */
  #dirty: Range[] = [];
  /** O comando "Verificar agora" continua até esvaziar `#dirty` (também no manual). */
  #drain = false;
  readonly #warned = new Set<string>();
  #status: LtStatus | null = null;
  #destroyed = false;

  constructor(deps: LtCheckerDeps) {
    this.#deps = deps;
  }

  get serverState(): Server {
    return this.#server;
  }

  /** Nota aberta: o viewport (automático) entra na fila; sonda se o servidor não foi visto. */
  attach(view: EditorView): void {
    this.#view = view;
    this.#dirty = [];
    this.#drain = false;
    if (this.#deps.config().mode === 'auto')
      this.#dirty = normalize(view.visibleRanges.map((r) => ({ from: r.from, to: r.to })));
    if (this.#server === 'ok') {
      if (this.#deps.config().mode === 'auto') this.#run();
      else this.#setStatus({ state: 'manual' });
    } else if (this.#server === 'unknown') void this.#probe();
  }

  detach(view: EditorView): void {
    if (this.#view !== view) return;
    this.#cancelInflight();
    this.#clear('debounce');
    this.#clear('timeoutRetry');
    this.#view = null;
    this.#dirty = [];
  }

  /** Plugin desligado: nada mais roda; a barra perde o item. */
  destroy(): void {
    if (this.#view) this.detach(this.#view);
    this.#destroyed = true;
    this.#clear('retry');
    this.#clear('probe');
    this.#probeSeq++;
  }

  /** Edição: parágrafos tocados viram pendentes; automático reinicia a espera de 1.000 ms. */
  update(update: ViewUpdate): void {
    if (update.view !== this.#view || !update.docChanged) return;
    const changes = update.changes;
    const added: Range[] = [];
    changes.iterChangedRanges((_fA, _tA, fromB, toB) => added.push({ from: fromB, to: toB }));
    this.#dirty = normalize([
      ...this.#dirty.map((r) => ({
        from: changes.mapPos(r.from, -1),
        to: changes.mapPos(r.to, 1),
      })),
      ...added,
    ]);
    const auto = this.#deps.config().mode === 'auto';
    if (this.#inflight) {
      if (auto) this.#cancelInflight();
      else this.#inflight.changes = this.#inflight.changes.compose(changes);
    }
    this.#clear('timeoutRetry');
    if (auto) this.#schedule(LT_TIMING.debounceMs);
    else if (!this.#drain && this.#server === 'ok') this.#setStatus({ state: 'manual' });
  }

  /** "Verificar ortografia e gramática agora" (os dois modos): a nota inteira, em pedaços. */
  checkNow(): void {
    const view = this.#view;
    if (!view) return;
    this.#cancelInflight();
    this.#dirty = [{ from: 0, to: view.state.doc.length }];
    this.#drain = true;
    if (this.#server === 'ok') this.#run();
    else void this.#probe();
  }

  /** "Tentar de novo" (M2): sonda na hora se o servidor falhou; senão verifica o pendente. */
  retry(): void {
    this.#clear('retry');
    this.#clear('timeoutRetry');
    if (this.#server !== 'ok') {
      void this.#probe();
      return;
    }
    const view = this.#view;
    if (view && this.#dirty.length === 0)
      this.#dirty = normalize(view.visibleRanges.map((r) => ({ from: r.from, to: r.to })));
    this.#run();
  }

  /** Foco da janela: servidor ausente → sonda na hora. */
  windowFocused(): void {
    if (this.#server === 'not-found' || this.#server === 'error') this.retry();
  }

  /** Opção mudou: modo, idioma ou regras reativadas → reverifica o viewport (automático). */
  configChanged(): void {
    const view = this.#view;
    if (!view) return;
    this.#cancelInflight();
    if (this.#deps.config().mode === 'manual') {
      this.#clear('debounce');
      if (this.#server === 'ok') this.#setStatus({ state: 'manual' });
      return;
    }
    this.#dirty = normalize([
      ...this.#dirty,
      ...view.visibleRanges.map((r) => ({ from: r.from, to: r.to })),
    ]);
    if (this.#server === 'ok') this.#schedule(0);
  }

  // --- interno ---------------------------------------------------------------------------------

  #clear(which: 'debounce' | 'timeoutRetry' | 'retry' | 'probe'): void {
    const { clock } = this.#deps;
    if (which === 'debounce' && this.#debounce !== null) clock.clearTimeout(this.#debounce);
    if (which === 'timeoutRetry' && this.#timeoutRetry !== null)
      clock.clearTimeout(this.#timeoutRetry);
    if (which === 'retry' && this.#retryTimer !== null) clock.clearTimeout(this.#retryTimer);
    if (which === 'probe' && this.#probeGuard !== null) clock.clearTimeout(this.#probeGuard);
    if (which === 'debounce') this.#debounce = null;
    if (which === 'timeoutRetry') this.#timeoutRetry = null;
    if (which === 'retry') this.#retryTimer = null;
    if (which === 'probe') this.#probeGuard = null;
  }

  #schedule(ms: number): void {
    this.#clear('debounce');
    this.#debounce = this.#deps.clock.setTimeout(() => {
      this.#debounce = null;
      this.#run();
    }, ms);
  }

  #setStatus(status: LtStatus): void {
    if (this.#destroyed) return;
    const prev = this.#status;
    if (prev && JSON.stringify(prev) === JSON.stringify(status)) return;
    this.#status = status;
    this.#deps.setStatus(status);
  }

  #warnOnce(key: string, text: string, level: 'warn' | 'error'): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.#deps.notify(text, level);
  }

  #dispatch(effects: Parameters<EditorView['dispatch']>[0]): void {
    this.#view?.dispatch(effects);
  }

  #issues(): void {
    const view = this.#view;
    const count = view ? view.state.field(ltField).diags.length : 0;
    this.#setStatus({ state: 'issues', count });
  }

  async #probe(): Promise<void> {
    if (this.#destroyed) return;
    this.#clear('retry');
    this.#clear('probe');
    const seq = ++this.#probeSeq;
    this.#server = 'probing';
    this.#setStatus({ state: 'checking' });
    const started = this.#deps.clock.now();
    // Forma com executor: `Promise.withResolvers` não existe no WKWebView < 14.4 (CR-08, lint).
    const outcome = await new Promise<
      { ok: true; languages: ServerLanguage[] } | { ok: false; code: string | null }
    >((resolve) => {
      this.#probeGuard = this.#deps.clock.setTimeout(
        () => resolve({ ok: false, code: null }),
        LT_TIMING.probeMs,
      );
      this.#deps.transport.languages().then(
        (body) => {
          const languages = parseLanguages(body);
          resolve(languages ? { ok: true, languages } : { ok: false, code: 'resposta inválida' });
        },
        (error: unknown) => resolve({ ok: false, code: this.#errorCode(error) }),
      );
    });
    if (seq !== this.#probeSeq || this.#destroyed) return;
    this.#clear('probe');
    this.#deps.log('probe', { ms: this.#deps.clock.now() - started, ok: outcome.ok ? 1 : 0 });
    if (outcome.ok) {
      this.#server = 'ok';
      this.#languages = outcome.languages;
      this.#retryIndex = 0;
      if (this.#drain || this.#deps.config().mode === 'auto') this.#run();
      else this.#setStatus({ state: 'manual' });
      return;
    }
    if (outcome.code === null) this.#notFound();
    else this.#failed(outcome.code);
    this.#scheduleProbe();
  }

  #scheduleProbe(): void {
    const delays = LT_TIMING.retryMs;
    const delay = delays[Math.min(this.#retryIndex, delays.length - 1)] as number;
    this.#retryIndex++;
    this.#clear('retry');
    this.#retryTimer = this.#deps.clock.setTimeout(() => {
      this.#retryTimer = null;
      void this.#probe();
    }, delay);
  }

  /**
   * Código do erro do transporte para o indicador; `null` = servidor ausente (conexão recusada,
   * rede, tempo esgotado da sonda).
   */
  #errorCode(error: unknown): string | null {
    const { code, status } = transportError(error);
    switch (code) {
      case 'CONNECTION_REFUSED':
      case 'NETWORK':
      case 'TIMEOUT':
        return null;
      case 'LT_HTTP_STATUS':
        return status === null ? 'resposta inválida' : String(status);
      case 'RESPONSE_TOO_LARGE':
        return 'resposta grande demais';
      case 'BAD_UTF8':
      case 'REDIRECT_NOT_FOLLOWED':
        return 'resposta inválida';
      default:
        // LT_INVALID_REQUEST, BODY_TOO_LARGE ou rejeição sem `code` (falha do app, F-08).
        return 'pedido inválido';
    }
  }

  #notFound(): void {
    this.#server = 'not-found';
    this.#drain = false;
    this.#setStatus({ state: 'not-found' });
    this.#dispatch({ effects: ltClearAll.of(null) });
    this.#warnOnce('not-found', NOT_FOUND_NOTICE, 'warn');
  }

  #failed(code: string): void {
    if (this.#server === 'probing') this.#server = 'error';
    this.#drain = false;
    this.#setStatus({ state: 'error', code });
    this.#warnOnce(`error:${code}`, errorNotice(code), 'error');
  }

  #pendingUnits(state: EditorState) {
    const units = this.#dirty.flatMap((r) => unitsIn(state, r.from, r.to));
    const seen = new Set<number>();
    return units.filter((u) => !seen.has(u.from) && Boolean(seen.add(u.from)));
  }

  #run(): void {
    this.#clear('debounce');
    const view = this.#view;
    if (!view || this.#inflight || this.#destroyed) return;
    if (this.#server !== 'ok') {
      if (this.#server !== 'probing') void this.#probe();
      return;
    }
    const state = view.state;
    const units = this.#pendingUnits(state);
    const plan = units.length ? planRequests(state, units)[0] : undefined;
    if (!plan) {
      this.#dirty = [];
      this.#drain = false;
      this.#issues();
      return;
    }
    this.#dirty = this.#dirty.flatMap((r) => {
      if (r.to <= plan.from || r.from >= plan.to) return [r];
      const out: Range[] = [];
      if (r.from < plan.from) out.push({ from: r.from, to: plan.from });
      if (r.to > plan.to) out.push({ from: plan.to, to: r.to });
      return out;
    });
    this.#send(state, plan);
  }

  #send(state: EditorState, plan: PlannedRequest): void {
    const config = this.#deps.config();
    this.#nextId = this.#nextId >= MAX_REQUEST_ID ? 1 : this.#nextId + 1;
    const id = this.#nextId;
    const request: LtCheckRequest = {
      ...requestLanguage(config.language, frontMatterLang(state), this.#languages),
      annotation: plan.annotation,
      ...(config.disabledRules.length ? { disabledRules: config.disabledRules } : {}),
    };
    const guard = this.#deps.clock.setTimeout(() => this.#timedOut(id), LT_TIMING.checkMs);
    this.#inflight = {
      id,
      plan,
      doc: state.doc,
      changes: ChangeSet.empty(state.doc.length),
      guard,
      sentAt: this.#deps.clock.now(),
    };
    this.#setStatus({ state: 'checking' });
    this.#deps.log('check', {
      units: plan.to - plan.from,
      segments: plan.annotation.length,
      paragraphs: plan.units.length,
    });
    this.#deps.transport.check(request, id).then(
      (body) => this.#answered(id, body),
      (error: unknown) => this.#rejected(id, error),
    );
  }

  /** Tira o pedido em voo (os parágrafos dele voltam a pendentes). */
  #takeInflight(id?: number): InFlight | null {
    const inflight = this.#inflight;
    if (!inflight || (id !== undefined && inflight.id !== id)) return null;
    this.#inflight = null;
    this.#deps.clock.clearTimeout(inflight.guard);
    return inflight;
  }

  #requeue(inflight: InFlight): Range[] {
    const { changes } = inflight;
    const ranges = inflight.plan.units.map((u) => ({
      from: changes.mapPos(u.from, -1),
      to: changes.mapPos(u.to, 1),
    }));
    this.#dirty = normalize([...this.#dirty, ...ranges]);
    return ranges;
  }

  #cancelInflight(): void {
    const inflight = this.#takeInflight();
    if (!inflight) return;
    this.#requeue(inflight);
    this.#deps.transport.cancel(inflight.id).catch(() => undefined);
  }

  #timedOut(id: number): void {
    const inflight = this.#takeInflight(id);
    if (!inflight) return;
    this.#deps.transport.cancel(id).catch(() => undefined);
    this.#timeout(inflight);
  }

  #timeout(inflight: InFlight): void {
    const ranges = this.#requeue(inflight);
    this.#drain = false;
    this.#dispatch({ effects: ltDrop.of(ranges) });
    this.#setStatus({ state: 'timeout' });
    this.#deps.log('timeout', { ms: this.#deps.clock.now() - inflight.sentAt });
    this.#clear('timeoutRetry');
    this.#timeoutRetry = this.#deps.clock.setTimeout(() => {
      this.#timeoutRetry = null;
      this.#run();
    }, LT_TIMING.timeoutRetryMs);
  }

  #rejected(id: number, error: unknown): void {
    const inflight = this.#takeInflight(id);
    if (!inflight) return;
    const { code } = transportError(error);
    if (code === 'CANCELLED') {
      this.#requeue(inflight);
      return;
    }
    if (code === 'TIMEOUT') {
      this.#timeout(inflight);
      return;
    }
    this.#requeue(inflight);
    const mapped = this.#errorCode(error);
    this.#deps.log('error', { ms: this.#deps.clock.now() - inflight.sentAt });
    if (mapped === null) {
      this.#notFound();
      this.#retryIndex = 0;
      this.#scheduleProbe();
    } else this.#failed(mapped);
  }

  #answered(id: number, body: string): void {
    const inflight = this.#takeInflight(id);
    const view = this.#view;
    if (!inflight || !view) return;
    const { plan, changes, doc } = inflight;
    const result = parseCheckResponse(body, plan.to - plan.from);
    if (!result.ok) {
      this.#requeue(inflight);
      this.#failed(result.error);
      return;
    }
    const config = this.#deps.config();
    const disabled = new Set(config.disabledRules);
    const dictionary = new Set(config.dictionary);
    const diags: LtDiag[] = [];
    for (const match of result.matches) {
      const from = plan.from + match.offset;
      const to = from + match.length;
      const expected = doc.sliceString(from, to);
      const spelling = isSpelling(match);
      if (disabled.has(match.ruleId) || (spelling && dictionary.has(expected))) continue;
      if (to === from || changes.touchesRange(from, to)) continue;
      diags.push({ from: changes.mapPos(from), to: changes.mapPos(to), expected, match, spelling });
    }
    const ranges = plan.units.map((u) => ({
      from: changes.mapPos(u.from, 1),
      to: changes.mapPos(u.to, -1),
    }));
    view.dispatch({ effects: ltResults.of({ ranges, diags }) });
    this.#deps.log('result', {
      ms: this.#deps.clock.now() - inflight.sentAt,
      matches: result.matches.length,
      shown: diags.length,
    });
    this.#issues();
    const auto = config.mode === 'auto';
    if (this.#dirty.length && (this.#drain || (auto && this.#debounce === null))) this.#run();
    else if (!this.#dirty.length) this.#drain = false;
  }
}
