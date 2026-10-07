import { AIError, streamError } from './errors';
import { collect, exchange, parseJson, SseSplitter, type BodyDecoder } from './stream';
import type { AiTransport } from './transport';
import type { AIProvider, Message } from './types';

/**
 * Adaptador Anthropic (R-11.3; `packages/ai/README.md`): Messages `POST /v1/messages` em SSE, com
 * `anthropic-version` fixo e `max_tokens` padrão 2048; mensagens `system` vão para o campo `system`
 * de topo. `GET /v1/models?limit=1000` lista os modelos numa página. A chave (`x-api-key`) é
 * posta pelo transporte nativo.
 */
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_MAX_TOKENS = 2048;

const CONTEXT = { provider: 'anthropic', ollamaUrl: '' } as const;

interface AnthropicEvent {
  type?: string;
  delta?: { type?: string; text?: unknown };
}

function sseDecoder(): BodyDecoder {
  const splitter = new SseSplitter();
  let done = false;
  return {
    push(text) {
      const out: string[] = [];
      for (const { data } of splitter.push(text)) {
        if (done || data === '') continue;
        const event = parseJson('anthropic', data) as AnthropicEvent;
        if (event.type === 'error') throw new AIError('PROVIDER', 'anthropic', 'Erro do provedor');
        if (event.type === 'message_stop') done = true;
        else if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta' &&
          typeof event.delta.text === 'string' &&
          event.delta.text !== ''
        )
          out.push(event.delta.text);
      }
      return out;
    },
    end() {
      if (!done || splitter.pending) throw streamError('anthropic');
      return [];
    },
  };
}

function wholeDecoder(): BodyDecoder {
  let text = '';
  return {
    push(chunk) {
      text += chunk;
      return [];
    },
    end() {
      const body = parseJson('anthropic', text) as {
        content?: Array<{ type?: string; text?: unknown }>;
      };
      if (!Array.isArray(body.content)) throw streamError('anthropic');
      return [
        body.content
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text as string)
          .join(''),
      ];
    },
  };
}

export function createAnthropicProvider(transport: AiTransport): AIProvider {
  return {
    id: 'anthropic',
    async listModels() {
      const text = await collect(
        transport,
        {
          provider: 'anthropic',
          method: 'GET',
          path: '/v1/models?limit=1000',
          headers: { accept: 'application/json', 'anthropic-version': ANTHROPIC_VERSION },
        },
        CONTEXT,
      );
      const body = parseJson('anthropic', text) as { data?: Array<{ id?: unknown }> };
      return (body.data ?? [])
        .map((model) => model.id)
        .filter((id): id is string => typeof id === 'string');
    },
    chat(messages: Message[], opts: { model: string; stream?: boolean }) {
      const stream = opts.stream ?? true;
      const system = messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n\n');
      return exchange(
        transport,
        {
          provider: 'anthropic',
          method: 'POST',
          path: '/v1/messages',
          headers: {
            'content-type': 'application/json',
            accept: stream ? 'text/event-stream' : 'application/json',
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model: opts.model,
            max_tokens: ANTHROPIC_MAX_TOKENS,
            ...(system === '' ? {} : { system }),
            messages: messages
              .filter((message) => message.role !== 'system')
              .map(({ role, content }) => ({ role, content })),
            stream,
          }),
        },
        CONTEXT,
        stream ? sseDecoder : wholeDecoder,
      );
    },
  };
}
