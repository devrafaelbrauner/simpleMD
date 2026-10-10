import { EditorState, type Extension } from '@codemirror/state';
import { internalCommandsFacet } from '@simplemd/core';
import type { PluginAPI } from '@simplemd/plugin-api';
import { describe, expect, test, vi } from 'vitest';
import { StatusBarStore } from '../src/app/status-bar';
import {
  createInternalHostContext,
  type InternalContextDeps,
} from '../src/plugins/internal-context';
import type { InternalAppServices } from '../src/plugins/internal/define';
import latexSnippets from '../src/plugins/internal/latex-snippets';

/** r7 S6 — registro do `simplemd.latex-snippets` (descritor, opções, privilégios, paleta). */
function deps(read: InternalContextDeps['readConfigFile']): InternalContextDeps {
  return {
    platform: 'mac',
    statusBar: new StatusBarStore(),
    view: () => null,
    options: () => ({ get: <T>() => undefined as T, subscribe: () => () => {} }),
    openExternal: () => {},
    readConfigFile: read,
    watchConfigFiles: () => () => {},
    languageTool: {} as InternalContextDeps['languageTool'],
  };
}

describe('simplemd.latex-snippets (registro)', () => {
  test('desligado por padrão, ordem 70, 4 interruptores ligados + info (arch-ux §4)', () => {
    expect(latexSnippets).toMatchObject({
      id: 'simplemd.latex-snippets',
      name: 'Snippets LaTeX',
      defaultEnabled: false,
      order: 70,
    });
    expect(latexSnippets.options?.map((o) => [o.key, o.kind, o.label, o.default])).toEqual([
      ['autofraction', 'boolean', 'Fração automática', true],
      ['matrixShortcuts', 'boolean', 'Atalhos de matriz', true],
      ['tabout', 'boolean', 'Sair do par com Tab (só com a Tecla Tab no editor)', true],
      ['autoEnlargeBrackets', 'boolean', 'Ampliar delimitadores', true],
      ['userSnippets', 'info', 'Snippets desta pasta', undefined],
    ]);
  });

  test('info "Snippets desta pasta" lê só .simplemd/latex-snippets.json', async () => {
    const info = latexSnippets.options?.find((o) => o.kind === 'info')?.info;
    const readFile = vi.fn(async () => ({
      text: JSON.stringify([
        { trigger: 'qq', replacement: '\\quad', options: 'mA' },
        { trigger: 'x', replacement: 'y', options: 'c' },
      ]),
    }));
    expect(await info?.({ values: {}, readFile })).toBe(
      '1 snippet de .simplemd/latex-snippets.json · 1 ignorado',
    );
    expect(readFile).toHaveBeenCalledWith('.simplemd/latex-snippets.json');
    expect(await info?.({ values: {}, readFile: async () => null })).toBe(
      'Nenhum arquivo .simplemd/latex-snippets.json',
    );
  });

  test('load: contexto de produção com files + palette; comandos com o título exato (STR-172)', async () => {
    const read = vi.fn(async () => null);
    const host = createInternalHostContext('simplemd.latex-snippets', deps(read));
    expect(host.files).toBeDefined();
    expect(host.palette).toBeDefined();
    expect(
      host.vimStatus ?? host.ltStatus ?? host.languageTool ?? host.editor.problems,
    ).toBeUndefined();
    const module = await latexSnippets.load({
      pluginId: 'simplemd.latex-snippets',
      host,
      services: {} as InternalAppServices,
    });
    const extensions: Extension[] = [];
    const api = {
      registerEditorExtension: (ext: { source?: Extension }) =>
        ext.source && extensions.push(ext.source),
      ui: { notify: () => {} },
    } as unknown as PluginAPI;
    module.default(api);
    const commands = EditorState.create({ extensions }).facet(internalCommandsFacet);
    expect(commands.map((c) => [c.id, c.title, c.hotkey])).toEqual([
      ['simplemd.latex-snippets:expand', 'Expandir snippet LaTeX', 'Mod-Shift-e'],
      [
        'simplemd.latex-snippets:next-field',
        'LaTeX: Próximo campo do snippet',
        'Mod-Alt-ArrowRight',
      ],
      [
        'simplemd.latex-snippets:prev-field',
        'LaTeX: Campo anterior do snippet',
        'Mod-Alt-ArrowLeft',
      ],
    ]);
    await vi.waitFor(() => expect(read).toHaveBeenCalledWith('.simplemd/latex-snippets.json'));
  });
});
