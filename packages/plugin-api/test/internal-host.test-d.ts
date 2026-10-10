import type { Extension } from '@codemirror/state';
import { describe, expectTypeOf, test } from 'vitest';
import type {
  InternalHostContext,
  LtMenuAction,
  ProblemsCommands,
} from '../src/internal/host';

declare const host: InternalHostContext;

// CR-ST-06: cada dono escreve no seu slot sem estreitar uma união (S4 Vim, S8 LanguageTool).
describe('InternalHostContext: slots de status e privilégios', () => {
  test('vimStatus.set({ mode }) e ltStatus.set({ state }) compilam direto', () => {
    host.vimStatus?.set({ mode: 'normal' });
    host.vimStatus?.clear();
    host.ltStatus?.set({ state: 'issues', count: 2 });
    host.ltStatus?.onAction((action) => expectTypeOf(action).toEqualTypeOf<LtMenuAction>());
    // @ts-expect-error o slot do Vim não aceita o estado do LT
    host.vimStatus?.set({ state: 'checking' });
    // @ts-expect-error o slot do LT não aceita o modo do Vim
    host.ltStatus?.set({ mode: 'normal' });
  });

  test('problems é privilégio: opcional no contexto (CR-ST-10)', () => {
    expectTypeOf(host.editor.problems).toEqualTypeOf<
      ((commands: ProblemsCommands) => Extension) | undefined
    >();
  });
});
