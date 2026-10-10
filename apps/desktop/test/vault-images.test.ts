// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  createMarkdownExtensions,
  IMAGE_CACHE_MAX_BYTES,
  ImageBlobCache,
  imageSourceFacet,
  noteContext,
  type ImageBytes,
} from '@simplemd/core';
import { MEMORY_ROOT } from '@simplemd/vault/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createImageService } from '../src/editor/image-service';
import type { Clock } from '../src/state/sync';
import { fxR7, fxR7Oversize } from '../harness/fixtures/r7';
import { setup, type Harness } from './helpers';

const MiB = 1024 * 1024;

/** Espião de `URL.createObjectURL`/`revokeObjectURL`: blobs vivos e bytes vivos. */
const blobs = { live: new Map<string, number>(), created: 0, revoked: 0, peak: 0 };
let liveBytes = 0;
beforeEach(() => {
  blobs.live.clear();
  blobs.created = blobs.revoked = blobs.peak = 0;
  liveBytes = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    const url = `blob:simplemd/${++blobs.created}`;
    const size = (blob as Blob).size;
    blobs.live.set(url, size);
    liveBytes += size;
    blobs.peak = Math.max(blobs.peak, liveBytes);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    liveBytes -= blobs.live.get(url) ?? 0;
    if (blobs.live.delete(url)) blobs.revoked++;
  });
});

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** Relógio manual: guarda os temporizadores da sondagem e dispara quando o teste manda. */
function manualClock(): Clock & { pending: Array<{ cb: () => void; ms: number }>; fire(): void } {
  const pending: Array<{ cb: () => void; ms: number; id: number }> = [];
  let id = 0;
  return {
    pending,
    now: () => 0,
    setTimeout(cb, ms) {
      pending.push({ cb, ms, id: ++id });
      return id;
    },
    clearTimeout(handle) {
      const at = pending.findIndex((t) => t.id === handle);
      if (at >= 0) pending.splice(at, 1);
    },
    fire() {
      for (const timer of pending.splice(0)) timer.cb();
    },
  };
}

function mount(h: Harness, doc: string, notePath: string, clock?: Clock) {
  const images = createImageService({
    platform: h.platform,
    store: h.app.store,
    ...(clock ? { clock } : {}),
  });
  const parent = document.body.appendChild(document.createElement('div'));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        createMarkdownExtensions(),
        noteContext.of({ path: notePath }),
        imageSourceFacet.of(images),
      ],
    }),
  });
  views.push(view);
  return { view, images };
}

/** Widgets de imagem (`data-state`, `alt`/`src` do `<img>` ou o texto da recusa), pelo texto do nó. */
function widgets(view: EditorView) {
  return [...view.contentDOM.querySelectorAll<HTMLElement>('[data-testid="cm-image"]')].map(
    (el) => {
      const img = el.querySelector('img');
      return {
        state: el.dataset.state,
        alt: img?.getAttribute('alt') ?? null,
        src: img?.getAttribute('src') ?? null,
        text: el.querySelector('.cm-md-img-text')?.textContent ?? null,
      };
    },
  );
}

const settled = (view: EditorView) =>
  vi.waitFor(() => expect(widgets(view).filter((w) => w.state === 'loading')).toEqual([]));

/** Leituras de imagem que chegaram à porta (caminhos relativos ao vault). */
const portReads = (h: Harness) =>
  h.port
    .calls()
    .filter((c) => c.op === 'readImage')
    .map((c) => c.abs.slice(MEMORY_ROOT.length + 1));

const doc = (lines: string[]) => `${lines.join('\n')}\n\nfim\n`;

describe('AC-I1.6 — os 5 tipos e as formas de caminho do FX-R7 aparecem por `blob:` com o alt', () => {
  it('png, jpg, gif, webp, svg; relativo, /raiz, ../ dentro do vault, <com espaços>, %20', async () => {
    const h = await setup(fxR7());
    const { view } = mount(
      h,
      doc([
        '![bandeira PNG](../img/bandeira.png "PNG") ![foto JPG](../img/foto.jpg) ![animação GIF](../img/anim.gif)',
        '![imagem WEBP](/img/imagem.webp) ![desenho SVG](/img/desenho.svg)',
        '![espaços](<../img/com espaços.png>) ![por cento](../img/com%20espa%C3%A7os.png)',
      ]),
      'notas/relativo.md',
    );
    await settled(view);
    expect(widgets(view)).toEqual(
      [
        'bandeira PNG',
        'foto JPG',
        'animação GIF',
        'imagem WEBP',
        'desenho SVG',
        'espaços',
        'por cento',
      ].map((alt) => ({ state: 'ok', alt, src: expect.stringMatching(/^blob:/), text: null })),
    );
    // MIME do tipo verificado em cada blob.
    const mimes = vi.mocked(URL.createObjectURL).mock.calls.map(([b]) => (b as Blob).type);
    expect(new Set(mimes)).toEqual(
      new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']),
    );
    // Mesma imagem com dois caminhos (espaços e %20) = uma leitura.
    expect(portReads(h).filter((p) => p === 'img/com espaços.png')).toHaveLength(1);
  });
});

describe('AC-I1.7 — remotas e outros esquemas ficam texto, 0 leituras', () => {
  it('https:, data:, file: → nenhum widget, nenhuma leitura, o cru fica no texto', async () => {
    const h = await setup(fxR7());
    const text = doc([
      '![remota](https://exemplo.org/x.png) ![dados](data:image/png;base64,iVBORw0KGgo=) ![arquivo](file:///tmp/x.png)',
    ]);
    const { view } = mount(h, text, 'imagens.md');
    // O widget nasce no `toDOM` (síncrono): sem caminho do vault, nada é pedido.
    expect(widgets(view)).toEqual([]);
    expect(portReads(h)).toEqual([]);
    expect(blobs.created).toBe(0);
    expect(view.contentDOM.textContent).toContain('https://exemplo.org/x.png');
  });
});

describe('AC-I1.8 — recusas visíveis', () => {
  it('fora do vault, .git/, .simplemd/ e link simbólico → "Imagem fora da pasta", 0 leituras fora', async () => {
    const h = await setup({ ...fxR7(), '../fora.png': new Uint8Array([1]) });
    h.port.seed({ 'segredo/x.png': fxR7()['img/bandeira.png'] as Uint8Array });
    h.port.symlink('img/atalho.png', `${MEMORY_ROOT}/segredo/x.png`);
    const { view } = mount(
      h,
      doc([
        '![fora do vault](../fora.png) ![git](.git/x.png) ![config](.simplemd/x.png) ![link](img/atalho.png)',
      ]),
      'imagens.md',
    );
    await settled(view);
    expect(widgets(view).map((w) => [w.state, w.text])).toEqual(
      Array(4).fill(['outside', 'Imagem fora da pasta']),
    );
    expect(portReads(h)).toEqual([]);
  });

  it('`.png` com bytes de HTML, SVG ou JPEG → "Tipo de imagem não suportado"; .bmp sem leitura', async () => {
    const h = await setup(fxR7());
    const { view } = mount(
      h,
      doc([
        '![html](img/falso-html.png) ![svg](img/falso-svg.png) ![jpeg](img/falso-jpeg.png) ![bmp](img/documento.bmp)',
      ]),
      'imagens.md',
    );
    await settled(view);
    expect(widgets(view).map((w) => [w.state, w.text])).toEqual(
      Array(4).fill(['bad-type', 'Tipo de imagem não suportado']),
    );
    expect(portReads(h).sort()).toEqual([
      'img/falso-html.png',
      'img/falso-jpeg.png',
      'img/falso-svg.png',
    ]);
    expect(blobs.created).toBe(0);
  });

  it('arquivo ausente → "Imagem não encontrada: <caminho>"', async () => {
    const h = await setup(fxR7());
    const { view } = mount(h, doc(['![ausente](img/nao-existe.png)']), 'imagens.md');
    await settled(view);
    expect(widgets(view)).toEqual([
      {
        state: 'not-found',
        alt: null,
        src: null,
        text: 'Imagem não encontrada: img/nao-existe.png',
      },
    ]);
  });
});

describe('AC-I1.9 — limites e ciclo de vida dos blobs', () => {
  it('raster 20 MiB + 1 e SVG 2 MiB + 1 → mensagem de limite; a porta entrega 0 bytes (≤ limite + 1)', async () => {
    const h = await setup({ ...fxR7(), ...fxR7Oversize() });
    const { view } = mount(h, doc(['![g](img/grande.png) ![s](img/grande.svg)']), 'imagens.md');
    await settled(view);
    expect(widgets(view).map((w) => [w.state, w.text])).toEqual([
      ['too-large', 'Imagem maior que 20 MB'],
      ['too-large', 'SVG maior que 2 MB'],
    ]);
    const delivered = h.port.calls().filter((c) => c.op === 'readImage' || c.op === 'readFile');
    expect(delivered.filter((c) => c.abs.includes('grande'))).toEqual([]);
    expect(blobs.created).toBe(0);
  });

  it('210 MiB de imagens mostradas: nunca mais que 200 MiB de blobs vivos (LRU revoga)', async () => {
    const size = Math.ceil(19.1 * MiB);
    const read = async (path: string): Promise<ImageBytes> => ({
      bytes: new Uint8Array(size),
      mime: 'image/png',
      mtime: Number(path.replace(/\D/g, '')),
    });
    const cache = new ImageBlobCache({ read });
    const handles = Array.from({ length: 11 }, (_, i) => cache.request(`img/${i}.png`, 'n.md'));
    const states = handles.map((handle) => {
      const seen: string[] = [];
      handle.subscribe((state) => seen.push(state.kind));
      return seen;
    });
    await vi.waitFor(() => expect(blobs.created).toBe(11));
    expect(11 * size).toBeGreaterThan(210 * MiB - 1);
    expect(blobs.peak).toBeLessThanOrEqual(IMAGE_CACHE_MAX_BYTES);
    expect(cache.stats().bytes).toBeLessThanOrEqual(IMAGE_CACHE_MAX_BYTES);
    expect(cache.stats().bytes).toBe(liveBytes);
    expect(blobs.revoked).toBeGreaterThan(0);
    // A mais antiga (mostrada) volta a "carregando" para ser pedida de novo no próximo desenho.
    expect(states[0]).toEqual(['ok', 'loading']);
  });

  it('trocar de pasta → 0 blobs vivos da anterior; fechar a aba libera as imagens dela', async () => {
    const h = await setup(fxR7());
    const { view, images } = mount(
      h,
      doc(['![a](img/bandeira.png) ![b](img/foto.jpg)']),
      'imagens.md',
    );
    await settled(view);
    expect(blobs.live.size).toBe(2);
    // Fechar a aba: a imagem só dela (sem widget na tela) é revogada pelo serviço.
    await h.app.sync.openFile('links.md');
    images.request('img/anim.gif', 'links.md');
    await vi.waitFor(() => expect(blobs.live.size).toBe(3));
    await h.app.sync.closeTab('links.md');
    expect(blobs.live.size).toBe(2);
    // Trocar de pasta: tudo revogado.
    h.app.store.setState({ handle: null });
    expect(blobs.live.size).toBe(0);
    expect(images.stats()).toEqual({ live: 0, bytes: 0 });
  });
});

describe('AC-I1.10 — SVG hostil só por `<img>`', () => {
  it('img/hostil.svg aparece por `<img src="blob:">`; o conteúdo nunca entra no DOM', async () => {
    const h = await setup(fxR7());
    const { view } = mount(h, doc(['![hostil](img/hostil.svg)']), 'imagens.md');
    await settled(view);
    expect(widgets(view)).toEqual([
      { state: 'ok', alt: 'hostil', src: expect.stringMatching(/^blob:/), text: null },
    ]);
    expect(document.querySelector('script, foreignObject, svg image')).toBeNull();
    expect(Object.keys(window).filter((k) => k.startsWith('__svg'))).toEqual([]);
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe('image/svg+xml');
  });
});

describe('AC-I1.11 — mudança externa da imagem', () => {
  it('com observador: escrita externa → nova URL em ≤ 2 s; remoção → "Imagem não encontrada"', async () => {
    const h = await setup(fxR7());
    const { view } = mount(h, doc(['![b](img/bandeira.png)']), 'imagens.md');
    await settled(view);
    const first = widgets(view)[0]?.src;
    const started = performance.now();
    const png = fxR7()['img/bandeira.png'] as Uint8Array;
    h.port.externalWrite('img/bandeira.png', Uint8Array.of(...png, 0));
    await vi.waitFor(() => expect(widgets(view)[0]?.src).not.toBe(first), { timeout: 2000 });
    expect(performance.now() - started).toBeLessThanOrEqual(2000);
    expect(blobs.live.has(first!)).toBe(false);
    h.port.remove('img/bandeira.png');
    await vi.waitFor(
      () =>
        expect(widgets(view)[0]).toMatchObject({
          state: 'not-found',
          text: 'Imagem não encontrada: img/bandeira.png',
        }),
      { timeout: 2000 },
    );
  });

  it('sem observador: a sondagem de 1.000 ms recarrega a mudada e marca a removida', async () => {
    const h = await setup(fxR7(), { watch: false });
    const clock = manualClock();
    const { view } = mount(
      h,
      doc(['![b](img/bandeira.png) ![f](img/foto.jpg)']),
      'imagens.md',
      clock,
    );
    await settled(view);
    expect(clock.pending.map((t) => t.ms)).toEqual([1000]);
    const before = widgets(view).map((w) => w.src);
    const png = fxR7()['img/bandeira.png'] as Uint8Array;
    h.port.externalWrite('img/bandeira.png', Uint8Array.of(...png, 0));
    h.port.remove('img/foto.jpg');
    clock.fire();
    await vi.waitFor(() => {
      const [b, f] = widgets(view);
      expect(b?.state).toBe('ok');
      expect(b?.src).not.toBe(before[0]);
      expect(f).toMatchObject({ state: 'not-found' });
    });
    // Continua armada enquanto houver entradas.
    await vi.waitFor(() => expect(clock.pending.map((t) => t.ms)).toEqual([1000]));
  });

  it('sem imagens na cache: nenhum temporizador de sondagem', async () => {
    const h = await setup(fxR7(), { watch: false });
    const clock = manualClock();
    mount(h, doc(['sem imagens']), 'imagens.md', clock);
    await Promise.resolve();
    expect(clock.pending).toEqual([]);
  });
});
