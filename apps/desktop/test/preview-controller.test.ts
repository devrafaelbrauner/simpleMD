// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { linkOpenerFacet, type LinkOpener, type LinkTarget } from '@simplemd/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createImageService } from '../src/editor/image-service';
import { normalizeRender } from '../src/export/normalize';
import {
  assertInert,
  lineToOffset,
  offsetToLine,
  previewDelay,
  PreviewController,
  type PreviewAnchor,
  type PreviewDeps,
  type PreviewStatus,
} from '../src/preview/controller';
import type { Clock } from '../src/state/sync';
import { fxR7 } from '../harness/fixtures/r7';
import richFixture from '@simplemd/plugins-internal/fixtures/rich.md?raw';
import { setup, type Harness } from './helpers';

/** Blocos forçados no `previewBody` (só os testes de recusa do `assertInert` no controlador). */
const forced = vi.hoisted(() => ({ blocks: null as { line: number; html: string }[] | null }));
vi.mock('../src/export/pipeline', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/export/pipeline')>();
  return {
    ...original,
    previewBody: (...args: Parameters<typeof original.previewBody>) =>
      forced.blocks ? Promise.resolve(forced.blocks) : original.previewBody(...args),
  };
});

afterEach(() => {
  forced.blocks = null;
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, '__xss');
});

/** Relógio manual: só o teste avança o tempo do debounce. */
function manualClock(): Clock & { advance(ms: number): void; pending(): number[] } {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimeout(callback, ms) {
      timers.set(++next, { at: now + ms, callback });
      return next;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
    },
    pending: () => [...timers.values()].map((timer) => timer.at - now),
  };
}

/**
 * Deixa as cargas `import()` (I/O real do Vite, fora do relógio manual) e as promessas andarem até
 * `done`; poucos ms com a máquina livre, teto de ~5 s com a suíte inteira em paralelo.
 */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2500; i++) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`esperou demais: ${what}`);
}

interface Rig {
  readonly h: Harness;
  readonly clock: ReturnType<typeof manualClock>;
  readonly preview: PreviewController;
  readonly host: HTMLElement;
  readonly seen: PreviewStatus[];
  status(): PreviewStatus;
  /** Avança o relógio e espera a renderização pedida terminar (pronta ou erro). */
  render(ms?: number): Promise<PreviewStatus>;
}

async function rig(
  files: Record<string, string | Uint8Array>,
  open: readonly string[],
  extra: Partial<PreviewDeps> = {},
): Promise<Rig> {
  const h = await setup(files);
  for (const path of open) await h.app.sync.openFile(path);
  const clock = manualClock();
  const preview = new PreviewController({
    store: h.app.store,
    registry: h.app.registry,
    clock,
    enabled: () => false,
    imageSource: () => null,
    wikilinks: () => ({ exists: () => false }),
    view: () => null,
    ...extra,
  });
  const host = document.createElement('div');
  document.body.append(host);
  const seen: PreviewStatus[] = [];
  preview.status.subscribe(() => seen.push(preview.status.getSnapshot()));
  preview.attach(host);
  const status = () => preview.status.getSnapshot();
  return {
    h,
    clock,
    preview,
    host,
    seen,
    status,
    async render(ms = 0) {
      const before = seen.length;
      clock.advance(ms);
      await until(
        () => seen.slice(before).some((s) => s.kind === 'ready' || s.kind === 'error'),
        'renderização',
      );
      return status();
    },
  };
}

const NOTE = '# Título\n\nTexto **forte**.\n\n## Seção\n\nfim\n';

describe('AC-R38A-2: renderiza a nota ativa, com debounce, sem gravar nada', () => {
  it('visível → nota ativa em blocos com a linha; escondida → nada', async () => {
    const r = await rig({ 'nota.md': NOTE }, ['nota.md']);
    const writes = r.h.writes();
    expect(r.status()).toEqual({ kind: 'off' });
    expect(r.clock.pending()).toEqual([]);
    r.preview.setVisible(true);
    const ready = await r.render();
    expect(ready).toMatchObject({ kind: 'ready', path: 'nota.md', generation: 1 });
    const blocks = [...r.host.querySelectorAll<HTMLElement>(':scope > .smd-preview-block')];
    expect(blocks.map((b) => [b.dataset.line, b.firstElementChild?.localName])).toEqual([
      ['1', 'h1'],
      ['3', 'p'],
      ['5', 'h2'],
      ['7', 'p'],
    ]);
    expect(r.host.querySelector('p strong')?.textContent).toBe('forte');
    // Renderizar não grava nada: nem a nota, nem o config, nem um arquivo exportado.
    expect(r.h.writes()).toBe(writes);
    expect(r.h.platform.saveTarget.write).not.toHaveBeenCalled();
    r.preview.setVisible(false);
    expect(r.status()).toEqual({ kind: 'off' });
    expect(r.host.childNodes).toHaveLength(0);
    r.h.type('nota.md', 'mais');
    r.preview.onEditorChange('nota.md');
    expect(r.clock.pending()).toEqual([]);
  });

  it('debounce de 300 ms (adaptativo): mudanças seguidas viram UMA renderização', async () => {
    expect([0, 100, 150, 1000].map(previewDelay)).toEqual([300, 300, 450, 2000]);
    const r = await rig({ 'nota.md': NOTE }, ['nota.md']);
    r.preview.setVisible(true);
    const first = await r.render();
    // A espera depende do custo real da 1ª renderização (300 ms com a máquina livre).
    const delay = previewDelay(first.kind === 'ready' ? first.ms : 0);
    for (const text of ['\numa', '\nduas', '\ntrês']) {
      r.h.type('nota.md', text);
      r.preview.onEditorChange('nota.md');
      r.clock.advance(100);
    }
    expect(r.clock.pending()).toEqual([delay - 100]);
    expect(r.host.textContent).not.toContain('três');
    const ready = await r.render(delay - 100);
    expect(ready).toMatchObject({ kind: 'ready', generation: 2 });
    expect(r.host.querySelector('.smd-preview-block[data-line="9"] p')?.textContent).toBe(
      'uma\nduas\ntrês',
    );
    // Mudança em outra aba (não a ativa) não agenda nada.
    r.preview.onEditorChange('outra.md');
    expect(r.clock.pending()).toEqual([]);
  });

  it('resultado velho é descartado: a troca de aba no meio da renderização vence', async () => {
    const r = await rig({ 'a.md': '# A\n', 'b.md': '# B\n' }, ['a.md', 'b.md']);
    r.preview.setVisible(true);
    r.h.app.store.getState().activate('a.md');
    r.clock.advance(0); // pedido de "a.md" em voo (cargas `import()` ainda pendentes)
    r.h.app.store.getState().activate('b.md');
    const ready = await r.render();
    expect(ready).toMatchObject({ kind: 'ready', path: 'b.md', generation: 1 });
    expect(r.seen.filter((s) => s.kind === 'ready')).toHaveLength(1);
    expect(r.host.querySelector('h1')?.textContent).toBe('B');
  });

  it('sem aba → vazio; recarga do disco da aba ativa rerenderiza na hora', async () => {
    const r = await rig({ 'nota.md': NOTE }, []);
    r.preview.setVisible(true);
    r.clock.advance(0);
    expect(r.status()).toEqual({ kind: 'empty' });
    await r.h.app.sync.openFile('nota.md');
    await r.render();
    const record = r.h.app.registry.get('nota.md');
    if (!record) throw new Error('sem registro');
    r.h.app.registry.replace('nota.md', {
      ...record,
      state: EditorState.create({ doc: '# Recarregada\n' }),
    });
    expect(r.clock.pending()).toEqual([0]);
    await r.render();
    expect(r.host.querySelector('h1')?.textContent).toBe('Recarregada');
  });
});

describe('AC-R38A-2: segurança (assertInert, fixture hostil, links)', () => {
  it('`html.md` hostil do FX-R7: renderiza o permitido e nada executa nem sobra ativo', async () => {
    const r = await rig(fxR7(), ['html.md']);
    r.preview.setVisible(true);
    expect(await r.render()).toMatchObject({ kind: 'ready', path: 'html.md' });
    const host = r.host;
    expect(host.querySelector('details summary')?.textContent).toBe('Resumo');
    expect(host.querySelectorAll('kbd')).toHaveLength(2);
    expect(
      host.querySelectorAll(
        'script, iframe, object, embed, form, input, button, style, link, meta, base, math, svg',
      ),
    ).toHaveLength(0);
    for (const element of host.querySelectorAll('*')) {
      for (const { name, value } of element.attributes) {
        expect(name.startsWith('on'), `${element.localName}[${name}]`).toBe(false);
        expect(['id', 'name'].includes(name), `${element.localName}[${name}]`).toBe(false);
        expect(value.toLowerCase().replace(/\s/g, '')).not.toMatch(
          /javascript:|vbscript:|data:text/,
        );
      }
    }
    expect(host.querySelector('[style*="position"]')).toBeNull();
    // Sem cache de imagens: as do vault e as remotas ficam como texto alternativo.
    expect(host.querySelectorAll('img')).toHaveLength(0);
    expect('__xss' in window).toBe(false);
  });

  it('FX-RICH e as notas do FX-R7: o corpo inteiro passa no assertInert (nenhuma recusa falsa)', async () => {
    const notes = Object.entries({ ...fxR7(), 'rich.md': richFixture }).filter(
      ([path, value]) => path.endsWith('.md') && typeof value === 'string',
    );
    const r = await rig(Object.fromEntries(notes), ['rich.md']);
    r.preview.setVisible(true);
    for (const [path] of notes) {
      await r.h.app.sync.openFile(path);
      expect(await r.render(), path).toMatchObject({ kind: 'ready', path });
      expect(r.host.querySelectorAll('.smd-preview-block').length, path).toBeGreaterThan(0);
    }
  });

  it('imagens do vault pela cache da janela (`blob:`); invalidação reagenda a prévia', async () => {
    let n = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:simplemd/${++n}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const h0 = await setup(fxR7());
    const cache = createImageService({ platform: h0.platform, store: h0.app.store });
    const r = await rig(fxR7(), ['html.md'], { imageSource: () => cache });
    r.preview.setVisible(true);
    const ready = await r.render();
    expect(ready).toMatchObject({ kind: 'ready' });
    const imgs = [...r.host.querySelectorAll('img')];
    expect(imgs.map((img) => [img.getAttribute('alt'), img.getAttribute('src')])).toEqual([
      ['imagem do vault em HTML', 'blob:simplemd/1'],
    ]);
    cache.invalidate('img/bandeira.png');
    await until(() => r.clock.pending().length > 0, 'reagendar');
    expect(r.clock.pending()).toEqual([previewDelay(ready.kind === 'ready' ? ready.ms : 0)]);
  });

  it('renderização com elemento, atributo ou URL proibidos → erro, nada inserido', async () => {
    const r = await rig({ 'nota.md': NOTE }, ['nota.md']);
    r.preview.setVisible(true);
    await r.render();
    for (const html of [
      '<p onclick="window.__xss=1">x</p>',
      '<img src="blob:fora-do-mapa" alt="x">',
      '<a href="javascript:window.__xss=1">x</a>',
      '<svg><foreignObject><p>x</p></foreignObject></svg>',
      '<iframe src="https://exemplo.org"></iframe>',
      '<div style="background: url(https://exemplo.org/x.png)">x</div>',
    ]) {
      forced.blocks = [{ line: 1, html }];
      // Recarga sem mudança: só pede a renderização (os blocos vêm de `forced`).
      const record = r.h.app.registry.get('nota.md');
      if (!record) throw new Error('sem registro');
      r.h.app.registry.replace('nota.md', record);
      expect(await r.render(), html).toEqual({ kind: 'error', path: 'nota.md', reason: 'unsafe' });
      expect(r.host.childNodes, html).toHaveLength(0);
    }
    expect('__xss' in window).toBe(false);
  });

  it('assertInert: só as `blob:` do mapa passam; o resto segue a política da exportação', () => {
    const img = '<img src="blob:simplemd/1" alt="a">';
    expect(assertInert(img, ['blob:simplemd/1'], normalizeRender)).toBe(img);
    expect(assertInert(img, [], normalizeRender)).toBeNull();
    expect(assertInert(img, ['blob:outra'], normalizeRender)).toBeNull();
    // Um valor que não é uma `blob:` simples nunca entra na lista aceita.
    expect(assertInert('<img src="x">', ['blob:a" onerror="x'], normalizeRender)).toBe(
      '<img src="x">',
    );
    expect(assertInert('<p>ok <a href="https://e.org">e</a></p>', [], normalizeRender)).toBe(
      '<p>ok <a href="https://e.org">e</a></p>',
    );
    expect(assertInert('<p onmouseover="x()">x</p>', [], normalizeRender)).toBeNull();
  });

  it('links: nunca navegam; o clique vai ao serviço único com o alvo classificado', async () => {
    const opened: LinkTarget[] = [];
    const opener: LinkOpener = { open: (target) => opened.push(target), noLink: () => {} };
    const parent = document.createElement('div');
    document.body.append(parent);
    const view = new EditorView({
      state: EditorState.create({ doc: 'x', extensions: linkOpenerFacet.of(opener) }),
      parent,
    });
    const r = await rig(
      { 'nota.md': '[ext](https://exemplo.org/a) e [outra](b.md#Seção)\n', 'b.md': '# B\n' },
      ['nota.md'],
      { view: () => view },
    );
    r.preview.setVisible(true);
    await r.render();
    const links = [...r.host.querySelectorAll('a')];
    expect(links).toHaveLength(2);
    const clicks = links.map((link) => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      link.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(clicks).toEqual([true, true]);
    const middle = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    links[0]?.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(true);
    expect(opened.map((target) => target.kind)).toEqual(['external', 'note']);
    expect(opened[1]).toMatchObject({ kind: 'note', path: 'b.md', heading: 'Seção' });
    view.destroy();
  });
});

describe('rolagem sincronizada (D-R38-08): mapa entre linhas e deslocamentos', () => {
  const anchors: PreviewAnchor[] = [
    { line: 1, top: 0 },
    { line: 5, top: 100 },
    { line: 9, top: 100 },
    { line: 21, top: 400 },
  ];

  it('interpola entre âncoras e prende nas pontas', () => {
    expect(lineToOffset(anchors, 1)).toBe(0);
    expect(lineToOffset(anchors, 3)).toBe(50);
    expect(lineToOffset(anchors, 7)).toBe(100);
    expect(lineToOffset(anchors, 15)).toBe(250);
    expect(lineToOffset(anchors, 99)).toBe(400);
    expect(lineToOffset([], 3)).toBe(0);
    expect(offsetToLine(anchors, 50)).toBe(3);
    expect(offsetToLine(anchors, 100)).toBe(5);
    expect(offsetToLine(anchors, 250)).toBe(15);
    expect(offsetToLine(anchors, -10)).toBe(1);
    expect(offsetToLine(anchors, 1000)).toBe(21);
  });
});
