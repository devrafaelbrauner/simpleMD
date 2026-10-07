/**
 * Interface de provedor de IA — exatamente PLANO §4.4 (R-11.1, AC-11.1); `Message` por D-7.
 * Cancelar = protocolo do iterador: `break`/`return()` no `for await` aborta o pedido. Nenhum
 * membro a mais.
 */
export interface AIProvider {
  id: 'openai' | 'anthropic' | 'ollama';
  listModels(): Promise<string[]>;
  chat(messages: Message[], opts: { model: string; stream?: boolean }): AsyncIterable<string>;
}

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type ProviderId = AIProvider['id'];

export const PROVIDER_IDS: readonly ProviderId[] = ['openai', 'anthropic', 'ollama'];

/** Nome visível de cada provedor (mensagens STR-129, cabeçalhos do chat e do cartão). */
export const PROVIDER_NAMES: Readonly<Record<ProviderId, string>> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  ollama: 'Ollama',
};

export const isProviderId = (value: unknown): value is ProviderId =>
  value === 'openai' || value === 'anthropic' || value === 'ollama';
