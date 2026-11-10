// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import '../../../packages/plugins-internal/test/setup-svg';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { linkOpenerFacet, type LinkOpener, type LinkTarget } from '@simplemd/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createImageService } from '../src/editor/image-service';
import { normalizeRender } from '../src/export/normalize';
import {
  assertInert,
  inertBlocks,
  lineToOffset,
  offsetToLine,
  previewDelay,
  PreviewController,
  PREVIEW_REFUSED_CLASS,
  PREVIEW_REFUSED_TEXT,
  PREVIEW_RENDER_MEASURE,
  type PreviewAnchor,
  type PreviewDeps,
  type PreviewStatus,
} from '../src/preview/controller';
import type { Clock } from '../src/state/sync';
import { fxR7 } from '../harness/fixtures/r7';
import richFixture from '@simplemd/plugins-internal/fixtures/rich.md?raw';
import { loadMermaid } from '@simplemd/plugins-internal/mermaid/render';
import { setup, type Harness } from './helpers';

/**
 * `previewBody` sob controle do teste: blocos forçados (recusas do `assertInert`), falha forçada
 * (F5) e portões (P4/P5: cada chamada espera o próximo da fila, e o resultado velho pode chegar
 * depois do novo). `entered`/`left` contam as chamadas que entraram e que saíram.
 */
const forced = vi.hoisted(() => ({
  blocks: null as { line: number; html: string }[] | null,
  fail: false,
  gates: [] as Promise<void>[],
  entered: 0,
  left: 0,
}));
vi.mock('../src/export/pipeline', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/export/pipeline')>();
  return {
    ...original,
    previewBody: async (...args: Parameters<typeof original.previewBody>) => {
      forced.entered++;
      try {
        await forced.gates.shift();
        if (forced.fail) throw new Error('falha forçada do pipeline');
        return forced.blocks ?? (await original.previewBody(...args));
      } finally {
        forced.left++;
      }
    },
  };
});

afterEach(() => {
  forced.blocks = null;
  forced.fail = false;
  forced.gates = [];
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, '__xss');
});

/** Prende o próximo `previewBody` num portão; devolve quem o abre. */
function gate(): () => void {
  const { promise, resolve } = Promise.withResolvers<void>();
  forced.gates.push(promise);
  return () => resolve();
}

/**
 * Abre o portão e espera o pedido preso sair do `previewBody`. A continuação do controlador depois
 * dele é síncrona até o fim (corte, inserção, status) e roda nas microtarefas logo depois da saída,
 * antes da próxima volta de `until`.
 */
async function drain(open: () => void): Promise<void> {
  const left = forced.left;
  open();
  await until(() => forced.left > left, 'pedido preso sai do previewBody');
}

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
  /** Recarga do disco (texto novo ou o mesmo): pede a renderização na hora. */
  reload(path: string, text?: string): void;
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
    reload(path, text) {
      const record = h.app.registry.get(path);
      if (!record) throw new Error(`sem registro: ${path}`);
      h.app.registry.replace(
        path,
        text === undefined ? record : { ...record, state: EditorState.create({ doc: text }) },
      );
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
    r.reload('nota.md', '# Recarregada\n');
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

  it('bloco com elemento, atributo, URL ou folha proibidos → só o aviso no lugar dele', async () => {
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
      // F1 (r38a2): folhas que valeriam para o app inteiro.
      '<p>x<style>body{display:none}</style></p>',
      '<svg id="mmd-x"><style>@keyframes cm-blink{from{opacity:0}} body{display:none}</style></svg>',
    ]) {
      forced.blocks = [{ line: 1, html }];
      // Recarga sem mudança: só pede a renderização (os blocos vêm de `forced`).
      r.reload('nota.md');
      expect(await r.render(), html).toMatchObject({ kind: 'ready', path: 'nota.md' });
      expect(r.host.innerHTML, html).toBe(
        `<div class="smd-preview-block" data-line="1"><p class="${PREVIEW_REFUSED_CLASS}">${PREVIEW_REFUSED_TEXT}</p></div>`,
      );
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

  it('inertBlocks: uma conferência no caso comum; recusa só do bloco; montagem recusada → null', () => {
    const checked: string[] = [];
    const counting = (html: string) => {
      checked.push(html);
      return normalizeRender(html);
    };
    const ok = [
      { line: 1, html: '<h1>A</h1>' },
      { line: 3, html: '<p>b</p>' },
    ];
    expect(inertBlocks(ok, [], counting)).toBe(
      '<div class="smd-preview-block" data-line="1"><h1>A</h1></div>\n<div class="smd-preview-block" data-line="3"><p>b</p></div>',
    );
    expect(checked).toHaveLength(1);
    expect(
      inertBlocks([ok[0]!, { line: 3, html: '<p onclick="x()">b</p>' }], [], normalizeRender),
    ).toBe(
      `<div class="smd-preview-block" data-line="1"><h1>A</h1></div>\n<div class="smd-preview-block" data-line="3"><p class="${PREVIEW_REFUSED_CLASS}">${PREVIEW_REFUSED_TEXT}</p></div>`,
    );
    // Cada bloco passa sozinho, mas a montagem não: nada entra.
    const joinedRefused = (html: string) => (html.includes('\n') ? null : normalizeRender(html));
    expect(inertBlocks(ok, [], joinedRefused)).toBeNull();
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

describe('r38a2: endurecimento da prévia (F1–F6)', () => {
  it('P4 (F2): o resultado velho que chega depois do novo é descartado', async () => {
    const r = await rig({ 'nota.md': '# Velha\n' }, ['nota.md']);
    r.preview.setVisible(true);
    await r.render();
    const open = gate();
    const entered = forced.entered;
    r.reload('nota.md');
    r.clock.advance(0);
    await until(() => forced.entered > entered, 'pedido velho no previewBody');
    r.reload('nota.md', '# Nova\n');
    expect(await r.render()).toMatchObject({ kind: 'ready', generation: 2 });
    const seen = r.seen.length;
    await drain(open);
    expect(r.seen.length).toBe(seen);
    expect(r.status()).toMatchObject({ kind: 'ready', generation: 2 });
    expect(r.host.querySelector('h1')?.textContent).toBe('Nova');
  });

  it('P5 (F2): esconder no meio da renderização descarta o resultado', async () => {
    const r = await rig({ 'nota.md': NOTE }, ['nota.md']);
    r.preview.setVisible(true);
    await r.render();
    const open = gate();
    const entered = forced.entered;
    r.reload('nota.md');
    r.clock.advance(0);
    await until(() => forced.entered > entered, 'pedido no previewBody');
    r.preview.setVisible(false);
    const seen = r.seen.length;
    await drain(open);
    expect(r.seen.length).toBe(seen);
    expect(r.status()).toEqual({ kind: 'off' });
    expect(r.host.childNodes).toHaveLength(0);
  });

  it('AC-R38A2-2 (F3): link com `url()` no texto e no href renderiza, sem aviso', async () => {
    const href = 'https://developer.mozilla.org/en-US/docs/Web/CSS/url()';
    const r = await rig({ 'nota.md': `# CSS\n\n[url() no MDN](${href})\n` }, ['nota.md']);
    r.preview.setVisible(true);
    expect(await r.render()).toMatchObject({ kind: 'ready', path: 'nota.md' });
    const link = r.host.querySelector('a');
    expect([link?.textContent, link?.getAttribute('href')]).toEqual(['url() no MDN', href]);
    expect(r.host.querySelector(`.${PREVIEW_REFUSED_CLASS}`)).toBeNull();
  });

  it('AC-R38A2-2 (F3): só o bloco inseguro vira aviso; os outros renderizam', async () => {
    const r = await rig({ 'nota.md': NOTE }, ['nota.md']);
    r.preview.setVisible(true);
    await r.render();
    forced.blocks = [
      { line: 1, html: '<h1>Antes</h1>' },
      { line: 3, html: '<p onclick="window.__xss=1">x</p>' },
      { line: 5, html: '<p>Depois</p>' },
    ];
    r.reload('nota.md');
    expect(await r.render()).toMatchObject({ kind: 'ready', path: 'nota.md' });
    const blocks = [...r.host.querySelectorAll<HTMLElement>(':scope > .smd-preview-block')];
    expect(blocks.map((block) => [block.dataset.line, block.textContent])).toEqual([
      ['1', 'Antes'],
      ['3', PREVIEW_REFUSED_TEXT],
      ['5', 'Depois'],
    ]);
    expect(r.host.querySelector('[onclick]')).toBeNull();
    expect('__xss' in window).toBe(false);
  });

  it('AC-R38A2-1 (F1): `%%{init}%%` com themeCSS e `<style>` global na nota não alcançam o app', async () => {
    await loadMermaid();
    const note = [
      '```mermaid',
      '%%{init: {"themeCSS": "@keyframes evil{from{opacity:0}} body{display:none}", "fontFamily": "x} @keyframes ff{} a{b:c"}}%%',
      'flowchart TD',
      '  A --> B',
      '```',
      '',
      '<style>body { display: none }</style>',
      '',
    ].join('\n');
    const r = await rig({ 'nota.md': note }, ['nota.md'], {
      enabled: (id) => id === 'simplemd.mermaid',
    });
    r.preview.setVisible(true);
    expect(await r.render()).toMatchObject({ kind: 'ready', path: 'nota.md' });
    const svg = r.host.querySelector('figure.smd-mermaid > svg');
    expect(svg?.id).toMatch(/^mmd-/);
    // A única folha no host é a do diagrama, e só com as regras do próprio Mermaid.
    const styles = [...r.host.querySelectorAll('style')];
    expect(styles.map((style) => style.parentElement)).toEqual([svg]);
    const css = styles[0]?.textContent ?? '';
    expect([...css.matchAll(/@keyframes ([\w-]+)/g)].map((match) => match[1])).toEqual([
      'edge-animation-frame',
      'dash',
    ]);
    expect(css).not.toMatch(/evil|ff\{|body\{|a\{b:c/);
    expect(r.host.querySelector(`.${PREVIEW_REFUSED_CLASS}`)).toBeNull();
  }, 30_000);

  it('F4: gravar (dirty → saving → clean) não fura o debounce nem rerenderiza o mesmo texto', async () => {
    const r = await rig({ 'nota.md': NOTE }, ['nota.md']);
    r.preview.setVisible(true);
    const first = await r.render();
    const docs = [r.h.app.store.getState().docs['nota.md'] ?? ''];
    r.h.app.store.subscribe((state) => {
      const status = state.docs['nota.md'] ?? '';
      if (docs[docs.length - 1] !== status) docs.push(status);
    });
    // Digitação com renderização pendente: gravar no meio não troca a espera por 0 ms.
    const delay = previewDelay(first.kind === 'ready' ? first.ms : 0);
    r.h.type('nota.md', '\nmais');
    r.preview.onEditorChange('nota.md');
    r.clock.advance(100);
    await r.h.app.sync.flush('nota.md');
    expect(docs).toEqual(['clean', 'dirty', 'saving', 'clean']);
    expect(r.clock.pending()).toEqual([delay - 100]);
    const second = await r.render(delay - 100);
    expect(second).toMatchObject({ kind: 'ready', generation: 2 });
    // O texto novo já está na prévia quando a gravação acontece: nenhuma renderização a mais.
    r.h.type('nota.md', '!');
    r.preview.onEditorChange('nota.md');
    const third = await r.render(previewDelay(second.kind === 'ready' ? second.ms : 0));
    expect(third).toMatchObject({ kind: 'ready', generation: 3 });
    const seen = r.seen.length;
    await r.h.app.sync.flush('nota.md');
    expect(docs.slice(-2)).toEqual(['saving', 'clean']);
    expect(r.clock.pending()).toEqual([]);
    expect(r.seen.length).toBe(seen);
    expect(r.host.textContent).toContain('mais!');
  });

  it('F5: falha logo depois de trocar de aba limpa o host; na mesma nota, o último resultado fica', async () => {
    const r = await rig({ 'a.md': '# A\n', 'b.md': '# B\n' }, ['a.md', 'b.md']);
    r.preview.setVisible(true);
    r.h.app.store.getState().activate('a.md');
    expect(await r.render()).toMatchObject({ kind: 'ready', path: 'a.md' });
    forced.fail = true;
    r.h.app.store.getState().activate('b.md');
    expect(await r.render()).toEqual({ kind: 'error', path: 'b.md', reason: 'failed' });
    expect(r.host.childNodes).toHaveLength(0);
    forced.fail = false;
    r.reload('b.md');
    expect(await r.render()).toMatchObject({ kind: 'ready', path: 'b.md' });
    forced.fail = true;
    r.reload('b.md');
    expect(await r.render()).toEqual({ kind: 'error', path: 'b.md', reason: 'failed' });
    expect(r.host.querySelector('h1')?.textContent).toBe('B');
  });

  it('F6: a linha do tempo guarda só a última medida, sem o caminho da nota', async () => {
    const r = await rig({ 'nota.md': NOTE }, ['nota.md']);
    r.preview.setVisible(true);
    await r.render();
    r.reload('nota.md');
    await r.render();
    const entries = performance.getEntriesByName(PREVIEW_RENDER_MEASURE);
    expect(entries.map((entry) => ('detail' in entry ? entry.detail : 'sem detail'))).toEqual([
      null,
    ]);
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

describe('r39b: a rolagem da prévia segue só o view do grupo com foco', () => {
  it('o view que perdeu o foco não move a prévia; depois da renderização, o do grupo novo move', async () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const left = new EditorView({ state: EditorState.create({ doc: NOTE }), parent });
    const right = new EditorView({ state: EditorState.create({ doc: NOTE }), parent });
    let focused = left;
    const r = await rig({ 'nota.md': NOTE }, ['nota.md'], { view: () => focused });
    r.preview.setVisible(true);
    await r.render();
    // Cada posição que a prévia recebe (o jsdom não rola de verdade).
    const moves: number[] = [];
    Object.defineProperty(r.host, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set: (value: number) => void moves.push(value),
    });
    /**
     * Gesto e rolagem no editor. A sincronização pedida roda no quadro seguinte, antes do quadro
     * esperado aqui (os de `requestAnimationFrame` rodam na ordem em que foram pedidos).
     */
    const scroll = async (view: EditorView) => {
      view.dom.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      view.scrollDOM.dispatchEvent(new Event('scroll'));
      const { promise, resolve } = Promise.withResolvers<void>();
      requestAnimationFrame(() => resolve());
      await promise;
    };
    await scroll(left);
    expect(moves).toHaveLength(1);

    // O foco foi para o outro grupo: o view da esquerda rola sozinho até a nota nova renderizar.
    moves.length = 0;
    focused = right;
    await scroll(left);
    await scroll(right);
    expect(moves).toEqual([]);
    r.preview.onEditorChange('nota.md');
    await r.render(2000);
    moves.length = 0;
    await scroll(left);
    expect(moves).toEqual([]);
    await scroll(right);
    expect(moves).toHaveLength(1);
    left.destroy();
    right.destroy();
  });
});
