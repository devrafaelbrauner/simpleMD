import { redact } from './redact';
import { AiTransportError } from './transport';
import { PROVIDER_NAMES, type ProviderId } from './types';

/** Erro de IA mostrado ao usuário (arch-backend r2 §1.10; textos STR-129, já redigidos). */
export type AIErrorCode =
  'AUTH' | 'RATE_LIMIT' | 'PROVIDER' | 'OLLAMA_NOT_FOUND' | 'TIMEOUT' | 'STREAM' | 'TRANSPORT';

export class AIError extends Error {
  readonly code: AIErrorCode;
  readonly provider: ProviderId;
  readonly status?: number;
  /** Código nativo de origem (`CANCELLED` não é mostrado ao usuário). */
  readonly transportCode?: string;

  constructor(
    code: AIErrorCode,
    provider: ProviderId,
    message: string,
    extra: { status?: number; transportCode?: string } = {},
  ) {
    super(redact(message));
    this.name = 'AIError';
    this.code = code;
    this.provider = provider;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.transportCode !== undefined) this.transportCode = extra.transportCode;
  }
}

/** Fluxo malformado ou cortado: levantado DEPOIS dos pedaços já entregues (R-11.3). */
export const streamError = (provider: ProviderId) =>
  new AIError('STREAM', provider, 'A resposta chegou incompleta.');

/** Mensagem do provedor num corpo de erro (OpenAI/Anthropic `error.message`, Ollama `error`). */
function providerMessage(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || !('error' in parsed)) return null;
    const { error } = parsed;
    if (typeof error === 'string') return error;
    if (typeof error === 'object' && error !== null && 'message' in error)
      return String(error.message);
  } catch {
    // corpo não-JSON: sem detalhe
  }
  return null;
}

/** Resposta HTTP não 2xx → erro STR-129 (401/403, 429, 5xx; outros 4xx com o texto redigido). */
export function httpError(provider: ProviderId, status: number, body: string): AIError {
  const name = PROVIDER_NAMES[provider];
  if (status === 401 || status === 403)
    return new AIError('AUTH', provider, `Chave inválida ou sem permissão (${name})`, { status });
  if (status === 429)
    return new AIError('RATE_LIMIT', provider, `Limite de uso atingido (${name})`, { status });
  if (status >= 500) return new AIError('PROVIDER', provider, 'Erro do provedor', { status });
  const detail = providerMessage(body)?.slice(0, 200);
  return new AIError(
    'PROVIDER',
    provider,
    detail ? `Erro do provedor: ${detail}` : `Erro do provedor (HTTP ${status})`,
    { status },
  );
}

/** Erro do transporte nativo → erro STR-129 (arch-ux STR-129; códigos de arch-backend §1.10). */
export function transportError(provider: ProviderId, error: unknown, ollamaUrl: string): AIError {
  if (error instanceof AIError) return error;
  const native = AiTransportError.from(error);
  const name = PROVIDER_NAMES[provider];
  const code = native.code;
  const make = (kind: AIErrorCode, message: string) =>
    new AIError(kind, provider, message, { transportCode: code });
  switch (code) {
    case 'CONNECTION_REFUSED':
      return provider === 'ollama'
        ? make('OLLAMA_NOT_FOUND', `Ollama não encontrado em ${ollamaUrl}`)
        : make('TRANSPORT', `Sem conexão com ${name}.`);
    case 'NETWORK':
      return make('TRANSPORT', `Sem conexão com ${name}.`);
    case 'TLS':
      return make('TRANSPORT', `Falha na conexão segura com ${name}.`);
    case 'TIMEOUT_FIRST_BYTE':
      return make(
        'TIMEOUT',
        `O provedor não respondeu em ${native.detail?.seconds ?? (provider === 'ollama' ? 120 : 60)} s.`,
      );
    case 'TIMEOUT_IDLE':
      return make('TIMEOUT', 'A resposta parou de chegar.');
    case 'KEY_MISSING':
      return make('TRANSPORT', `Sem chave para ${name}. Salve uma em Configurações → IA.`);
    case 'HOST_NOT_ALLOWED':
      return make('TRANSPORT', 'Endereço não permitido.');
    case 'REDIRECT_NOT_FOLLOWED':
      return make(
        'TRANSPORT',
        'O provedor redirecionou para outro endereço; a resposta foi recusada.',
      );
    case 'RESPONSE_TOO_LARGE':
      return make('TRANSPORT', 'Resposta grande demais.');
    case 'LOCAL_LIMIT':
      return make('TRANSPORT', 'Muitas solicitações ao mesmo tempo; aguarde uma terminar.');
    case 'BAD_UTF8':
      return make('STREAM', 'A resposta chegou incompleta.');
    case 'CANCELLED':
      return make('TRANSPORT', '');
    default:
      return make('TRANSPORT', native.message);
  }
}
