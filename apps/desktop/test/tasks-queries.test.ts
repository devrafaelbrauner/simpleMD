// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import type { PluginAPI } from '@simplemd/plugin-api';
import type { InternalHostContext } from '@simplemd/plugin-api/internal/host';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fxR7 } from '../harness/fixtures/r7';
import { exportHtml } from '../src/export/pipeline';
import { querySnapshotRenderer, setQuerySnapshotRenderer } from '../src/export/query-source';
import tasksDescriptor from '../src/plugins/internal/tasks';
import { setup, type Harness } from './helpers';

// Espiões nos dois lados da closure do registro (AC-I9.1 parte 2): o catálogo criado no registro é o
// MESMO objeto que chega ao `createTasksPlugin`, e a nenhum outro lugar.
const seen = vi.hoisted(() => ({ created: [] as unknown[], delivered: [] as unknown[] }));
vi.mock('../src/catalog/tasks-catalog', async (original) => {
  const real = await original<typeof import('../src/catalog/tasks-catalog')>();
  return {
    ...real,
    createTasksCatalog: (...args: Parameters<typeof real.createTasksCatalog>) => {
      const catalog = real.createTasksCatalog(...args);
      seen.created.push(catalog);
      return catalog;
    },
  };
});
vi.mock('@simplemd/plugins-internal/tasks', async (original) => {
  const real = await original<typeof import('@simplemd/plugins-internal/tasks')>();
  return {
    ...real,
    createTasksPlugin: (...args: Parameters<typeof real.createTasksPlugin>) => {
      seen.delivered.push(args[1]);
      return real.createTasksPlugin(...args);
    },
  };
});

afterEach(() => {
  setQuerySnapshotRenderer(null);
  seen.created.length = 0;
  seen.delivered.length = 0;
  document.body.innerHTML = '';
});

/** FX-R7 com o índice pronto e o `simplemd.tasks` real carregado pelo runtime. */
async function harness(): Promise<Harness> {
  const h = await setup(fxR7(), { catalog: true, internalDescriptors: [tasksDescriptor] });
  await vi.waitFor(
    () => {
      expect(h.app.catalog.getSnapshot().status).toBe('ready');
      expect(querySnapshotRenderer()).not.toBeNull();
    },
    { timeout: 10_000 },
  );
  return h;
}

const CONSULTAS = String(fxR7()['consultas.md']);
const ALL_ON = () => true;

describe('AC-I9.1 (parte 2): o catálogo privado só chega ao plugin pela closure do registro', () => {
  it('um catálogo criado no registro = o entregue ao createTasksPlugin; módulo e api v1 sem ele; nada em window', async () => {
    const h = await harness();
    expect(seen.created).toHaveLength(1);
    expect(seen.delivered).toEqual(seen.created);

    // Carga direta do descritor (mesmo caminho do runtime) para inspecionar o módulo e o activate.
    const before = new Set(Object.getOwnPropertyNames(globalThis));
    const host = {
      pluginId: 'simplemd.tasks',
      platform: 'mac',
      editor: { interact: () => [], announce: () => {} },
      options: { get: () => true, subscribe: () => () => {} },
      links: { openExternal: () => {} },
    } as unknown as InternalHostContext;
    const module = await tasksDescriptor.load({
      pluginId: 'simplemd.tasks',
      host,
      services: {
        platform: h.platform,
        store: h.app.store,
        registry: h.app.registry,
        catalog: h.app.catalog,
        sync: h.app.sync,
        editor: h.app.plugins.editor,
      },
    });
    const catalog = seen.created.at(-1);
    expect(Object.keys(module).sort()).toEqual(['default', 'renderQueryHtml']);
    expect(Object.values(module)).not.toContain(catalog);

    const touched: string[] = [];
    const api = new Proxy({} as PluginAPI, {
      get(_target, key) {
        touched.push(String(key));
        return () => () => {};
      },
    });
    const dispose = module.default(api);
    expect(touched).toEqual(['registerEditorExtension']);
    if (typeof dispose === 'function') dispose();

    const added = Object.getOwnPropertyNames(globalThis).filter((name) => !before.has(name));
    expect(added.filter((name) => Reflect.get(globalThis, name) === catalog)).toEqual([]);
    expect(Object.values(globalThis)).not.toContain(catalog);
  });
});

describe('AC-EX.4: consultas exportadas como instantâneo estático', () => {
  it('cada cerca tasks/dataview vira .smd-query com ☐/☑, sem controles; dataviewjs → mensagem fixa', async () => {
    await harness();
    const html = await exportHtml(CONSULTAS, 'consultas.md', ALL_ON);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const frames = [...doc.querySelectorAll('.smd-query')];
    // 11 tasks + 11 dataview + 1 dataviewjs (as 3 recusadas incluídas).
    expect(frames).toHaveLength(23);
    expect(doc.querySelectorAll('input, button, [role], [tabindex], a, [href]')).toHaveLength(0);
    expect(doc.querySelectorAll('pre code')).toHaveLength(0);
    const text = doc.body.textContent ?? '';
    expect(text).toContain('☐');
    expect(text).toContain('☑');
    expect(frames[0]!.querySelector('.smd-query-head')!.textContent).toMatch(
      /^\d+ resultados tasks$/,
    );
    expect(text).toContain('Instrução não reconhecida na linha 1: status.type is CANCELLED');
    expect(text).toContain('Consultas em JavaScript não são suportadas');
    expect(text).toContain('Não suportado nas consultas do simpleMD: FLATTEN (linha 1).');
    // LIST FROM [[Bolo]] na hora da exportação: as 5 notas que apontam para o Bolo.
    const bolo = frames.filter((f) => f.querySelectorAll('.smd-query-note').length === 5);
    expect(bolo.length).toBeGreaterThanOrEqual(1);
    // TABLE real com cabeçalho.
    expect(doc.querySelector('.smd-query table th')?.textContent).toBe('Nota');
    // Origem como texto "<título> › linha <n>" (sem link).
    expect(doc.querySelector('.smd-query-meta')?.textContent).toMatch(/› linha \d+$/);
  });

  it('o instantâneo reflete o catálogo na hora (tarefa nova salva aparece na próxima exportação)', async () => {
    const h = await harness();
    const doc = '```tasks\ndescription includes exportação nova\n```\n';
    expect(await exportHtml(doc, 'x.md', ALL_ON)).toContain('Nenhum resultado');
    h.port.externalWrite('nova.md', '- [x] exportação nova ✅ 2026-10-10\n');
    await vi.waitFor(
      async () => expect(await exportHtml(doc, 'x.md', ALL_ON)).toContain('1 resultado'),
      { timeout: 10_000 },
    );
    expect(await exportHtml(doc, 'x.md', ALL_ON)).toContain('☑');
  });

  it('descrição da nota sai escapada (texto, nunca HTML)', async () => {
    const h = await harness();
    h.port.externalWrite('xss.md', '- [ ] <img src=x onerror=alert(1)> perigo\n');
    const doc = '```tasks\ndescription includes perigo\n```\n';
    await vi.waitFor(
      async () => expect(await exportHtml(doc, 'x.md', ALL_ON)).toContain('1 resultado'),
      { timeout: 10_000 },
    );
    const html = await exportHtml(doc, 'x.md', ALL_ON);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; perigo');
    expect(new DOMParser().parseFromString(html, 'text/html').querySelector('img')).toBeNull();
  });
});

describe('AC-I9.10 / R-I9.9: plugin desligado → código cru na exportação', () => {
  it('com simplemd.tasks desligado as cercas saem como bloco de código', async () => {
    await harness();
    const html = await exportHtml(CONSULTAS, 'consultas.md', (id) => id !== 'simplemd.tasks');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelectorAll('.smd-query')).toHaveLength(0);
    const codes = [...doc.querySelectorAll('pre code')].map((c) => c.textContent);
    expect(codes).toContain('not done');
    expect(codes.some((c) => c?.startsWith('dv.paragraph'))).toBe(true);
  });

  it('sem o plugin carregado (renderizador ausente) também sai cru', async () => {
    setQuerySnapshotRenderer(null);
    const html = await exportHtml('```tasks\nnot done\n```\n', 'x.md', ALL_ON);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelectorAll('.smd-query')).toHaveLength(0);
    expect(doc.querySelector('pre code')?.textContent).toBe('not done');
  });
});
