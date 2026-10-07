import { AIError, httpError, streamError, transportError } from './errors';
import type { AiHttpRequest, AiTransport, AiTransportEvent } from './transport';
import type { ProviderId } from './types';

/**
 * Decodificador do corpo 2xx: recebe texto e devolve os pedaços de resposta a entregar; `end()`
 * fecha (e lança `STREAM` se o fluxo ficou cortado). Pode lançar `AIError`.
 */
export interface BodyDecoder {
  push(text: string): string[];
  end(): string[];
}

export interface ExchangeContext {
  readonly provider: ProviderId;
  /** Endereço do Ollama mostrado em "Ollama não encontrado em <endereço>". */
  readonly ollamaUrl: string;
}

/**
 * Faz o pedido e entrega o texto decodificado como `AsyncIterable<string>`. O iterador é escrito à
 * mão (não um gerador) para que `return()` cancele na hora, mesmo com um `next()` pendente
 * (AC-11.3): ele chama o `return()` do transporte, que aborta o pedido nativo, e o `next()`
 * pendente termina sem entregar mais nada.
 */
export function exchange(
  transport: AiTransport,
  request: AiHttpRequest,
  context: ExchangeContext,
  decoder: () => BodyDecoder,
): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      const source = transport.send(request)[Symbol.asyncIterator]();
      const body = decoder();
      const ready: string[] = [];
      let open = true;
      let status = 0;
      let errorBody = '';
      const close = () => {
        if (!open) return;
        open = false;
        void source.return?.();
      };
      const handle = (event: AiTransportEvent): boolean => {
        if (event.kind === 'head') {
          status = event.status;
          return true;
        }
        const failed = status < 200 || status >= 300;
        if (event.kind === 'chunk') {
          if (failed) errorBody += event.text;
          else ready.push(...body.push(event.text));
          return true;
        }
        open = false;
        if (failed) throw httpError(context.provider, status, errorBody);
        ready.push(...body.end());
        return false;
      };
      return {
        async next(): Promise<IteratorResult<string>> {
          for (;;) {
            const value = ready.shift();
            if (value !== undefined) return { done: false, value };
            if (!open) return { done: true, value: undefined };
            let result: IteratorResult<AiTransportEvent>;
            try {
              result = await source.next();
            } catch (error) {
              const wasOpen = open;
              open = false;
              if (!wasOpen) return { done: true, value: undefined };
              throw transportError(context.provider, error, context.ollamaUrl);
            }
            // Cancelado enquanto esperava: nada mais sai.
            if (!open) return { done: true, value: undefined };
            try {
              if (result.done) {
                // O transporte terminou sem `end`: fluxo cortado.
                open = false;
                throw status >= 200 && status < 300
                  ? streamError(context.provider)
                  : httpError(context.provider, status, errorBody);
              }
              handle(result.value);
            } catch (error) {
              close();
              ready.length = 0;
              throw error instanceof AIError
                ? error
                : transportError(context.provider, error, context.ollamaUrl);
            }
          }
        },
        async return(): Promise<IteratorResult<string>> {
          ready.length = 0;
          close();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

/** Junta tudo e entrega como texto único (listar modelos, `stream: false`). */
export async function collect(
  transport: AiTransport,
  request: AiHttpRequest,
  context: ExchangeContext,
): Promise<string> {
  let text = '';
  for await (const part of exchange(transport, request, context, () => ({
    push: (chunk) => [chunk],
    end: () => [],
  })))
    text += part;
  return text;
}

/** JSON de uma resposta; inválido = `STREAM` (a resposta chegou incompleta ou malformada). */
export function parseJson(provider: ProviderId, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw streamError(provider);
  }
}

/**
 * Eventos SSE (`text/event-stream`): divide em eventos por linha em branco e junta as linhas
 * `data:` de cada um. `flush()` devolve o que sobrou sem a linha em branco final.
 */
export class SseSplitter {
  #buffer = '';

  push(text: string): Array<{ event: string | null; data: string }> {
    this.#buffer += text.replace(/\r\n?/g, '\n');
    const events: Array<{ event: string | null; data: string }> = [];
    for (;;) {
      const end = this.#buffer.indexOf('\n\n');
      if (end === -1) break;
      const block = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 2);
      let event: string | null = null;
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length > 0 || event !== null) events.push({ event, data: data.join('\n') });
    }
    return events;
  }

  /** Há um evento começado e não terminado? */
  get pending(): boolean {
    return this.#buffer.trim() !== '';
  }
}

/** Linhas NDJSON: devolve as linhas completas; `pending` diz se sobrou uma linha partida. */
export class LineSplitter {
  #buffer = '';

  push(text: string): string[] {
    this.#buffer += text;
    const lines = this.#buffer.split('\n');
    this.#buffer = lines.pop() ?? '';
    return lines.map((line) => line.trim()).filter((line) => line !== '');
  }

  get pending(): boolean {
    return this.#buffer.trim() !== '';
  }
}
