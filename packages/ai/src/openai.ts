import { AIError, streamError } from './errors';
import { collect, exchange, parseJson, SseSplitter, type BodyDecoder } from './stream';
import type { AiTransport } from './transport';
import type { AIProvider, Message } from './types';

/**
 * Adaptador OpenAI (R-11.3; `packages/ai/README.md`): Chat Completions `POST /v1/chat/completions`
 * em SSE, `GET /v1/models` filtrado por prefixo. A chave nunca passa por aqui: o transporte nativo
 * põe `Authorization` (arch-backend r2 §1.7.2).
 */
export const OPENAI_CHAT_PREFIXES = ['gpt-', 'o1', 'o3', 'o4', 'chatgpt-'] as const;
export const OPENAI_EXCLUDED = [
  '-audio',
  '-realtime',
  '-transcribe',
  '-tts',
  '-search',
  '-image',
  'embedding',
  'moderation',
  'dall-e',
  'whisper',
] as const;

/** Regra documentada: id com um prefixo de chat e sem nenhum trecho excluído. */
export const isOpenAIChatModel = (id: string) =>
  OPENAI_CHAT_PREFIXES.some((prefix) => id.startsWith(prefix)) &&
  !OPENAI_EXCLUDED.some((part) => id.includes(part));

const CONTEXT = { provider: 'openai', ollamaUrl: '' } as const;

function sseDecoder(): BodyDecoder {
  const splitter = new SseSplitter();
  let done = false;
  return {
    push(text) {
      const out: string[] = [];
      for (const { data } of splitter.push(text)) {
        if (done) continue;
        if (data === '[DONE]') {
          done = true;
          continue;
        }
        const event = parseJson('openai', data) as {
          error?: { message?: string };
          choices?: Array<{ delta?: { content?: unknown } }>;
        };
        if (event.error) throw new AIError('PROVIDER', 'openai', 'Erro do provedor');
        const content = event.choices?.[0]?.delta?.content;
        if (typeof content === 'string' && content !== '') out.push(content);
      }
      return out;
    },
    end() {
      if (!done || splitter.pending) throw streamError('openai');
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
      const body = parseJson('openai', text) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw streamError('openai');
      return [content];
    },
  };
}

export function createOpenAIProvider(transport: AiTransport): AIProvider {
  return {
    id: 'openai',
    async listModels() {
      const text = await collect(
        transport,
        {
          provider: 'openai',
          method: 'GET',
          path: '/v1/models',
          headers: { accept: 'application/json' },
        },
        CONTEXT,
      );
      const body = parseJson('openai', text) as { data?: Array<{ id?: unknown }> };
      return (body.data ?? [])
        .map((model) => model.id)
        .filter((id): id is string => typeof id === 'string' && isOpenAIChatModel(id))
        .sort();
    },
    chat(messages: Message[], opts: { model: string; stream?: boolean }) {
      const stream = opts.stream ?? true;
      return exchange(
        transport,
        {
          provider: 'openai',
          method: 'POST',
          path: '/v1/chat/completions',
          headers: {
            'content-type': 'application/json',
            accept: stream ? 'text/event-stream' : 'application/json',
          },
          body: JSON.stringify({
            model: opts.model,
            messages: messages.map(({ role, content }) => ({ role, content })),
            stream,
          }),
        },
        CONTEXT,
        stream ? sseDecoder : wholeDecoder,
      );
    },
  };
}
