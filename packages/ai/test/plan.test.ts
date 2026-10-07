import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createAnthropicProvider,
  createOllamaProvider,
  createOpenAIProvider,
  type AIProvider,
  type AiHttpRequest,
  type AiTransport,
  type ProviderId,
} from '../src';
import { PLAN_MESSAGES } from './helpers';

/**
 * Plano de gravação (`test/fixtures/plan.json`) lido por `cargo run --example record_ai_fixtures`:
 * os pedidos EXATOS que os adaptadores fazem, com `{{model}}` no lugar do modelo. Este teste
 * prova que o plano é o que o app envia; `SIMPLEMD_WRITE_AI_PLAN=1` regrava o arquivo.
 */
const PLAN_URL = new URL('./fixtures/plan.json', import.meta.url);
const MODEL = '{{model}}';
const MISSING_MODEL = 'modelo-inexistente-simplemd';

function capturing(): AiTransport & { requests: AiHttpRequest[] } {
  const requests: AiHttpRequest[] = [];
  return {
    requests,
    send(request) {
      requests.push(request);
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject({ code: 'CANCELLED', message: 'captura' }),
        }),
      };
    },
  };
}

async function drain(iterable: AsyncIterable<string>): Promise<void> {
  try {
    for await (const part of iterable) void part;
  } catch {
    // a captura sempre "falha": só o pedido importa
  }
}

async function requestsOf(make: (t: AiTransport) => AIProvider, model: string) {
  const transport = capturing();
  const provider = make(transport);
  await provider.listModels().catch(() => undefined);
  await drain(provider.chat(PLAN_MESSAGES, { model, stream: true }));
  await drain(provider.chat(PLAN_MESSAGES, { model, stream: false }));
  return transport.requests;
}

const strip = ({ method, path, headers, body }: AiHttpRequest) => ({
  method,
  path,
  headers,
  ...(body === undefined ? {} : { body }),
});

async function buildPlan() {
  const section = async (
    id: ProviderId,
    make: (t: AiTransport) => AIProvider,
    apiVersion: string,
    synthetic: string[],
  ) => {
    const [list, stream, whole] = await requestsOf(make, MODEL);
    const cases: Array<Record<string, unknown>> = [
      { case: 'list-models', ...strip(list!) },
      { case: 'chat-stream', ...strip(stream!) },
      { case: 'chat-nostream', ...strip(whole!) },
    ];
    if (id === 'ollama') {
      const [, missing] = await requestsOf(make, MISSING_MODEL);
      cases.push({ case: 'error-404', ...strip(missing!), expectStatus: 404 });
    } else {
      cases.push({ case: 'error-401', ...strip(stream!), invalidKey: true, expectStatus: 401 });
    }
    return { apiVersion, synthetic, cases };
  };
  return {
    openai: await section('openai', createOpenAIProvider, 'Chat Completions v1 (SSE)', [
      'error-429',
      'error-500',
    ]),
    anthropic: await section(
      'anthropic',
      createAnthropicProvider,
      'Messages, anthropic-version 2023-06-01 (SSE)',
      ['error-429', 'error-500'],
    ),
    ollama: await section(
      'ollama',
      (t) => createOllamaProvider(t),
      'api/chat (NDJSON) e api/tags',
      ['error-429', 'error-500', 'connection-refused'],
    ),
  };
}

describe('plano de gravação das fixtures (R-11.10)', () => {
  it('é exatamente o que os adaptadores pedem', async () => {
    const plan = await buildPlan();
    if (process.env.SIMPLEMD_WRITE_AI_PLAN === '1')
      writeFileSync(PLAN_URL, `${JSON.stringify(plan, null, 2)}\n`);
    expect(JSON.parse(readFileSync(PLAN_URL, 'utf8'))).toEqual(plan);
    // Nenhum pedido carrega autenticação: ela é posta pelo transporte nativo.
    expect(JSON.stringify(plan)).not.toMatch(/authorization|x-api-key|bearer/i);
  });
});
