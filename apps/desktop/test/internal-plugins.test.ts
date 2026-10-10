// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EditorView } from '@codemirror/view';
import type { PluginAPI } from '@simplemd/plugin-api';
import type { ModuleEvaluator, PluginRowView } from '@simplemd/plugin-api/runtime';
import * as calcPlugin from '@simplemd/plugins-internal/calc';
import * as katexPlugin from '@simplemd/plugins-internal/katex';
import * as mermaidPlugin from '@simplemd/plugins-internal/mermaid';
import { CONFIG_PATH } from '@simplemd/themes';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import type { InternalHostContext } from '@simplemd/plugin-api/internal/host';
import {
  collectDescriptors,
  internalPluginDescriptors,
  internalPlugins,
  type InternalAppServices,
} from '../src/plugins/internal/index';
import { APP_VERSION } from '../src/plugins/runtime';
import { PREFS_SAVE_DEBOUNCE_MS } from '../src/state/settings';
import { setup, type Harness } from './helpers';

const ROOT = join(__dirname, '../../..');
const calcFixture = readFileSync(
  join(ROOT, 'packages/plugins-internal/test/fixtures/calc-fixture.md'),
  'utf8',
);
const CALC_EXAMPLE = {
  '.simplemd/plugins/com.exemplo.calc/manifest.json': readFileSync(
    join(ROOT, 'plugins-examples/calc/manifest.json'),
    'utf8',
  ),
  '.simplemd/plugins/com.exemplo.calc/main.js': readFileSync(
    join(ROOT, 'plugins-examples/calc/main.js'),
    'utf8',
  ),
};

/** O Node não importa `blob:`: o texto preparado vai para arquivos temporários (sob a raiz). */
mkdirSync(join(__dirname, '../build'), { recursive: true });
const dir = mkdtempSync(join(__dirname, '../build/plugins-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let seq = 0;
const evaluator: ModuleEvaluator = {
  publish(text) {
    const file = join(dir, `simplemd-plugin-${++seq}.mjs`);
    writeFileSync(file, text);
    return file.replace(/\\/g, '/');
  },
  importModule: (url) => import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>,
};

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.innerHTML = '';
});

// r7 ST (impl-s0 §12.1 item 4): o contexto de cada plugin vem do runtime (`contextFor`).
function open(files: Record<string, string>) {
  return setup(files, { open: false, internalDescriptors: internalPluginDescriptors(), evaluator });
}

function row(h: Harness, key: string): PluginRowView | undefined {
  const snap = h.app.plugins.host.getSnapshot();
  return [...snap.internal, ...snap.external].find((r) => r.key === key || r.id === key);
}

async function until(check: () => boolean, label: string): Promise<void> {
  await vi.waitFor(() => {
    if (!check()) throw new Error(`esperando: ${label}`);
  });
}

/** O editor principal (um `EditorView`, construído uma vez) ligado à montagem dos plugins. */
function mountEditor(h: Harness, doc: string): EditorView {
  const parent = document.body.appendChild(document.createElement('div'));
  const view = new EditorView({ state: h.app.plugins.editor.createState(doc, 'calc.md'), parent });
  h.app.plugins.editor.attach(view);
  views.push(view);
  return view;
}

/** Chips do calc em calc-fixture.md com a árvore de sintaxe completa. */
const CALC_FIXTURE_CHIPS = 10;

/** Chips do calc desenhados: `[from, to, texto, nome acessível]` (AC-7.9: from/to/texto). */
function calcChips(view: EditorView): Array<[number, number, string, string]> {
  const out: Array<[number, number, string, string]> = [];
  for (const source of view.state.facet(EditorView.decorations)) {
    const set = typeof source === 'function' ? source(view) : source;
    set.between(0, view.state.doc.length, (from, to, deco) => {
      const widget = (deco.spec as { widget?: { toDOM(v: EditorView): HTMLElement } }).widget;
      const el = widget?.toDOM(view);
      if (!el || !/^cm-calc-(result|error)$/.test(el.className)) return;
      out.push([from, to, el.textContent ?? '', el.getAttribute('aria-label') ?? '']);
    });
  }
  return out.sort((a, b) => a[0] - b[0]);
}

describe('registro um-arquivo-por-plugin (r7 S0, D-R7-F01)', () => {
  const MIGRATED = ['simplemd.mermaid', 'simplemd.katex', 'simplemd.calc'];

  test('o coletor acha mermaid, katex e calc pelo import.meta.glob; lista ordenada por order, sem repetição', () => {
    const descriptors = internalPluginDescriptors();
    // CR-S0-08: as fatias seguintes acrescentam descritores sem editar esta asserção.
    expect(descriptors.map((d) => [d.id, d.order, d.defaultEnabled])).toEqual(
      expect.arrayContaining([
        ['simplemd.mermaid', 10, true],
        ['simplemd.katex', 20, true],
        ['simplemd.calc', 30, true],
      ]),
    );
    const orders = descriptors.map((d) => d.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(descriptors.map((d) => d.id)).size).toBe(descriptors.length);
    expect(new Set(orders).size).toBe(descriptors.length);
  });

  test('CR-S0-11: arquivo do glob sem descritor válido falha com o nome do arquivo', () => {
    const ok = internalPluginDescriptors()[0]!;
    expect(collectDescriptors({ './a.ts': ok, './b.ts': { ...ok, order: ok.order - 1 } })).toEqual([
      { ...ok, order: ok.order - 1 },
      ok,
    ]);
    for (const bad of [undefined, null, {}, { ...ok, id: 'outro.x' }, { ...ok, load: 1 }])
      expect(() => collectDescriptors({ './context.ts': bad })).toThrow(
        'plugins/internal/context.ts: o export default não é um descritor de defineInternalPlugin',
      );
  });

  test('manifestos iguais aos de antes do registro por arquivo (versão = a do app)', () => {
    const manifests = internalPlugins(APP_VERSION, () => {
      throw new Error('load não é chamado aqui');
    })
      .map((p) => p.manifest)
      .filter((m) => MIGRATED.includes(m.id));
    expect(manifests).toEqual([
      {
        id: 'simplemd.mermaid',
        name: 'Diagramas Mermaid',
        version: APP_VERSION,
        minAppVersion: '0.0.0',
        main: 'index.ts',
        description: 'Desenha blocos mermaid como diagramas.',
      },
      {
        id: 'simplemd.katex',
        name: 'Fórmulas KaTeX',
        version: APP_VERSION,
        minAppVersion: '0.0.0',
        main: 'index.ts',
        description: 'Mostra fórmulas entre $ e $$.',
      },
      {
        id: 'simplemd.calc',
        name: 'Cálculo',
        version: APP_VERSION,
        minAppVersion: '0.0.0',
        main: 'index.ts',
        description: 'Mostra o resultado de expressões como =2+3.',
      },
    ]);
  });

  test('load entrega a cada plugin só o próprio contexto e devolve o módulo do plugin', async () => {
    const seen: string[] = [];
    const plugins = internalPlugins(APP_VERSION, (d) => {
      seen.push(d.id);
      return {
        pluginId: d.id,
        host: { pluginId: d.id } as InternalHostContext,
        services: {} as InternalAppServices,
      };
    }).filter((p) => MIGRATED.includes(p.manifest.id));
    expect(seen).toEqual([]);
    const modules = await Promise.all(plugins.map((p) => p.load()));
    expect(seen).toEqual(MIGRATED);
    expect(modules.map((m) => m.default)).toEqual([
      mermaidPlugin.default,
      katexPlugin.default,
      calcPlugin.default,
    ]);
  });
});

describe('plugins internos pela API v1 (AC-7.2)', () => {
  test('Mermaid, KaTeX e calc só tocam `registerEditorExtension` da API', () => {
    for (const module of [mermaidPlugin, katexPlugin, calcPlugin]) {
      expect(module.default).toBe(module.activate);
      const touched: string[] = [];
      const calls: unknown[][] = [];
      const api = new Proxy(
        {},
        {
          get(_target, key) {
            touched.push(String(key));
            return (...args: unknown[]) => calls.push(args);
          },
        },
      );
      expect(module.activate(api as PluginAPI)).toBeUndefined();
      expect(touched).toEqual(['registerEditorExtension']);
      expect(calls).toHaveLength(1);
      expect(Object.keys(calls[0]![0] as object)).toEqual(['source']);
    }
  });

  test('mesmo caminho do host dos externos: ContributionStore.addExtension por id, nada mais', async () => {
    const h = await open({ 'nota.md': '# Nota\n' });
    const added = vi.spyOn(h.app.plugins.contributions, 'addExtension');
    const sources = vi.spyOn(h.app.plugins.contributions, 'addCompletionSource');
    const commandsBefore = h.app.plugins.commands.size;
    await h.app.sync.openVault('welcome');
    await until(
      () =>
        ['simplemd.mermaid', 'simplemd.katex', 'simplemd.calc'].every(
          (id) => row(h, id)?.status === 'Ativo',
        ),
      'internos ativos',
    );
    expect(added.mock.calls.map(([id]) => id)).toEqual([
      'simplemd.mermaid',
      'simplemd.katex',
      'simplemd.calc',
    ]);
    expect(sources).not.toHaveBeenCalled();
    expect(h.app.plugins.commands.size).toBe(commandsBefore);
    expect(h.app.plugins.contributions.counts()).toEqual({ extensions: 3, sources: 0, hotkeys: 0 });
    expect(h.app.plugins.panels.getSnapshot()).toEqual([]);
    const internal = h.app.plugins.host.getSnapshot().internal;
    expect(internal.map((r) => [r.name, r.description, r.reason])).toEqual([
      ['Diagramas Mermaid', 'Desenha blocos mermaid como diagramas.', ''],
      ['Fórmulas KaTeX', 'Mostra fórmulas entre $ e $$.', ''],
      ['Cálculo', 'Mostra o resultado de expressões como =2+3.', ''],
      // r7 S4: desligado por padrão (D-R7-P01); texto de motivo herdado do r2 (MELHORIAS do ST).
      [
        'Modo Vim',
        'Edição modal do Vim (normal, inserção, visual). Os atalhos do app continuam valendo.',
        'Desativado por você.',
      ],
      // r7 S7: desligado por padrão (D-R7-P01) — a linha existe, nada é ativado nem registrado.
      [
        'Outliner',
        'Listas como tópicos: mover, indentar e dobrar itens com os subitens; arrastar pelo marcador.',
        'Desativado por você.',
      ],
      [
        'Snippets LaTeX',
        'Atalhos de digitação dentro de $…$ e $$…$$: frações, matrizes, símbolos.',
        'Desativado por você.',
      ],
    ]);
  });
});

describe('interruptor dos internos (AC-7.10, R-7.6)', () => {
  test('desligar remove a renderização ao vivo, sem recarregar e com o mesmo EditorView; config.json guarda; reabrir restaura', async () => {
    const h = await open({ 'calc.md': calcFixture });
    await h.app.sync.openVault('welcome');
    await until(() => row(h, 'simplemd.calc')?.status === 'Ativo', 'calc ativo');
    const view = mountEditor(h, calcFixture);
    // Espera o número final: com a árvore Lezer ainda parcial (perna de cobertura lenta do CI deu
    // 12), os blocos de código do fim do arquivo ganham chips até o parser chegar neles.
    await until(() => calcChips(view).length === CALC_FIXTURE_CHIPS, 'chips');
    const chips = calcChips(view).length;
    expect(chips).toBe(CALC_FIXTURE_CHIPS);

    await h.app.plugins.host.setEnabled('simplemd.calc', false);
    await until(() => view.contentDOM.querySelectorAll('.cm-calc-result').length === 0, 'cru');
    expect(row(h, 'simplemd.calc')).toMatchObject({ status: 'Desativado', checked: false });
    expect(view.state.doc.toString()).toBe(calcFixture);
    expect(views).toEqual([view]);
    await vi.waitFor(
      () => {
        const config = JSON.parse(h.port.readText(CONFIG_PATH) ?? '{}');
        expect(config.plugins).toEqual({ internal: { 'simplemd.calc': false } });
      },
      { timeout: PREFS_SAVE_DEBOUNCE_MS * 5 },
    );

    await h.app.plugins.host.setEnabled('simplemd.calc', true);
    await until(() => calcChips(view).length === chips, 'chips de volta');

    await h.app.plugins.host.setEnabled('simplemd.mermaid', false);
    await vi.waitFor(
      () => {
        const config = JSON.parse(h.port.readText(CONFIG_PATH) ?? '{}');
        expect(config.plugins.internal).toEqual({
          'simplemd.calc': true,
          'simplemd.mermaid': false,
        });
      },
      { timeout: PREFS_SAVE_DEBOUNCE_MS * 5 },
    );
    const again = await open({
      'calc.md': calcFixture,
      [CONFIG_PATH]: h.port.readText(CONFIG_PATH)!,
    });
    await again.app.sync.openVault('welcome');
    await until(() => row(again, 'simplemd.katex')?.status === 'Ativo', 'reaberto');
    expect(row(again, 'simplemd.mermaid')).toMatchObject({
      status: 'Desativado',
      reason: 'Desativado por você.',
    });
    expect(row(again, 'simplemd.calc')?.status).toBe('Ativo');
  });
});

describe('plugins-examples/calc (AC-7.9, R-7.5)', () => {
  test('externo aprovado com o interno desligado → mesmo conjunto de decorações em calc-fixture.md', async () => {
    const internal = await open({ 'calc.md': calcFixture });
    await internal.app.sync.openVault('welcome');
    await until(() => row(internal, 'simplemd.calc')?.status === 'Ativo', 'interno ativo');
    const internalView = mountEditor(internal, calcFixture);
    await until(() => calcChips(internalView).length === CALC_FIXTURE_CHIPS, 'chips do interno');
    const expected = calcChips(internalView);

    const external = await open({
      'calc.md': calcFixture,
      [CONFIG_PATH]: JSON.stringify({ plugins: { internal: { 'simplemd.calc': false } } }),
      ...CALC_EXAMPLE,
    });
    await external.app.sync.openVault('welcome');
    await until(() => row(external, 'com.exemplo.calc')?.status === 'Desativado', 'descoberto');
    expect(row(external, 'simplemd.calc')?.status).toBe('Desativado');
    await external.app.plugins.host.setEnabled('com.exemplo.calc', true);
    expect(external.app.plugins.host.getSnapshot().warning?.id).toBe('com.exemplo.calc');
    await external.app.plugins.host.confirmWarning();
    await until(() => row(external, 'com.exemplo.calc')?.status === 'Ativo', 'externo ativo');
    const externalView = mountEditor(external, calcFixture);
    await until(() => calcChips(externalView).length === CALC_FIXTURE_CHIPS, 'chips do externo');
    expect(calcChips(externalView)).toEqual(expected);
    expect(expected.map(([, , text]) => text)).toContain('5');
  });
});
