import type {
  SpellError,
  SpellErrorCode,
  SpellReloaded,
  SpellTransport,
} from '../src/platform/types';

/**
 * Corretor offline falso do harness e dos testes (r35a; design-r35 §1), com as regras dos comandos
 * Rust da r34 (`src-tauri/src/spell/mod.rs`): só `pt-BR` (`UNSUPPORTED_LANG`); até 20.000 palavras
 * por `check` (`TOO_MANY_WORDS` com `detail.max`), e o pedido recusado pela língua ou pelo teto não
 * cancela o anterior; o pedido mais novo de cada comando vence (o anterior → `CANCELLED`) e
 * `check([])` só cancela; a palavra vai a NFC, e a que não é um termo v1 inteiro (vazia, com espaço,
 * controle ou invisível, `#` no início, mais de 64 caracteres) nunca é marcada nem tem sugestão; até
 * 5 sugestões, na caixa da palavra (Título, MAIÚSCULAS); `reload` → `{ langs: ['pt-BR'], words,
 * pairs, skipped }` com os termos do usuário (`layers`: a camada global e, com uma pasta aberta, a
 * dela), que daí em diante não são erro — também em Título e MAIÚSCULAS —, trocados só se nenhuma
 * recarga mais nova chegou.
 *
 * "Base": toda palavra é conhecida, menos as de `misspellings` (o harness: "excessão" → "exceção").
 * Nos testes começa vazio — nenhum erro, nenhuma camada —, então os testes de antes não mudam. Sem
 * pares Hunspell (`pairs: 0`, `skipped: 0`): `TIMEOUT` e `IO` só por `failNext`. `delayMs` atrasa
 * toda resposta (0 = na hora, sem relógio). `calls()` nunca guarda palavras: só a língua e
 * contagens. Só neste bundle (`assert-no-harness` procura o marcador).
 */
export const FAKE_SPELL_MARKER = 'simplemd:fake-spell';

/** Os limites do Rust (`spell/mod.rs`: `MAX_WORDS`, `MAX_SUGGESTIONS`, `TERM_MAX_CHARS`, prazo). */
export const SPELL_FAKE_LIMITS = {
  maxWords: 20_000,
  maxSuggestions: 5,
  termMaxChars: 64,
  timeoutSeconds: 3,
} as const;

/** O erro de ortografia do harness (`pt-BR-check.md`, design-r35 §4). */
export const HARNESS_MISSPELLINGS: Readonly<Record<string, readonly string[]>> = {
  excessão: ['exceção'],
};

export type SpellFakeOp = 'check' | 'suggest' | 'reload';

export interface SpellFakeCall {
  readonly op: SpellFakeOp;
  /** `check` e `suggest`: a língua pedida. */
  readonly lang?: string;
  /** `check`: quantas palavras foram (nunca quais). */
  readonly words?: number;
  /** O que voltou: desconhecidas (`check`), sugestões (`suggest`) ou termos do usuário (`reload`). */
  readonly count?: number;
  /** `reload`: com uma pasta aberta (o token do Tauri). */
  readonly folder?: boolean;
  /** `ok` ou o código do erro. */
  readonly outcome: string;
  readonly ts: number;
}

/** As camadas do usuário que o `spell_reload` do Rust leria. */
export interface HarnessSpellLayers {
  /** Há uma pasta aberta: a recarga do Tauri iria com o token dela. */
  folder(): boolean;
  /** Os termos (formato v1) da camada global e, com `folder`, os da pasta. */
  terms(folder: boolean): Promise<readonly string[]>;
}

export interface HarnessSpellControl {
  readonly marker: string;
  /** Atraso de toda resposta, em ms (0 = na hora). */
  delayMs: number;
  calls(): readonly SpellFakeCall[];
  /** O próximo pedido `op` (sem `op`, o de qualquer comando) falha com `code` depois de admitido. */
  failNext(code: SpellErrorCode, op?: SpellFakeOp): void;
  /** Sem chamadas, falhas pendentes nem atraso; os termos da última recarga continuam. */
  reset(): void;
}

export interface SpellFakeClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: SpellFakeClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as number),
};

/** Espaço, controle, formatação invisível e metade de par substituto: fora de um termo v1. */
const NOT_IN_TERM = /[\p{White_Space}\p{Cc}\p{Cf}\p{Cs}]/u;

function failure(code: SpellErrorCode): SpellError {
  const message = `Corretor falso: ${code}`;
  if (code === 'TOO_MANY_WORDS')
    return { code, message, detail: { max: SPELL_FAKE_LIMITS.maxWords } };
  if (code === 'TIMEOUT')
    return { code, message, detail: { seconds: SPELL_FAKE_LIMITS.timeoutSeconds } };
  return { code, message };
}

/** A palavra como o Rust a confere (`checkable_word`): em NFC e termo v1 inteiro; senão `null`. */
function checkable(word: string): string | null {
  // Acima de 1.024 unidades passa dos 1.024 bytes do Rust (e de 64 caracteres mesmo em NFC).
  if (word.length > 1024) return null;
  const nfc = word.normalize('NFC');
  if (nfc === '' || nfc.startsWith('#') || NOT_IN_TERM.test(nfc)) return null;
  return [...nfc].length > SPELL_FAKE_LIMITS.termMaxChars ? null : nfc;
}

/** Primeira letra maiúscula, por ponto de código. */
function capitalized(text: string): string {
  const [first = '', ...rest] = text;
  return first.toUpperCase() + rest.join('');
}

/**
 * As formas que um dicionário Hunspell confere para `word`: ela e, em Título, a minúscula; em
 * MAIÚSCULAS, também a de Título. Com caixa misturada, só ela.
 */
function forms(word: string): string[] {
  const lower = word.toLowerCase();
  if (word === lower) return [word];
  const title = capitalized(lower);
  if (word === word.toUpperCase()) return [word, title, lower];
  return word === title ? [word, lower] : [word];
}

export function createHarnessSpell(
  options: {
    /** Palavras que a "base" não conhece, com as sugestões; sem isto, nenhuma (os testes). */
    readonly misspellings?: Readonly<Record<string, readonly string[]>>;
    /** As camadas do usuário; sem isto, a recarga não tem termos (os testes). */
    readonly layers?: HarnessSpellLayers;
    readonly clock?: SpellFakeClock;
  } = {},
): { spell: SpellTransport; control: HarnessSpellControl } {
  const clock = options.clock ?? systemClock;
  const misspelled = new Map(
    Object.entries(options.misspellings ?? {}).map(([word, suggestions]) => [
      word.normalize('NFC'),
      suggestions.map((suggestion) => suggestion.normalize('NFC')),
    ]),
  );
  /** Os termos do usuário da última recarga trocada. */
  let terms: ReadonlySet<string> = new Set();
  let calls: SpellFakeCall[] = [];
  let failures: Array<{ readonly code: SpellErrorCode; readonly op: SpellFakeOp | undefined }> = [];
  /** Quem rejeita o pedido em voo de cada comando (o mais novo vence). */
  const inFlight = new Map<SpellFakeOp, (error: SpellError) => void>();

  const control: HarnessSpellControl = {
    marker: FAKE_SPELL_MARKER,
    delayMs: 0,
    calls: () => calls,
    failNext(code, op) {
      failures.push({ code, op });
    },
    reset() {
      calls = [];
      failures = [];
      control.delayMs = 0;
    },
  };

  type Call = Omit<SpellFakeCall, 'ts' | 'outcome' | 'count'>;

  function record(call: Omit<SpellFakeCall, 'ts'>): void {
    calls.push({ ...call, ts: clock.now() });
  }

  /** Recusado antes de admitir (língua, teto): registra e rejeita sem cancelar o pedido em voo. */
  function refuse<T>(call: Call, code: SpellErrorCode): Promise<T> {
    record({ ...call, outcome: code });
    return Promise.reject(failure(code));
  }

  /**
   * Admite um pedido: o anterior em voo do mesmo comando sai com `CANCELLED`; este responde depois de
   * `delayMs` com `run()` (ou com a falha de `failNext`), se nenhum mais novo chegar antes — só então
   * roda o `commit` (a troca de camadas do `reload`).
   */
  function admit<T>(
    op: SpellFakeOp,
    call: Call,
    run: () => Promise<{ readonly value: T; readonly count: number; readonly commit?: () => void }>,
  ): Promise<T> {
    inFlight.get(op)?.(failure('CANCELLED'));
    const at = failures.findIndex((f) => f.op === undefined || f.op === op);
    const planned = at < 0 ? null : (failures.splice(at, 1)[0] ?? null);
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    let settled = false;
    let timer: unknown = null;
    const settle = (outcome: string, count: number | null, done: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clock.clearTimeout(timer);
      if (inFlight.get(op) === fail) inFlight.delete(op);
      record({ ...call, ...(count === null ? {} : { count }), outcome });
      done();
    };
    const fail = (error: SpellError) => settle(error.code, null, () => reject(error));
    inFlight.set(op, fail);
    const answer = () => {
      if (planned !== null) {
        fail(failure(planned.code));
        return;
      }
      run().then(
        ({ value, count, commit }) =>
          settle('ok', count, () => {
            commit?.();
            resolve(value);
          }),
        () => fail(failure('IO')),
      );
    };
    if (control.delayMs > 0) timer = clock.setTimeout(answer, control.delayMs);
    else void Promise.resolve().then(answer);
    return promise;
  }

  const spell: SpellTransport = {
    check(lang, words) {
      const call: Call = { op: 'check', lang, words: words.length };
      if (lang !== 'pt-BR') return refuse(call, 'UNSUPPORTED_LANG');
      if (words.length > SPELL_FAKE_LIMITS.maxWords) return refuse(call, 'TOO_MANY_WORDS');
      return admit<readonly number[]>('check', call, async () => {
        const unknown: number[] = [];
        words.forEach((word, index) => {
          const form = checkable(word);
          if (form === null) return;
          const candidates = forms(form);
          if (candidates.some((f) => misspelled.has(f)) && !candidates.some((f) => terms.has(f)))
            unknown.push(index);
        });
        return { value: unknown, count: unknown.length };
      });
    },
    suggest(lang, word) {
      const call: Call = { op: 'suggest', lang };
      if (lang !== 'pt-BR') return refuse(call, 'UNSUPPORTED_LANG');
      return admit<readonly string[]>('suggest', call, async () => {
        const asked = checkable(word);
        const key = asked === null ? undefined : forms(asked).find((f) => misspelled.has(f));
        if (asked === null || key === undefined) return { value: [], count: 0 };
        const upper = asked !== key && asked === asked.toUpperCase();
        const found = (misspelled.get(key) ?? [])
          .slice(0, SPELL_FAKE_LIMITS.maxSuggestions)
          .map((s) => (upper ? s.toUpperCase() : asked !== key ? capitalized(s) : s));
        return { value: found, count: found.length };
      });
    },
    reload() {
      const folder = options.layers?.folder() ?? false;
      return admit<SpellReloaded>('reload', { op: 'reload', folder }, async () => {
        const read = (await options.layers?.terms(folder)) ?? [];
        const next = new Set(read.map((term) => term.normalize('NFC')));
        return {
          value: { langs: ['pt-BR'], words: next.size, pairs: 0, skipped: 0 },
          count: next.size,
          commit: () => {
            terms = next;
          },
        };
      });
    },
  };
  return { spell, control };
}
