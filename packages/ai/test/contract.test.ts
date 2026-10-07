import { readdirSync, readFileSync, statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AIError,
  ANTHROPIC_MAX_TOKENS,
  ANTHROPIC_VERSION,
  createProvider,
  PROVIDER_IDS,
  type AiHttpRequest,
  type ProviderId,
} from '../src';
import { replayTransport, type AiFixture, type ReplayCall } from '../src/testing/replay';
import { FIXTURES, PLAN_MESSAGES, readFixtures } from './helpers';

/**
 * AC-11.2: suíte de contrato por adaptador contra as fixtures (gravadas ou sintéticas, conforme
 * `meta.json`). Cada caso confere o descritor do pedido (método, caminho, campos do corpo, nome do
 * cabeçalho de versão, nenhuma autenticação) e a saída interpretada.
 */
function setup(provider: ProviderId, fixture: AiFixture, options = {}) {
  const calls: ReplayCall[] = [];
  const transport = replayTransport(() => fixture, options, calls);
  return { calls, adapter: createProvider(provider, transport) };
}

async function drain(iterable: AsyncIterable<string>) {
  const chunks: string[] = [];
  let error: unknown = null;
  try {
    for await (const chunk of iterable) chunks.push(chunk);
  } catch (caught) {
    error = caught;
  }
  return { chunks, error };
}

function modelOf(fixture: AiFixture): string {
  const body = fixture.request?.body as { model?: string } | undefined;
  return body?.model ?? 'modelo';
}

/** O pedido não traz autenticação nem segredo: o transporte nativo põe a chave. */
function assertNoSecret(request: AiHttpRequest) {
  const names = Object.keys(request.headers).map((name) => name.toLowerCase());
  expect(names).not.toContain('authorization');
  expect(names).not.toContain('x-api-key');
  expect(JSON.stringify(request)).not.toMatch(/sk-[A-Za-z0-9_-]{8,}|Bearer\s/);
}

function assertRequest(provider: ProviderId, request: AiHttpRequest, fixture: AiFixture) {
  expect(request.provider).toBe(provider);
  expect(request.method).toBe(fixture.request?.method);
  expect(request.path).toBe(fixture.request?.path);
  assertNoSecret(request);
  if (provider === 'anthropic')
    expect(request.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
  else expect(request.headers['anthropic-version']).toBeUndefined();
  if (fixture.request?.body !== undefined && fixture.request.body !== null) {
    const body = JSON.parse(request.body ?? 'null') as Record<string, unknown>;
    expect(body).toEqual(fixture.request.body);
    expect(Object.keys(body)).toEqual(expect.arrayContaining(['model', 'messages', 'stream']));
    if (provider === 'anthropic') {
      expect(body.max_tokens).toBe(ANTHROPIC_MAX_TOKENS);
      expect(body.system).toBe(PLAN_MESSAGES[0]?.content);
      expect(body.messages).toEqual([PLAN_MESSAGES[1]]);
    } else {
      expect(body.messages).toEqual(PLAN_MESSAGES);
    }
  } else {
    expect(request.body).toBeUndefined();
  }
}

describe.each(PROVIDER_IDS)('contrato %s (AC-11.2)', (provider) => {
  const { meta, cases } = readFixtures(provider);

  it('meta.json com provedor, modelo, versão da API, data e origem (AC-11.4)', () => {
    expect(meta.provider).toBe(provider);
    expect(meta.model).toEqual(expect.any(String));
    expect(meta.apiVersion).toEqual(expect.any(String));
    expect(meta.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(['gravado', 'sintético']).toContain(meta.origem);
  });

  it('listModels devolve os ids esperados', async () => {
    const fixture = cases['list-models']!;
    const { adapter, calls } = setup(provider, fixture);
    expect(await adapter.listModels()).toEqual(fixture.expected?.models);
    assertRequest(provider, calls[0]!.request, fixture);
  });

  it('fluxo: ≥ 2 pedaços cuja concatenação é o texto esperado', async () => {
    const fixture = cases['chat-stream']!;
    const { adapter, calls } = setup(provider, fixture);
    const { chunks, error } = await drain(
      adapter.chat(PLAN_MESSAGES, { model: modelOf(fixture), stream: true }),
    );
    expect(error).toBeNull();
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.join('')).toBe(fixture.expected?.text);
    assertRequest(provider, calls[0]!.request, fixture);
  });

  it('stream: false entrega exatamente 1 pedaço com o texto inteiro', async () => {
    const fixture = cases['chat-nostream']!;
    const { adapter, calls } = setup(provider, fixture);
    const { chunks, error } = await drain(
      adapter.chat(PLAN_MESSAGES, { model: modelOf(fixture), stream: false }),
    );
    expect(error).toBeNull();
    expect(chunks).toEqual([fixture.expected?.text]);
    assertRequest(provider, calls[0]!.request, fixture);
  });

  it('fluxo cortado: os pedaços já entregues ficam e depois vem o erro STREAM', async () => {
    const fixture = cases['stream-truncated']!;
    const { adapter } = setup(provider, fixture);
    const { chunks, error } = await drain(
      adapter.chat(PLAN_MESSAGES, { model: modelOf(fixture), stream: true }),
    );
    expect(chunks.join('')).toBe(fixture.expected?.partialText);
    expect(chunks.length).toBeGreaterThan(0);
    expect(error).toBeInstanceOf(AIError);
    expect((error as AIError).code).toBe('STREAM');
    expect((error as AIError).message).toBe('A resposta chegou incompleta.');
  });

  const errorCases = Object.keys(cases).filter(
    (name) => name.startsWith('error-') || name === 'connection-refused',
  );
  it.each(errorCases)('%s vira o erro R-11.3', async (name) => {
    const fixture = cases[name]!;
    const { adapter, calls } = setup(provider, fixture);
    const { chunks, error } = await drain(
      adapter.chat(PLAN_MESSAGES, { model: modelOf(fixture), stream: true }),
    );
    expect(chunks).toEqual([]);
    expect(error).toBeInstanceOf(AIError);
    const aiError = error as AIError;
    if (fixture.expected?.error) expect(aiError.code).toBe(fixture.expected.error);
    if (fixture.expected?.message) expect(aiError.message).toBe(fixture.expected.message);
    if (fixture.expected?.status) expect(aiError.status).toBe(fixture.expected.status);
    if (name === 'error-404') {
      expect(aiError.code).toBe('PROVIDER');
      expect(aiError.message).toMatch(/^Erro do provedor: model '.+' not found$/);
    }
    assertRequest(provider, calls[0]!.request, fixture);
  });

  // AC-11.2 exige 401/403, 429 e 5xx por adaptador (o Ollama sem chave: 404 gravado + recusa).
  it('cobertura mínima de casos', () => {
    const required = [
      'list-models',
      'chat-stream',
      'chat-nostream',
      'stream-truncated',
      'error-429',
      'error-500',
    ];
    required.push(...(provider === 'ollama' ? ['connection-refused', 'error-404'] : ['error-401']));
    expect(Object.keys(cases)).toEqual(expect.arrayContaining(required));
  });
});

describe('cancelamento (AC-11.3)', () => {
  const fixture = readFixtures('ollama').cases['chat-stream']!;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('break depois do 1º pedaço → return() do transporte em ≤ 300 ms e 0 pedaços a mais', async () => {
    const { adapter, calls } = setup('ollama', fixture, { chunkDelayMs: 40 });
    const received: string[] = [];
    let brokeAt = 0;
    for await (const chunk of adapter.chat(PLAN_MESSAGES, { model: 'm', stream: true })) {
      received.push(chunk);
      brokeAt = Date.now();
      break;
    }
    const call = calls[0]!;
    expect(call.cancelledAt).toBeDefined();
    expect(call.cancelledAt! - brokeAt).toBeLessThanOrEqual(300);
    const delivered = call.delivered;
    // O relógio anda 10 intervalos de pedaço: nenhum evento sai depois do cancelamento.
    await vi.advanceTimersByTimeAsync(400);
    expect(call.delivered).toBe(delivered);
    expect(received).toHaveLength(1);
  });

  it('return() com um next() pendente (botão "Parar") encerra sem esperar o transporte', async () => {
    const { adapter, calls } = setup('ollama', fixture, { firstChunkDelayMs: 5_000 });
    const iterator = adapter.chat(PLAN_MESSAGES, { model: 'm' })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    await iterator.return?.();
    // Resolve sem o relógio chegar aos 5 s do primeiro pedaço.
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(calls[0]!.cancelledAt).toBeDefined();
    expect(calls[0]!.delivered).toBe(1); // só o `head`
  });
});

describe('fixtures sem segredo (AC-11.4)', () => {
  const files = readdirSync(FIXTURES, { recursive: true })
    .map((name) => new URL(String(name), FIXTURES))
    .filter((url) => statSync(url).isFile());

  it.each(files.map((url) => [url.pathname.split('/fixtures/')[1], url] as const))(
    '%s: 0 padrões de chave e só content-type de cabeçalho',
    (_name, url) => {
      const text = readFileSync(url, 'utf8');
      expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
      expect(text).not.toMatch(/sk-ant-/);
      expect(text).not.toMatch(/Bearer [A-Za-z0-9]/);
      expect(text).not.toMatch(/"(?:x-api-key|authorization)"\s*:/i);
      const parsed = JSON.parse(text) as { response?: Record<string, unknown> };
      if (parsed.response)
        expect(Object.keys(parsed.response).sort()).toEqual(['chunks', 'contentType', 'status']);
    },
  );
});
