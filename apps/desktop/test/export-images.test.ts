// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ImageBlobCache } from '@simplemd/core';
import { createImageService } from '../src/editor/image-service';
import {
  decodeImages,
  EXPORT_IMAGE_BUDGET,
  exportImagesNotice,
  printImages,
} from '../src/export/images';
import { printBody } from '../src/export/pipeline';
import { fxR7, oversizeImage } from '../harness/fixtures/r7';
import { setup, type Harness } from './helpers';

const MiB = 1024 * 1024;
const NONE = () => false;
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

beforeAll(() => {
  Object.defineProperty(document, 'fonts', {
    value: { ready: Promise.resolve(), load: async () => [] },
    configurable: true,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Exporta a nota `path` como HTML pelo app e devolve o texto gravado. */
async function exportNote(h: Harness, path: string): Promise<string> {
  await h.app.sync.openFile(path);
  await h.app.exporter.exportHtml();
  const bytes = h.platform.saveTarget.write.mock.calls.at(-1)?.[1];
  if (!bytes) throw new Error('nada gravado');
  return new TextDecoder().decode(bytes);
}

const NOTE = [
  '# Exportação com imagens',
  '',
  '![bandeira](img/bandeira.png) ![foto](img/foto.jpg) ![anim](img/anim.gif)',
  '![webp](img/imagem.webp) ![desenho](img/desenho.svg) ![hostil](img/hostil.svg)',
  '',
  '![falso](img/falso-html.png) ![ausente](img/nao-existe.png) ![fora](../fora.png)',
  '',
  '![remota](https://exemplo.org/x.png)',
  '',
].join('\n');

describe('AC-EX.1 — HTML: imagens do vault como `data:` com o MIME verificado', () => {
  it('5 tipos embutidos; SVG como data:image/svg+xml em `<img>`; recusadas e ausentes = alt', async () => {
    const h = await setup({ ...fxR7(), 'exportar.md': NOTE });
    const html = await exportNote(h, 'exportar.md');
    const doc = parse(html);
    const srcs = [...doc.querySelectorAll('img')].map((img) => {
      const src = img.getAttribute('src') ?? '';
      return [
        img.getAttribute('alt'),
        src.startsWith('data:') ? src.slice(0, src.indexOf(',') + 1) : src,
      ];
    });
    expect(srcs).toEqual([
      ['bandeira', 'data:image/png;base64,'],
      ['foto', 'data:image/jpeg;base64,'],
      ['anim', 'data:image/gif;base64,'],
      ['webp', 'data:image/webp;base64,'],
      ['desenho', 'data:image/svg+xml;base64,'],
      ['hostil', 'data:image/svg+xml;base64,'],
      // Remota: como escrita no arquivo (R-10.5), não embutida.
      ['remota', 'https://exemplo.org/x.png'],
    ]);
    // Os bytes embutidos são os do arquivo.
    const png = fxR7()['img/bandeira.png'] as Uint8Array;
    const embedded = doc.querySelector('img[alt="bandeira"]')!.getAttribute('src')!;
    expect(Uint8Array.from(atob(embedded.split(',')[1]!), (c) => c.charCodeAt(0))).toEqual(png);
    // SVG nunca em linha: nenhum `<svg>`, `<script>` ou `foreignObject` no arquivo.
    expect(doc.querySelectorAll('svg, script, foreignObject').length).toBe(0);
    // Recusada (bytes trocados), ausente e fora do vault: só o texto alternativo.
    expect(doc.body.textContent).toContain('falso');
    expect(doc.body.textContent).toContain('ausente');
    expect(doc.body.textContent).toContain('fora');
    expect(
      h.app.store.getState().notices.find((n) => n.notice === 'export-images'),
    ).toBeUndefined();
  });

  it('total embutido > 50 MiB → as restantes saem como alt + aviso STR-183', async () => {
    const big = oversizeImage('png', 19 * MiB);
    const note = '![um](img/g1.png) ![dois](img/g2.png) ![tres](img/g3.png)\n';
    const h = await setup({
      'grandes.md': note,
      'img/g1.png': big,
      'img/g2.png': big,
      'img/g3.png': big,
    });
    const html = await exportNote(h, 'grandes.md');
    const dataImages = html.match(/src="data:image\/png;base64,/g) ?? [];
    // 19 MiB em base64 ≈ 25,3 MiB: a segunda já passaria de 50 MiB.
    expect(dataImages).toHaveLength(1);
    expect(html.length).toBeGreaterThan(25 * MiB);
    expect(html.length).toBeLessThan(EXPORT_IMAGE_BUDGET + MiB);
    expect(html).toContain('dois');
    expect(html).toContain('tres');
    expect(h.app.store.getState().notices.at(-1)).toMatchObject({
      kind: 'info',
      level: 'warn',
      notice: 'export-images',
      text: exportImagesNotice(2),
    });
    expect(exportImagesNotice(2)).toBe(
      'Algumas imagens não foram embutidas: o arquivo exportado chegou a 50 MB. 2 imagens ficaram só com o texto alternativo.',
    );
  }, 60_000);
});

describe('AC-EX.2 — PDF: imagens do vault na visualização de impressão por `blob:`', () => {
  it('a cache da janela entrega `blob:`; remota continua como alt', async () => {
    let n = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:simplemd/${++n}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const h = await setup({ ...fxR7(), 'exportar.md': NOTE });
    const cache = createImageService({ platform: h.platform, store: h.app.store });
    const printed = await printImages(NOTE, 'exportar.md', cache);
    const body = parse(await printBody(NOTE, NONE, printed.images)).body;
    const shown = [...body.querySelectorAll('img')].map((img) => [
      img.getAttribute('alt'),
      img.getAttribute('src'),
    ]);
    expect(shown).toEqual([
      ['bandeira', 'blob:simplemd/1'],
      ['foto', 'blob:simplemd/2'],
      ['anim', 'blob:simplemd/3'],
      ['webp', 'blob:simplemd/4'],
      ['desenho', 'blob:simplemd/5'],
      ['hostil', 'blob:simplemd/6'],
    ]);
    expect(body.textContent).toContain('remota');
    expect(body.querySelector('img[src^="https:"], img[src^="data:"]')).toBeNull();
    printed.release();
  });

  it('sem cache (sem editor montado): nenhuma imagem, só o texto alternativo', async () => {
    const printed = await printImages(NOTE, 'exportar.md', null);
    const body = parse(await printBody(NOTE, NONE, printed.images)).body;
    expect(body.querySelectorAll('img')).toHaveLength(0);
    expect(body.textContent).toContain('bandeira');
  });

  it('CR-S1-05: imagens da impressão ficam inscritas até `release()`; troca de pasta não pendura a espera', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:simplemd/x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    // Leitura que nunca termina: a espera só acaba pela troca de pasta (`reset`).
    const pending = new ImageBlobCache({ read: () => new Promise(() => {}) });
    const waiting = printImages('![a](a.png)\n', 'n.md', pending);
    await Promise.resolve();
    pending.reset();
    const printed = await waiting;
    expect(printed.images.map.get('a.png')).toEqual({ reason: 'refused' });
    // Pronta: inscrita (conta como mostrada para o LRU) até o fim do `print()`.
    const ready = new ImageBlobCache({
      read: async () => ({ bytes: new Uint8Array(4), mime: 'image/png', mtime: 1 }),
    });
    const shown = ready.request('a.png', 'n.md');
    await vi.waitFor(() => expect(shown.state.kind).toBe('ok'));
    const requests = vi.spyOn(ready, 'request');
    const held = await printImages('![a](a.png)\n', 'n.md', ready);
    expect(requests).toHaveBeenCalledTimes(1);
    ready.releaseOwner('n.md');
    expect(ready.stats().live).toBe(1); // a inscrição da impressão segura a entrada
    held.release();
    ready.releaseOwner('n.md');
    expect(ready.stats().live).toBe(0);
  });

  it('CR-S1-04: a impressão espera as `<img>` decodificarem (com teto) antes do painel', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<img alt="a"><img alt="b"><p>x</p>';
    const imgs = [...root.querySelectorAll('img')];
    const resolvers: Array<() => void> = [];
    for (const img of imgs)
      img.decode = () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
    let done = false;
    const waiting = decodeImages(root, 60_000).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(resolvers).toHaveLength(2);
    expect(done).toBe(false);
    resolvers[0]!();
    await Promise.resolve();
    expect(done).toBe(false);
    resolvers[1]!();
    await waiting;
    expect(done).toBe(true);
    // Decodificação que nunca termina: o teto libera o painel.
    imgs[0]!.decode = () => new Promise<void>(() => {});
    vi.useFakeTimers();
    try {
      const capped = decodeImages(root, 2_500);
      await vi.advanceTimersByTimeAsync(2_500);
      await expect(capped).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('CR-S1-04: "Exportar como PDF" decodifica as imagens antes de `print()`', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:simplemd/p');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const order: string[] = [];
    // O jsdom não tem `HTMLImageElement.decode`: instalado só neste teste.
    const decode = vi.fn(async () => void order.push('decode'));
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      value: decode,
      configurable: true,
      writable: true,
    });
    onTestFinished(() => {
      Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
    });
    const h = await setup({ ...fxR7(), 'exportar.md': '![b](img/bandeira.png)\n' });
    h.platform.print.mockImplementation(async () => void order.push('print'));
    await h.app.sync.openFile('exportar.md');
    const root = document.body.appendChild(document.createElement('div'));
    root.id = 'smd-print-root';
    const cache = createImageService({ platform: h.platform, store: h.app.store });
    vi.spyOn(h.app.plugins.editor, 'view', 'get').mockReturnValue({
      state: { facet: () => cache },
    } as never);
    await h.app.exporter.exportPdf();
    expect(decode).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['decode', 'print']);
    root.remove();
  });
});

describe('AC-EX.5 — EXPORT_CSP e HTML sem script', () => {
  /** A CSP fixada em `52de38b` (AppSec r2, APPSEC-R2-09). */
  const CSP_52DE38B =
    "default-src 'none'; img-src * file:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";

  it('o HTML exportado com imagens: uma CSP em <meta>, 0 `<script>`, 0 atributos on*', async () => {
    const h = await setup({ ...fxR7(), 'exportar.md': NOTE });
    const html = await exportNote(h, 'exportar.md');
    const doc = parse(html);
    const metas = doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
    // = a de 52de38b com `data:` acrescentado a img-src, e nenhuma outra diferença.
    expect([...metas].map((m) => m.getAttribute('content'))).toEqual([
      CSP_52DE38B.replace('img-src * file:', 'img-src * file: data:'),
    ]);
    expect(html.match(/<script/gi)).toBeNull();
    const handlers = [...doc.querySelectorAll('*')].flatMap((el) =>
      [...el.attributes].map((a) => a.name).filter((name) => /^on[a-z]+$/.test(name)),
    );
    expect(handlers).toEqual([]);
  });
});
