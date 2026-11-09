import { describe, expect, it } from 'vitest';
import {
  AI_LANGUAGES,
  AI_PROMPTS,
  AIError,
  AiTransportError,
  chatTruncated,
  commandMessages,
  createProvider,
  isOpenAIChatModel,
  normalizeOllamaUrl,
  redact,
  REDACTED,
  transportError,
  type ProviderId,
} from '../src';
import { replayTransport } from '../src/testing/replay';

describe('redação (AC-11.7, espelho do Rust)', () => {
  it('troca sk-, sk-ant- e Bearer por [chave redigida]', () => {
    // Texto sintético partido para o gitleaks não confundir com uma chave real.
    const fake = ['sk', 'proj', 'abcd1234wxyz'].join('-');
    expect(redact(`Incorrect API key provided: ${fake}.`)).toBe(
      `Incorrect API key provided: ${REDACTED}.`,
    );
    expect(redact('x sk-ant-api03-AbC_d-9 y')).toBe(`x ${REDACTED} y`);
    expect(redact('Authorization: Bearer abc.def-123 ok')).toBe(`Authorization: ${REDACTED} ok`);
    expect(redact('bearer\tXYZ')).toBe(REDACTED);
  });

  it('não mutila palavras que só contêm o prefixo', () => {
    const text = 'task-list desk-top risk- Bearerless sk- só';
    expect(redact(text)).toBe(text);
  });

  it('AIError redige a própria mensagem', () => {
    const error = new AIError('PROVIDER', 'openai', 'eco sk-ant-api03-zzzz');
    expect(error.message).toBe(`eco ${REDACTED}`);
  });
});

describe('erros do transporte nativo → STR-129', () => {
  const map = (code: string, provider: 'openai' | 'ollama' = 'openai', detail?: object) =>
    transportError(provider, { code, message: 'nativo', detail }, 'http://127.0.0.1:11434');

  it.each([
    [
      'CONNECTION_REFUSED',
      'ollama',
      'OLLAMA_NOT_FOUND',
      'Ollama não encontrado em http://127.0.0.1:11434',
    ],
    ['CONNECTION_REFUSED', 'openai', 'TRANSPORT', 'Sem conexão com OpenAI.'],
    ['NETWORK', 'openai', 'TRANSPORT', 'Sem conexão com OpenAI.'],
    ['TLS', 'openai', 'TRANSPORT', 'Falha na conexão segura com OpenAI.'],
    ['TIMEOUT_IDLE', 'openai', 'TIMEOUT', 'A resposta parou de chegar.'],
    [
      'KEY_MISSING',
      'openai',
      'TRANSPORT',
      'Sem chave para OpenAI. Salve uma em Configurações → IA.',
    ],
    ['HOST_NOT_ALLOWED', 'ollama', 'TRANSPORT', 'Endereço não permitido.'],
    [
      'REDIRECT_NOT_FOLLOWED',
      'openai',
      'TRANSPORT',
      'O provedor redirecionou para outro endereço; a resposta foi recusada.',
    ],
    ['RESPONSE_TOO_LARGE', 'openai', 'TRANSPORT', 'Resposta grande demais.'],
    [
      'LOCAL_LIMIT',
      'openai',
      'TRANSPORT',
      'Muitas solicitações ao mesmo tempo; aguarde uma terminar.',
    ],
    ['BAD_UTF8', 'openai', 'STREAM', 'A resposta chegou incompleta.'],
  ] as const)('%s (%s) → %s', (code, provider, kind, message) => {
    const error = map(code, provider);
    expect(error.code).toBe(kind);
    expect(error.message).toBe(message);
    expect(error.transportCode).toBe(code);
  });

  it('primeiro byte: 60 s na nuvem, 120 s no Ollama (NFR-35)', () => {
    expect(map('TIMEOUT_FIRST_BYTE', 'openai', { seconds: 60 }).message).toBe(
      'O provedor não respondeu em 60 s.',
    );
    expect(map('TIMEOUT_FIRST_BYTE', 'ollama', { seconds: 120 }).message).toBe(
      'O provedor não respondeu em 120 s.',
    );
  });

  it('CANCELLED não tem texto; desconhecido mantém a mensagem nativa redigida', () => {
    expect(map('CANCELLED').message).toBe('');
    const odd = transportError('openai', new AiTransportError('UNKNOWN', 'falha sk-abcdef123'), '');
    expect(odd.message).toBe(`falha ${REDACTED}`);
  });
});

describe('modelos dos comandos (R-11.8, AC-11.12)', () => {
  it('system = modelo fixo; user = a seleção sem mudança', () => {
    const selection = '  Um parágrafo\ncom **markdown**.  ';
    expect(commandMessages('summarize', selection, 'en')).toEqual([
      { role: 'system', content: AI_PROMPTS.summarize },
      { role: 'user', content: selection },
    ]);
  });

  it('Traduzir usa o nome pt-BR do idioma configurado (Q-13: padrão English)', () => {
    expect(commandMessages('translate', 'x', 'en')[0]?.content).toBe(
      'Traduza o texto a seguir para inglês, preservando a formatação markdown. Responda só com a tradução.',
    );
    expect(commandMessages('translate', 'x', 'de')[0]?.content).toContain('para alemão,');
    expect(AI_LANGUAGES.map((l) => l.label)).toEqual([
      'Português (Brasil)',
      'English',
      'Español',
      'Français',
      'Deutsch',
    ]);
  });
});

describe('endereço do Ollama (AC-11.8, metade das configurações)', () => {
  it.each([
    ['http://127.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['http://localhost:11434', 'http://localhost:11434'],
    ['http://[::1]:11434', 'http://[::1]:11434'],
    [' http://LOCALHOST:8080/ ', 'http://localhost:8080'],
  ])('%s → aceito', (input, normalized) => {
    expect(normalizeOllamaUrl(input)).toBe(normalized);
  });

  it.each([
    'http://192.168.0.2:11434',
    'https://127.0.0.1:11434',
    'http://127.0.0.1',
    'http://127.0.0.1:0',
    'http://127.0.0.1:70000',
    'http://127.0.0.1:11434/api',
    'http://user@127.0.0.1:11434',
    'http://localhost.evil.example:11434',
  ])('%s → recusado', (input) => {
    expect(normalizeOllamaUrl(input)).toBeNull();
  });
});

describe('filtro de modelos da OpenAI (README)', () => {
  it.each([
    ['gpt-4o-mini', true],
    ['o3-mini', true],
    ['chatgpt-4o-latest', true],
    ['gpt-4o-realtime-preview', false],
    ['gpt-4o-mini-tts', false],
    ['text-embedding-3-small', false],
    ['whisper-1', false],
    ['dall-e-3', false],
  ])('%s → %s', (id, chat) => {
    expect(isOpenAIChatModel(id)).toBe(chat);
  });
});

/** Lê um `chat()` de corpo 200 sintético e devolve o texto e o fim (`chatTruncated`, r29). */
async function finish(provider: ProviderId, stream: boolean, chunks: string[]) {
  const contentType = stream
    ? provider === 'ollama'
      ? 'application/x-ndjson'
      : 'text/event-stream'
    : 'application/json';
  const transport = replayTransport(() => ({ response: { status: 200, contentType, chunks } }));
  const iterator = createProvider(provider, transport)
    .chat([{ role: 'user', content: 'oi' }], { model: 'm', stream })
    [Symbol.asyncIterator]();
  let text = '';
  for (;;) {
    const step = await iterator.next();
    if (step.done) return { text, truncated: chatTruncated(step.value) };
    text += step.value;
  }
}

const sse = (...events: unknown[]) =>
  events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`);

describe('motivo de parada → truncated (r29, AC-R29-1)', () => {
  it.each([
    ['max_tokens', true],
    ['model_context_window_exceeded', true],
    ['end_turn', false],
    ['stop_sequence', false],
  ])('Anthropic stop_reason %s → %s (com e sem fluxo)', async (reason, cut) => {
    const streamed = await finish(
      'anthropic',
      true,
      sse(
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Olá' } },
        { type: 'message_delta', delta: { stop_reason: reason } },
        { type: 'message_stop' },
      ),
    );
    expect(streamed).toEqual({ text: 'Olá', truncated: cut });
    const whole = await finish('anthropic', false, [
      JSON.stringify({ content: [{ type: 'text', text: 'Olá' }], stop_reason: reason }),
    ]);
    expect(whole).toEqual({ text: 'Olá', truncated: cut });
  });

  it.each([
    ['length', true],
    ['stop', false],
    ['content_filter', false],
  ])('OpenAI finish_reason %s → %s (com e sem fluxo)', async (reason, cut) => {
    const streamed = await finish(
      'openai',
      true,
      sse(
        { choices: [{ delta: { content: 'Olá' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: reason }] },
        // Pedaço de uso no fim (`include_usage`): sem `choices`, não apaga o motivo.
        { choices: [], usage: { completion_tokens: 1 } },
        '[DONE]',
      ),
    );
    expect(streamed).toEqual({ text: 'Olá', truncated: cut });
    const whole = await finish('openai', false, [
      JSON.stringify({ choices: [{ message: { content: 'Olá' }, finish_reason: reason }] }),
    ]);
    expect(whole).toEqual({ text: 'Olá', truncated: cut });
  });

  it.each([
    ['length', true],
    ['stop', false],
  ])('Ollama done_reason %s → %s (com e sem fluxo)', async (reason, cut) => {
    const streamed = await finish('ollama', true, [
      `${JSON.stringify({ message: { content: 'Olá' }, done: false })}\n`,
      `${JSON.stringify({ message: { content: '' }, done: true, done_reason: reason })}\n`,
    ]);
    expect(streamed).toEqual({ text: 'Olá', truncated: cut });
    const whole = await finish('ollama', false, [
      JSON.stringify({ message: { content: 'Olá' }, done: true, done_reason: reason }),
    ]);
    expect(whole).toEqual({ text: 'Olá', truncated: cut });
  });

  it('sem motivo, cancelado ou valor estranho → false', async () => {
    const silent = await finish('ollama', true, [
      `${JSON.stringify({ message: { content: 'Olá' }, done: true })}\n`,
    ]);
    expect(silent).toEqual({ text: 'Olá', truncated: false });
    const transport = replayTransport(() => ({
      response: {
        status: 200,
        contentType: 'application/x-ndjson',
        chunks: [
          `${JSON.stringify({ message: { content: 'a' }, done: true, done_reason: 'length' })}\n`,
        ],
      },
    }));
    const iterator = createProvider('ollama', transport)
      .chat([{ role: 'user', content: 'oi' }], { model: 'm' })
      [Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: 'a' });
    const stopped = await iterator.return!();
    expect(chatTruncated(stopped.value)).toBe(false);
    expect(chatTruncated((await iterator.next()).value)).toBe(false);
    for (const value of [undefined, null, 'truncated', { truncated: 'yes' }, {}])
      expect(chatTruncated(value)).toBe(false);
  });
});
