import { describe, expectTypeOf, test } from 'vitest';
import {
  createAnthropicProvider,
  createOllamaProvider,
  createOpenAIProvider,
  type AIProvider,
  type Message,
} from '../src';

// AC-11.1: `AIProvider` é exatamente PLANO §4.4 e os três adaptadores o satisfazem.
describe('AIProvider (AC-11.1)', () => {
  test('membros e assinaturas de §4.4', () => {
    expectTypeOf<keyof AIProvider>().toEqualTypeOf<'id' | 'listModels' | 'chat'>();
    expectTypeOf<AIProvider['id']>().toEqualTypeOf<'openai' | 'anthropic' | 'ollama'>();
    expectTypeOf<AIProvider['listModels']>().toEqualTypeOf<() => Promise<string[]>>();
    expectTypeOf<AIProvider['chat']>().toEqualTypeOf<
      (messages: Message[], opts: { model: string; stream?: boolean }) => AsyncIterable<string>
    >();
  });

  test('Message (D-7)', () => {
    expectTypeOf<Message>().toEqualTypeOf<{
      role: 'system' | 'user' | 'assistant';
      content: string;
    }>();
  });

  test('os 3 adaptadores satisfazem a interface', () => {
    expectTypeOf(createOpenAIProvider).returns.toEqualTypeOf<AIProvider>();
    expectTypeOf(createAnthropicProvider).returns.toEqualTypeOf<AIProvider>();
    expectTypeOf(createOllamaProvider).returns.toEqualTypeOf<AIProvider>();
  });
});
