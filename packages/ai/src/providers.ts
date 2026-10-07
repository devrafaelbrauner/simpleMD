import { createAnthropicProvider } from './anthropic';
import { createOllamaProvider } from './ollama';
import { createOpenAIProvider } from './openai';
import type { AiTransport } from './transport';
import type { AIProvider, ProviderId } from './types';

/** O adaptador do provedor escolhido, sobre o transporte injetado. */
export function createProvider(
  id: ProviderId,
  transport: AiTransport,
  options: { ollamaUrl?: string } = {},
): AIProvider {
  if (id === 'openai') return createOpenAIProvider(transport);
  if (id === 'anthropic') return createAnthropicProvider(transport);
  return createOllamaProvider(
    transport,
    options.ollamaUrl === undefined ? {} : { baseUrl: options.ollamaUrl },
  );
}
