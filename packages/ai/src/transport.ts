import type { ProviderId } from './types';

/**
 * Contrato puro do transporte (arch-backend r2 §1.7.1). `packages/ai` não tem rede própria
 * (R-11.2, AC-11.19): o app injeta um transporte — no Tauri, o comando nativo `ai_send` (que põe a
 * autenticação e aplica a lista de hosts); no harness e nos testes, o de replay de fixtures.
 */
export interface AiHttpRequest {
  readonly provider: ProviderId;
  readonly method: 'GET' | 'POST';
  /** Caminho exato (com a consulta, quando houver) da lista do transporte nativo. */
  readonly path: string;
  /** Só `content-type`, `accept` e `anthropic-version`; autenticação NUNCA vem daqui. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Só Ollama: origem de loopback (`http://127.0.0.1:11434`). */
  readonly baseUrl?: string;
}

export type AiTransportEvent =
  | { readonly kind: 'head'; readonly status: number; readonly contentType: string | null }
  | { readonly kind: 'chunk'; readonly text: string }
  | { readonly kind: 'end' };

/** `return()` no iterador = cancelar o pedido (`ai_cancel`), mesmo com um `next()` pendente. */
export interface AiTransport {
  send(request: AiHttpRequest): AsyncIterable<AiTransportEvent>;
}

/** Códigos do transporte nativo (arch-backend r2 §1.10). */
export type AiTransportErrorCode =
  | 'HOST_NOT_ALLOWED'
  | 'PATH_NOT_ALLOWED'
  | 'HEADER_NOT_ALLOWED'
  | 'BODY_TOO_LARGE'
  | 'LOCAL_LIMIT'
  | 'KEY_MISSING'
  | 'CONNECTION_REFUSED'
  | 'TLS'
  | 'NETWORK'
  | 'TIMEOUT_FIRST_BYTE'
  | 'TIMEOUT_IDLE'
  | 'REDIRECT_NOT_FOLLOWED'
  | 'RESPONSE_TOO_LARGE'
  | 'BAD_UTF8'
  | 'CANCELLED'
  | 'KEYCHAIN_DENIED'
  | 'KEYCHAIN_UNAVAILABLE'
  | 'UNKNOWN';

const CODES: Record<Exclude<AiTransportErrorCode, 'UNKNOWN'>, true> = {
  HOST_NOT_ALLOWED: true,
  PATH_NOT_ALLOWED: true,
  HEADER_NOT_ALLOWED: true,
  BODY_TOO_LARGE: true,
  LOCAL_LIMIT: true,
  KEY_MISSING: true,
  CONNECTION_REFUSED: true,
  TLS: true,
  NETWORK: true,
  TIMEOUT_FIRST_BYTE: true,
  TIMEOUT_IDLE: true,
  REDIRECT_NOT_FOLLOWED: true,
  RESPONSE_TOO_LARGE: true,
  BAD_UTF8: true,
  CANCELLED: true,
  KEYCHAIN_DENIED: true,
  KEYCHAIN_UNAVAILABLE: true,
};
const isCode = (code: string): code is AiTransportErrorCode => Object.hasOwn(CODES, code);

export class AiTransportError extends Error {
  readonly code: AiTransportErrorCode;
  readonly detail?: { readonly seconds?: number };

  constructor(code: AiTransportErrorCode, message: string, detail?: { seconds?: number }) {
    super(message);
    this.name = 'AiTransportError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }

  /** Erro serializado do Rust (`{ code, message, detail? }`) ou qualquer outra coisa. */
  static from(error: unknown): AiTransportError {
    if (error instanceof AiTransportError) return error;
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = String(error.code);
      const message = 'message' in error ? String(error.message) : code;
      const detail =
        'detail' in error && typeof error.detail === 'object' && error.detail !== null
          ? (error.detail as { seconds?: number })
          : undefined;
      return new AiTransportError(isCode(code) ? code : 'UNKNOWN', message, detail);
    }
    return new AiTransportError('UNKNOWN', 'Falha no transporte de IA.');
  }
}
