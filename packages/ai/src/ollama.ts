import { AIError, streamError } from './errors';
import { collect, exchange, LineSplitter, parseJson, type BodyDecoder } from './stream';
import type { AiTransport } from './transport';
import type { AIProvider, Message } from './types';

/**
 * Adaptador Ollama (R-11.3; `packages/ai/README.md`): `POST /api/chat` em NDJSON, `GET /api/tags`.
 * Sem chave. `think: false` pede a resposta direta aos modelos que "pensam" antes (qwen3.5), para o
 * primeiro texto chegar logo; nos demais o campo é ignorado.
 */
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

/**
 * Endereço do Ollama aceito nas configurações (R-11.5, AC-11.8, STR-127): `http://` + `127.0.0.1`,
 * `localhost` ou `[::1]` + porta explícita; sem usuário, caminho (só `/` final), consulta nem
 * fragmento. Devolve a origem normalizada, ou `null`. O transporte nativo confere de novo.
 */
export function normalizeOllamaUrl(input: string): string | null {
  const match = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})\/?$/i.exec(input.trim());
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65_535) return null;
  return `http://${(match[1] ?? '').toLowerCase()}:${port}`;
}

interface OllamaLine {
  error?: unknown;
  done?: unknown;
  message?: { content?: unknown };
}

function ndjsonDecoder(): BodyDecoder {
  const splitter = new LineSplitter();
  let done = false;
  return {
    push(text) {
      const out: string[] = [];
      for (const line of splitter.push(text)) {
        if (done) continue;
        const event = parseJson('ollama', line) as OllamaLine;
        if (event.error !== undefined) {
          const detail = typeof event.error === 'string' ? `: ${event.error.slice(0, 200)}` : '';
          throw new AIError('PROVIDER', 'ollama', `Erro do provedor${detail}`);
        }
        const content = event.message?.content;
        if (typeof content === 'string' && content !== '') out.push(content);
        if (event.done === true) done = true;
      }
      return out;
    },
    end() {
      if (!done || splitter.pending) throw streamError('ollama');
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
      const body = parseJson('ollama', text) as OllamaLine;
      const content = body.message?.content;
      if (typeof content !== 'string') throw streamError('ollama');
      return [content];
    },
  };
}

export function createOllamaProvider(
  transport: AiTransport,
  options: { baseUrl?: string } = {},
): AIProvider {
  const baseUrl = options.baseUrl ?? DEFAULT_OLLAMA_URL;
  const context = { provider: 'ollama', ollamaUrl: baseUrl } as const;
  return {
    id: 'ollama',
    async listModels() {
      const text = await collect(
        transport,
        {
          provider: 'ollama',
          method: 'GET',
          path: '/api/tags',
          headers: { accept: 'application/json' },
          baseUrl,
        },
        context,
      );
      const body = parseJson('ollama', text) as { models?: Array<{ name?: unknown }> };
      return (body.models ?? [])
        .map((model) => model.name)
        .filter((name): name is string => typeof name === 'string');
    },
    chat(messages: Message[], opts: { model: string; stream?: boolean }) {
      const stream = opts.stream ?? true;
      return exchange(
        transport,
        {
          provider: 'ollama',
          method: 'POST',
          path: '/api/chat',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: opts.model,
            messages: messages.map(({ role, content }) => ({ role, content })),
            stream,
            think: false,
          }),
          baseUrl,
        },
        context,
        stream ? ndjsonDecoder : wholeDecoder,
      );
    },
  };
}
