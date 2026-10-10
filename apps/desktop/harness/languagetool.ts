import type { LanguageToolTransport, LtCheckRequest } from '../src/platform/types';

/**
 * LanguageTool falso do harness (r7 arch-backend §1.4; AC-I8.* na QA). Mesmo contrato do transporte
 * nativo: corpo JSON cru ou erro `{ code, message, detail? }` com os códigos do Rust; "último vence"
 * (um `check` novo cancela o anterior com `CANCELLED`); tempo-limite pelo relógio do harness
 * (sonda 2 s, verificação 15 s → `TIMEOUT` com `detail.seconds`). `calls()` nunca guarda o texto:
 * só língua e contagens. As respostas gravadas do LT 6.8 real vêm de
 * `packages/plugins-internal/test/fixtures/lt/*.json` (S8; diretório vazio é válido, C-2).
 * Só neste bundle (`assert-no-harness`).
 */
export const FAKE_LT_MARKER = 'simplemd:fake-lt';

const recordedFiles = import.meta.glob<string>(
  '../../../packages/plugins-internal/test/fixtures/lt/*.json',
  { eager: true, query: '?raw', import: 'default' },
);
/** Nome (sem `.json`) → corpo gravado. */
const RECORDED = new Map(
  Object.entries(recordedFiles).map(([path, body]) => [
    path.slice(path.lastIndexOf('/') + 1, -'.json'.length),
    body,
  ]),
);

/** Mesmos limites do Rust (`languagetool::transport`, `policy`). */
export const LT_FAKE_LIMITS = {
  probeMs: 2_000,
  checkMs: 15_000,
  maxUnits: 20_000,
  checkMaxBytes: 2 * 1024 * 1024,
} as const;

/** Lista mínima de línguas para os modos de sucesso sem `languages.json` gravado. */
const SYNTHETIC_LANGUAGES = JSON.stringify([
  { name: 'Portuguese (Brazil)', code: 'pt', longCode: 'pt-BR' },
  { name: 'English (US)', code: 'en', longCode: 'en-US' },
]);
const NO_MATCHES = JSON.stringify({ matches: [] });

export type LtFakeMode =
  | { readonly kind: 'refused' }
  /** Aceita e nunca responde: só o tempo-limite encerra. */
  | { readonly kind: 'slow' }
  /** Responde (corpo de `body`, ou `{"matches":[]}`) depois de `ms`. */
  | { readonly kind: 'delay'; readonly ms: number; readonly body?: string }
  /** Corpo gravado `fixtures/lt/<name>.json` (S8). */
  | { readonly kind: 'recorded'; readonly name: string }
  /** Corpo sintético inline (C-2). */
  | { readonly kind: 'body'; readonly body: string }
  | { readonly kind: 'http'; readonly status: number }
  | { readonly kind: 'oversize' }
  | { readonly kind: 'badUtf8' };

export interface LtFakeCall {
  readonly op: 'languages' | 'check' | 'cancel';
  readonly requestId?: number;
  readonly language?: string;
  readonly segments?: number;
  /** Unidades UTF-16 enviadas (como o log do Rust). */
  readonly units?: number;
  readonly outcome: string;
  readonly ts: number;
}

export interface HarnessLtControl {
  readonly marker: string;
  mode: LtFakeMode;
  calls(): readonly LtFakeCall[];
  /** Nomes das respostas gravadas disponíveis. */
  recorded(): readonly string[];
  reset(): void;
}

export interface LtFakeClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: LtFakeClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as number),
};

interface LtError {
  readonly code: string;
  readonly message: string;
  readonly detail?: Record<string, number>;
}

const error = (code: string, detail?: Record<string, number>): LtError =>
  detail
    ? { code, message: `LanguageTool falso: ${code}`, detail }
    : { code, message: `LanguageTool falso: ${code}` };

export function createHarnessLanguageTool(clock: LtFakeClock = systemClock): {
  languageTool: LanguageToolTransport;
  control: HarnessLtControl;
} {
  let calls: LtFakeCall[] = [];
  /** Verificação em voo ("último vence"). */
  let inFlight: { id: number; reject: (reason: LtError) => void } | null = null;
  /** Sonda em voo (também "último vence"). */
  let probe: { reject: (reason: LtError) => void } | null = null;

  const control: HarnessLtControl = {
    marker: FAKE_LT_MARKER,
    mode: { kind: 'refused' },
    calls: () => calls,
    recorded: () => [...RECORDED.keys()],
    reset() {
      calls = [];
      control.mode = { kind: 'refused' };
    },
  };

  /** Corpo de sucesso para o modo atual, ou o erro que o Rust devolveria. */
  function outcome(op: 'languages' | 'check'): { body: string } | { error: LtError } | 'hang' {
    const mode = control.mode;
    switch (mode.kind) {
      case 'refused':
        return { error: error('CONNECTION_REFUSED') };
      case 'slow':
        return 'hang';
      case 'http':
        return { error: error('LT_HTTP_STATUS', { status: mode.status }) };
      case 'oversize':
        return { error: error('RESPONSE_TOO_LARGE') };
      case 'badUtf8':
        return { error: error('BAD_UTF8') };
      case 'recorded': {
        const body = op === 'languages' ? RECORDED.get('languages') : RECORDED.get(mode.name);
        return { body: body ?? (op === 'languages' ? SYNTHETIC_LANGUAGES : NO_MATCHES) };
      }
      case 'body':
        return { body: op === 'languages' ? SYNTHETIC_LANGUAGES : mode.body };
      case 'delay':
        return { body: op === 'languages' ? SYNTHETIC_LANGUAGES : (mode.body ?? NO_MATCHES) };
    }
  }

  /** Resolve depois do atraso do modo, ou `TIMEOUT` no limite (o que vier primeiro). */
  function respond(
    op: 'languages' | 'check',
    limitMs: number,
    register: (reject: (reason: LtError) => void) => void,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const result = outcome(op);
      const delay = control.mode.kind === 'delay' ? control.mode.ms : 0;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clock.clearTimeout(timeout);
        clock.clearTimeout(answer);
        fn();
      };
      const timeout = clock.setTimeout(
        () => finish(() => reject(error('TIMEOUT', { seconds: limitMs / 1000 }))),
        limitMs,
      );
      const answer =
        result === 'hang'
          ? null
          : clock.setTimeout(
              () => finish(() => ('body' in result ? resolve(result.body) : reject(result.error))),
              delay,
            );
      register((reason) => finish(() => reject(reason)));
    });
  }

  function record(call: Omit<LtFakeCall, 'ts'>): void {
    calls.push({ ...call, ts: clock.now() });
  }

  const languageTool: LanguageToolTransport = {
    async languages() {
      probe?.reject(error('CANCELLED'));
      try {
        const body = await respond('languages', LT_FAKE_LIMITS.probeMs, (reject) => {
          probe = { reject };
        });
        record({ op: 'languages', outcome: '200' });
        return body;
      } catch (reason) {
        record({ op: 'languages', outcome: (reason as LtError).code });
        throw reason;
      }
    },
    async check(req: LtCheckRequest, requestId: number) {
      const segments = req.annotation.length;
      const units = req.annotation.reduce(
        (sum, s) => sum + ('text' in s ? s.text.length : s.markup.length),
        0,
      );
      const base = { op: 'check' as const, requestId, language: req.language, segments, units };
      if (segments === 0 || units > LT_FAKE_LIMITS.maxUnits) {
        record({ ...base, outcome: 'LT_INVALID_REQUEST' });
        throw error('LT_INVALID_REQUEST');
      }
      inFlight?.reject(error('CANCELLED'));
      try {
        const body = await respond('check', LT_FAKE_LIMITS.checkMs, (reject) => {
          inFlight = { id: requestId, reject };
        });
        record({ ...base, outcome: '200' });
        return body;
      } catch (reason) {
        record({ ...base, outcome: (reason as LtError).code });
        throw reason;
      } finally {
        if (inFlight?.id === requestId) inFlight = null;
      }
    },
    async cancel(requestId: number) {
      record({ op: 'cancel', requestId, outcome: 'ok' });
      if (inFlight?.id === requestId) inFlight.reject(error('CANCELLED'));
    },
  };
  return { languageTool, control };
}
