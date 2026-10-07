import { describe, expect, it } from 'vitest';
import {
  AI_LANGUAGES,
  AI_PROMPTS,
  AIError,
  AiTransportError,
  commandMessages,
  isOpenAIChatModel,
  normalizeOllamaUrl,
  redact,
  REDACTED,
  transportError,
} from '../src';

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
