import { EditorState } from '@codemirror/state';
import { internalCommandsFacet, type InternalCommand as CoreCommand } from '@simplemd/core';
import type { InternalCommand as HostCommand } from '@simplemd/plugin-api/internal/host';
import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import { StatusBarStore } from '../src/app/status-bar';
import {
  createInternalHostContext,
  type InternalContextDeps,
} from '../src/plugins/internal-context';

/** r7 ST — contexto de host por plugin interno com menor privilégio (D-R7-F03; CR-ST-06/10). */
function deps(statusBar = new StatusBarStore()): InternalContextDeps {
  return {
    platform: 'mac',
    statusBar,
    view: () => null,
    options: () => ({ get: <T>() => undefined as T, subscribe: () => () => {} }),
    openExternal: () => {},
    readConfigFile: async (name) => ({ text: `conteúdo de ${name}` }),
    watchConfigFiles: () => () => {},
    languageTool: {} as InternalContextDeps['languageTool'],
  };
}

describe('createInternalHostContext', () => {
  test('Vim recebe só o slot vim; LT só o slot lt com as ações do M2; os demais, nenhum', () => {
    const statusBar = new StatusBarStore();
    const vim = createInternalHostContext('simplemd.vim', deps(statusBar));
    const lt = createInternalHostContext('simplemd.languagetool', deps(statusBar));
    expect(vim.ltStatus).toBeUndefined();
    expect(lt.vimStatus).toBeUndefined();
    vim.vimStatus?.set({ mode: 'insert' });
    lt.ltStatus?.set({ state: 'issues', count: 3 });
    expect(statusBar.getSnapshot()).toMatchObject({
      vim: { mode: 'insert' },
      lt: { state: 'issues', count: 3 },
    });
    const onAction = vi.fn();
    lt.ltStatus?.onAction(onAction);
    statusBar.runLtAction('retry');
    expect(onAction).toHaveBeenCalledWith('retry');
    for (const id of ['simplemd.tasks', 'simplemd.lint', 'simplemd.mermaid']) {
      const ctx = createInternalHostContext(id, deps());
      expect([ctx.vimStatus, ctx.ltStatus]).toEqual([undefined, undefined]);
    }
  });

  test('problems:* só para lint e LT (CR-ST-10)', () => {
    const has = (id: string) => createInternalHostContext(id, deps()).editor.problems !== undefined;
    expect(has('simplemd.lint')).toBe(true);
    expect(has('simplemd.languagetool')).toBe(true);
    expect(has('simplemd.vim')).toBe(false);
    expect(has('simplemd.tasks')).toBe(false);
    expect(has('simplemd.mermaid')).toBe(false);
  });

  test('arquivos: lista fechada por plugin; nome fora da lista → missing sem leitura', async () => {
    const d = deps();
    const read = vi.spyOn(d, 'readConfigFile');
    const lint = createInternalHostContext('simplemd.lint', d);
    expect(await lint.files?.read('.markdownlint.json')).toEqual({
      text: 'conteúdo de .markdownlint.json',
    });
    expect(await lint.files?.read('.simplemd/latex-snippets.json')).toEqual({ error: 'missing' });
    expect(read).toHaveBeenCalledTimes(1);
    expect(createInternalHostContext('simplemd.vim', d).files).toBeUndefined();
  });

  test('palette (D-R7-M05): só com o privilégio; ids fora de "<pluginId>:" lançam', () => {
    const table = { 'simplemd.teste': { palette: true as const } };
    const granted = createInternalHostContext('simplemd.teste', deps(), table);
    const run = () => true;
    const extension = granted.palette?.([
      { id: 'simplemd.teste:mover', title: 'Lista: Mover item para cima', run },
    ]);
    const state = EditorState.create({ extensions: extension ?? [] });
    expect(state.facet(internalCommandsFacet).map((c) => c.title)).toEqual([
      'Lista: Mover item para cima',
    ]);
    expect(() => granted.palette?.([{ id: 'simplemd.outro:x', title: 'X', run }])).toThrow(
      'simplemd.teste: comando de paleta fora do prefixo “simplemd.teste:”: simplemd.outro:x',
    );
    expect(createInternalHostContext('simplemd.teste', deps()).palette).toBeUndefined();
    for (const id of ['simplemd.vim', 'simplemd.lint', 'simplemd.mermaid'])
      expect(createInternalHostContext(id, deps()).palette).toBeUndefined();
  });

  test('palette: id repetido (no lote ou entre chamadas), sufixo vazio e título vazio lançam', () => {
    const table = { 'simplemd.teste': { palette: true as const } };
    const granted = createInternalHostContext('simplemd.teste', deps(), table);
    const run = () => true;
    const a = { id: 'simplemd.teste:a', title: 'A', run };
    expect(() => granted.palette?.([a, a])).toThrow(
      'simplemd.teste: comando de paleta repetido: simplemd.teste:a',
    );
    const fresh = createInternalHostContext('simplemd.teste', deps(), table);
    fresh.palette?.([a]);
    expect(() => fresh.palette?.([a])).toThrow('comando de paleta repetido');
    expect(() => fresh.palette?.([{ id: 'simplemd.teste:', title: 'X', run }])).toThrow(
      'fora do prefixo',
    );
    expect(() => fresh.palette?.([{ id: 'simplemd.teste:b', title: '  ', run }])).toThrow(
      'simplemd.teste: comando de paleta sem título: simplemd.teste:b',
    );
  });

  test('InternalCommand do núcleo e do contexto do host são o mesmo tipo (CR-PAL-03)', () => {
    expectTypeOf<CoreCommand>().toEqualTypeOf<HostCommand>();
  });
});
