// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  createMarkdownExtensions,
  simpleTaskSemantics,
  taskToggleFacet,
  toggleTaskCommand,
} from '@simplemd/core';
import type { PluginAPI } from '@simplemd/plugin-api';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusBarStore } from '../src/app/status-bar';
import { HOST_MODULE_NAMESPACES } from '../src/plugins/host-modules';
import {
  createInternalHostContext,
  type InternalContextDeps,
} from '../src/plugins/internal-context';
import type { InternalAppServices } from '../src/plugins/internal/index';
import tasksDescriptor from '../src/plugins/internal/tasks';
import { setup } from './helpers';

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.innerHTML = '';
});

function deps(options: Record<string, unknown> = {}): InternalContextDeps {
  return {
    platform: 'mac',
    statusBar: new StatusBarStore(),
    view: () => null,
    options: () => ({ get: <T>(key: string) => options[key] as T, subscribe: () => () => {} }),
    openExternal: () => {},
    readConfigFile: async () => null,
    watchConfigFiles: () => () => {},
    languageTool: {} as InternalContextDeps['languageTool'],
  };
}

/** API que só registra as extensões (o plugin não toca mais nada). */
function recordingApi(): { api: PluginAPI; sources: Extension[]; touched: string[] } {
  const sources: Extension[] = [];
  const touched: string[] = [];
  const api = new Proxy({} as PluginAPI, {
    get(_target, key) {
      touched.push(String(key));
      return (ext: { source?: Extension }) => {
        if (ext.source) sources.push(ext.source);
      };
    },
  });
  return { api, sources, touched };
}

async function activate(options: Record<string, unknown> = {}) {
  const h = await setup({ 'a.md': '# A\n' });
  const services = { store: h.app.store } as unknown as InternalAppServices;
  const host = createInternalHostContext('simplemd.tasks', deps(options));
  const module = await tasksDescriptor.load({ pluginId: 'simplemd.tasks', host, services });
  const recorded = recordingApi();
  module.default(recorded.api);
  return { h, ...recorded };
}

function mount(doc: string, extensions: Extension[]): EditorView {
  const parent = document.body.appendChild(document.createElement('div'));
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [createMarkdownExtensions(), ...extensions] }),
  });
  views.push(view);
  return view;
}

describe('registro do simplemd.tasks (I-9; D-R7-P01, arch-ux §3.3.1)', () => {
  it('descritor: ligado por padrão, ordem 40, opção "Registrar data de conclusão" (padrão ligada)', () => {
    expect(tasksDescriptor).toMatchObject({
      id: 'simplemd.tasks',
      name: 'Tarefas e consultas',
      defaultEnabled: true,
      order: 40,
      options: [
        { key: 'recordDoneDate', kind: 'boolean', label: 'Registrar data de conclusão', default: true },
      ],
    });
  });
});

describe('AC-I9.6 — plugin ligado: Mod-L/caixa com a semântica de R-I9.7 no editor', () => {
  it('a extensão troca a semântica simples pela de conclusão (✅); só registerEditorExtension', async () => {
    const { sources, touched } = await activate();
    expect(touched).toEqual(['registerEditorExtension']);
    const view = mount('- [ ] a\n', sources);
    expect(view.state.facet(taskToggleFacet)).not.toBe(simpleTaskSemantics);
    toggleTaskCommand(view);
    expect(view.state.doc.line(1).text).toMatch(/^- \[x\] a ✅ \d{4}-\d{2}-\d{2}$/);
  });

  it('opção desligada → só o caractere muda', async () => {
    const { sources } = await activate({ recordDoneDate: false });
    const view = mount('- [ ] a\n', sources);
    toggleTaskCommand(view);
    expect(view.state.doc.line(1).text).toBe('- [x] a');
  });

  it('regra de repetição fora do subconjunto → aviso STR-145 com a regra', async () => {
    const { h, sources } = await activate();
    const view = mount('- [ ] a 🔁 every 3rd tuesday\n', sources);
    toggleTaskCommand(view);
    expect(h.app.store.getState().notices.at(-1)).toMatchObject({
      notice: 'query',
      level: 'warn',
      text: 'Regra de repetição não suportada: “every 3rd tuesday”. A tarefa só foi marcada.',
    });
  });

  it('plugin desligado (sem a extensão) → semântica simples (R-I1.3)', () => {
    const view = mount('- [ ] a\n', []);
    toggleTaskCommand(view);
    expect(view.state.doc.line(1).text).toBe('- [x] a');
  });
});

describe('AC-I9.1 — o privilégio de tarefas não alcança outros plugins nem os módulos do host', () => {
  it('nenhum contexto montado pelo host traz taskSemantics (só o registro do tasks o compõe)', () => {
    for (const id of [
      'simplemd.tasks',
      'simplemd.mermaid',
      'simplemd.vim',
      'simplemd.lint',
      'simplemd.languagetool',
      'externo.qualquer',
    ])
      expect(createInternalHostContext(id, deps()).editor.taskSemantics).toBeUndefined();
  });

  it('módulos do host = só os 4 do CodeMirror; nada do catálogo em window depois de ativar', async () => {
    expect(Object.keys(HOST_MODULE_NAMESPACES).sort()).toEqual([
      '@codemirror/autocomplete',
      '@codemirror/language',
      '@codemirror/state',
      '@codemirror/view',
    ]);
    await activate();
    const leaked = Object.keys(window).filter((key) => {
      const value = (window as unknown as Record<string, unknown>)[key];
      return (
        typeof value === 'object' &&
        value !== null &&
        ['editTask', 'toggleTask', 'getSnapshot'].every(
          (m) => typeof (value as Record<string, unknown>)[m] === 'function',
        )
      );
    });
    expect(leaked).toEqual([]);
  });
});
