import { AiTransportError, type AiHttpRequest, type ProviderId } from '@simplemd/ai';
import { replayTransport, type AiFixture, type ReplayCall } from '@simplemd/ai/testing';
import type { AiPlatform, KeyedProvider } from '../src/platform/types';

/**
 * IA do harness (arch-frontend r2 §15, H14): transporte de replay das fixtures de contrato e um
 * keychain FALSO em memória. Só neste bundle (`assert-no-harness` procura os marcadores abaixo).
 * O keychain falso não tem leitura (espelha o "sem get" nativo): os valores ficam numa closure e
 * nunca vão para storage, DOM ou `&persist=1`.
 */
export const FAKE_AI_MARKER = 'simplemd:fake-ai-transport';
export const FAKE_KEYCHAIN_MARKER = 'simplemd:fake-keychain';

const files = import.meta.glob<AiFixture>('../../../packages/ai/test/fixtures/*/*.json', {
  eager: true,
  import: 'default',
});
const FIXTURES: Record<string, AiFixture> = {};
for (const [path, fixture] of Object.entries(files)) {
  const match = /fixtures\/([a-z]+)\/([a-z0-9-]+)\.json$/.exec(path);
  if (match) FIXTURES[`${match[1]}/${match[2]}`] = fixture;
}

export type KeychainFailure =
  'KEYCHAIN_DENIED' | 'KEYCHAIN_UNAVAILABLE' | 'INVALID_KEY_FORMAT' | 'CANCELLED';

export interface HarnessAiCall {
  readonly provider: ProviderId;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  /** Só o NOME do cabeçalho que o Rust usaria (`authorization`/`x-api-key`), nunca o valor. */
  readonly authSlot: string | null;
  readonly cancelled: boolean;
}

/** Controles H14 expostos em `window.__simplemdHarness.ai` (e nos testes do desktop). */
export interface HarnessAiControl {
  readonly marker: string;
  /** `replay` (padrão), `error` (usa `fixture`), `refused` (conexão recusada do Ollama). */
  mode: 'replay' | 'error' | 'refused';
  /** Caso forçado `<provedor>/<caso>` (ex.: `ollama/stream-truncated`); `null` = pelo pedido. */
  fixture: string | null;
  /** Conjunto de fixtures usado (padrão: o do provedor do pedido). */
  fixtureSet: ProviderId | null;
  chunkDelayMs: number;
  firstChunkDelayMs: number;
  calls(): HarnessAiCall[];
  resetCalls(): void;
  readonly keychain: {
    readonly marker: string;
    has(provider: KeyedProvider): boolean;
    fail(code: KeychainFailure | null): void;
    clear(): void;
  };
}

export function createHarnessAi(): { platform: AiPlatform; control: HarnessAiControl } {
  const keys = new Map<KeyedProvider, true>();
  let failNext: KeychainFailure | null = null;
  const calls: ReplayCall[] = [];
  const control: HarnessAiControl = {
    marker: FAKE_AI_MARKER,
    mode: 'replay',
    fixture: null,
    fixtureSet: null,
    chunkDelayMs: 0,
    firstChunkDelayMs: 0,
    calls(): HarnessAiCall[] {
      return calls.map(({ request, cancelledAt }) => ({
        provider: request.provider,
        method: request.method,
        path: request.path,
        body: request.body === undefined ? null : (JSON.parse(request.body) as unknown),
        authSlot:
          request.provider === 'openai'
            ? 'authorization'
            : request.provider === 'anthropic'
              ? 'x-api-key'
              : null,
        cancelled: cancelledAt !== undefined,
      }));
    },
    resetCalls() {
      calls.length = 0;
    },
    keychain: {
      marker: FAKE_KEYCHAIN_MARKER,
      /** Só "existe ou não" (sem leitura do valor, como o nativo). */
      has: (provider: KeyedProvider) => keys.has(provider),
      /** H14: a próxima gravação ou remoção falha com este código. */
      fail(code: KeychainFailure | null) {
        failNext = code;
      },
      clear() {
        keys.clear();
      },
    },
  };

  const pick = (request: AiHttpRequest): AiFixture => {
    const set = control.fixtureSet ?? request.provider;
    if (control.mode === 'refused') return FIXTURES['ollama/connection-refused']!;
    if (control.fixture !== null && (control.mode === 'error' || request.method === 'POST')) {
      const forced = FIXTURES[control.fixture];
      if (forced) return forced;
    }
    const body =
      request.body === undefined ? null : (JSON.parse(request.body) as { stream?: boolean });
    const name =
      request.method === 'GET'
        ? 'list-models'
        : body?.stream === false
          ? 'chat-nostream'
          : 'chat-stream';
    return FIXTURES[`${set}/${name}`] ?? FIXTURES[`ollama/${name}`]!;
  };
  const replay = replayTransport(
    pick,
    () => ({ chunkDelayMs: control.chunkDelayMs, firstChunkDelayMs: control.firstChunkDelayMs }),
    calls,
  );

  const platform: AiPlatform = {
    transport: {
      send(request) {
        // Como o nativo: sem chave guardada, um provedor de nuvem falha antes de qualquer "rede".
        if (request.provider !== 'ollama' && !keys.has(request.provider)) {
          return {
            [Symbol.asyncIterator]: () => ({
              next: () =>
                Promise.reject(
                  new AiTransportError('KEY_MISSING', 'Sem chave para este provedor.'),
                ),
            }),
          };
        }
        return replay.send(request);
      },
    },
    async setKey(provider, value) {
      if (failNext !== null) {
        const code = failNext;
        failNext = null;
        throw { code, message: 'Falha injetada no keychain.' };
      }
      if (value.trim() === '') throw { code: 'INVALID_KEY_FORMAT', message: 'Chave vazia.' };
      keys.set(provider, true);
    },
    async hasKey(provider) {
      return keys.has(provider);
    },
    async deleteKey(provider) {
      if (failNext !== null) {
        const code = failNext;
        failNext = null;
        throw { code, message: 'Falha injetada no keychain.' };
      }
      keys.delete(provider);
    },
  };
  return { platform, control };
}
