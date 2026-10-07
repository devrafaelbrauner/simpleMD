import { Channel, invoke } from '@tauri-apps/api/core';
import {
  AiTransportError,
  type AiHttpRequest,
  type AiTransport,
  type AiTransportEvent,
} from '@simplemd/ai';
import type { AiPlatform } from '../types';

/** Evento do Rust (`ai::transport::AiEvent`): os três do contrato puro, mais `error`. */
type NativeEvent =
  | AiTransportEvent
  | {
      readonly kind: 'error';
      readonly code: string;
      readonly message: string;
      readonly detail?: { seconds?: number };
    };

/**
 * Transporte de produção (arch-backend r2 §1.7.1): `ai_send(req, onEvent: Channel)` devolve o id do
 * pedido; os eventos chegam pelo canal. `return()` no iterador chama `ai_cancel(id)` na hora — também
 * com um `next()` pendente (o botão "Parar") — e nada mais sai depois disso. A chave nunca passa por
 * aqui: o Rust lê do keychain e põe o cabeçalho.
 */
function open(request: AiHttpRequest): AsyncIterator<AiTransportEvent> {
  const queue: AiTransportEvent[] = [];
  let failure: AiTransportError | null = null;
  let finished = false;
  let closed = false;
  let id: number | null = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  const channel = new Channel<NativeEvent>();
  channel.onmessage = (event) => {
    if (closed || finished) return;
    if (event.kind === 'error') {
      failure = AiTransportError.from(event);
      finished = true;
    } else {
      queue.push(event);
      if (event.kind === 'end') finished = true;
    }
    notify();
  };
  const cancel = () => {
    if (id !== null) void invoke('ai_cancel', { id }).catch(() => undefined);
  };
  invoke<number>('ai_send', { req: request, onEvent: channel }).then(
    (requestId) => {
      id = requestId;
      // Cancelado antes de o id chegar: cancela agora.
      if (closed) cancel();
    },
    (error: unknown) => {
      if (closed) return;
      failure = AiTransportError.from(error);
      finished = true;
      notify();
    },
  );
  return {
    async next(): Promise<IteratorResult<AiTransportEvent>> {
      for (;;) {
        if (closed) return { done: true, value: undefined };
        const event = queue.shift();
        if (event !== undefined) return { done: false, value: event };
        if (failure !== null) {
          closed = true;
          throw failure;
        }
        if (finished) return { done: true, value: undefined };
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
    async return(): Promise<IteratorResult<AiTransportEvent>> {
      if (!closed) {
        closed = true;
        queue.length = 0;
        if (!finished) cancel();
        notify();
      }
      return { done: true, value: undefined };
    },
  };
}

export function createTauriAi(): AiPlatform {
  const transport: AiTransport = {
    send: (request) => ({ [Symbol.asyncIterator]: () => open(request) }),
  };
  return {
    transport,
    // O valor sai do webview só aqui, direto para o Rust (que o põe no keychain e o descarta).
    setKey: (provider, value) => invoke('set_key', { provider, value }),
    hasKey: (provider) => invoke<boolean>('has_key', { provider }),
    deleteKey: (provider) => invoke('delete_key', { provider }),
  };
}
