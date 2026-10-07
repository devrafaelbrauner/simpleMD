import {
  AiTransportError,
  type AiHttpRequest,
  type AiTransport,
  type AiTransportErrorCode,
  type AiTransportEvent,
} from '../transport';

/**
 * Fixture de contrato (formato do gravador nativo, `src-tauri/src/ai/recorder.rs`): o pedido
 * gravado (provedor, método, caminho, corpo), a resposta (status, `contentType`, pedaços na ordem
 * em que chegaram) e o que o teste espera. Uma falha do transporte nativo (conexão recusada) é
 * `transportError`.
 */
export interface AiFixture {
  readonly request?: {
    readonly provider: string;
    readonly method: string;
    readonly path: string;
    readonly body?: unknown;
  };
  readonly response?: {
    readonly status: number;
    readonly contentType: string | null;
    readonly chunks: readonly string[];
  };
  readonly transportError?: {
    readonly code: AiTransportErrorCode;
    readonly message: string;
    readonly detail?: { readonly seconds?: number };
  };
  readonly expected?: {
    readonly models?: readonly string[];
    readonly text?: string;
    readonly partialText?: string;
    readonly status?: number;
    readonly error?: string;
    readonly message?: string;
  };
}

export interface ReplayOptions {
  /** Espera antes do primeiro pedaço (ms). */
  readonly firstChunkDelayMs?: number;
  /** Espera entre pedaços (ms). */
  readonly chunkDelayMs?: number;
}

/** Registro de um pedido feito ao transporte de replay (sem segredo: não há autenticação aqui). */
export interface ReplayCall {
  readonly request: AiHttpRequest;
  readonly startedAt: number;
  /** Quando `return()` cancelou o pedido (ms desde a época), se cancelou. */
  cancelledAt?: number;
  /** Quantos eventos já tinham saído quando terminou ou foi cancelado. */
  delivered: number;
}

/**
 * Transporte de replay (arch-backend r2 §1.7.4): emite `head`, os pedaços gravados e `end`, com
 * atrasos opcionais. `return()` cancela na hora, mesmo no meio de uma espera, como o `ai_cancel`.
 * Usado pelos testes de contrato e pelo harness (nunca no app de produção).
 */
export function replayTransport(
  pick: (request: AiHttpRequest) => AiFixture,
  options: ReplayOptions | (() => ReplayOptions) = {},
  calls: ReplayCall[] = [],
): AiTransport & { readonly calls: ReplayCall[] } {
  return {
    calls,
    send(request) {
      return {
        [Symbol.asyncIterator](): AsyncIterator<AiTransportEvent> {
          const fixture = pick(request);
          const { firstChunkDelayMs = 0, chunkDelayMs = 0 } =
            typeof options === 'function' ? options() : options;
          const call: ReplayCall = { request, startedAt: Date.now(), delivered: 0 };
          calls.push(call);
          const events: AiTransportEvent[] = fixture.response
            ? [
                {
                  kind: 'head',
                  status: fixture.response.status,
                  contentType: fixture.response.contentType,
                },
                ...fixture.response.chunks.map((text) => ({ kind: 'chunk' as const, text })),
                { kind: 'end' },
              ]
            : [];
          let index = 0;
          let closed = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let wake: (() => void) | undefined;
          const wait = (ms: number) =>
            new Promise<void>((resolve) => {
              wake = resolve;
              timer = setTimeout(resolve, ms);
            });
          return {
            async next(): Promise<IteratorResult<AiTransportEvent>> {
              if (closed) return { done: true, value: undefined };
              // `head` sai na hora; o 1º pedaço (ou a falha) espera `firstChunkDelayMs`; os
              // seguintes, `chunkDelayMs`.
              const delay =
                events.length === 0 || index === 1
                  ? firstChunkDelayMs
                  : index > 1
                    ? chunkDelayMs
                    : 0;
              if (delay > 0) await wait(delay);
              else await Promise.resolve();
              if (closed) return { done: true, value: undefined };
              if (events.length === 0) {
                closed = true;
                const error = fixture.transportError ?? {
                  code: 'NETWORK' as const,
                  message: 'Fixture sem resposta.',
                };
                throw new AiTransportError(error.code, error.message, error.detail);
              }
              const event = events[index++];
              if (event === undefined) {
                closed = true;
                return { done: true, value: undefined };
              }
              call.delivered++;
              if (event.kind === 'end') closed = true;
              return { done: false, value: event };
            },
            async return(): Promise<IteratorResult<AiTransportEvent>> {
              if (!closed) {
                closed = true;
                call.cancelledAt = Date.now();
                clearTimeout(timer);
                wake?.();
              }
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  };
}
