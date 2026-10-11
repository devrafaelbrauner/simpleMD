// r7 arch-backend §1.3 / §5.2–§5.3 (R-I1.7, NFR-45; dados de AC-I1.6…I1.11): `readImage` do
// `LocalFsProvider` sobre a porta em memória. Guarda de caminho antes de qualquer chamada, teto pelo
// `lstat` com 0 leituras, links recusados sem leitura, bytes mágicos, MIME e `mtime` do `lstat`.
import { describe, expect, test } from 'vitest';
import { IMAGE_MAX_BYTES, LocalFsProvider, VaultError, type FsPort } from '../src/index';
import { MEMORY_ROOT, MemoryFsPort } from '../src/testing/index';
import { PERF_GATE } from '../../core/test/helpers/perf';

const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d);
const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

async function setup(files: Record<string, string | Uint8Array>) {
  const port = new MemoryFsPort();
  port.seed(files);
  const provider = new LocalFsProvider(port);
  const handle = await provider.open();
  port.resetCalls();
  const reads = () =>
    port.calls().filter((c) => c.op === 'readImage' || c.op === 'readFile').length;
  return { port, provider, handle, reads };
}

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (error: unknown) => (error instanceof VaultError ? error.code : `RAW ${String(error)}`),
  );

describe('readImage (LocalFsProvider + MemoryFsPort)', () => {
  test('lê png/jpeg/gif/webp/svg com tipo, MIME, tamanho e mtime do lstat, pela porta readImage', async () => {
    const { port, provider, handle } = await setup({
      'img/a.png': PNG,
      'b.JPG': JPEG,
      'c.gif': 'GIF89a\x01\x00',
      'd.webp': 'RIFF\x00\x00\x00\x00WEBPVP8 ',
      'e.svg': SVG,
    });
    const png = await provider.readImage(handle, 'img/a.png');
    expect(png).toMatchObject({ kind: 'png', mime: 'image/png', size: PNG.length });
    expect([...png.bytes]).toEqual([...PNG]);
    const stat = await port.lstat(`${MEMORY_ROOT}/img/a.png`);
    expect(png.mtime).toBe(stat?.mtime);
    expect((await provider.readImage(handle, 'b.JPG')).mime).toBe('image/jpeg');
    expect((await provider.readImage(handle, 'c.gif')).mime).toBe('image/gif');
    expect((await provider.readImage(handle, 'd.webp')).mime).toBe('image/webp');
    // SVG hostil sai como bytes com MIME de imagem (AC-I1.10): o app só o usa em <img src=blob:>.
    expect((await provider.readImage(handle, 'e.svg')).mime).toBe('image/svg+xml');
    const ops = port.calls().map((c) => c.op);
    expect(ops.filter((op) => op === 'readImage')).toHaveLength(5);
    expect(ops).not.toContain('readFile');
  });

  test('porta sem readImage (Node, testes r1/r2) cai no readFile e confere o mesmo', async () => {
    const memory = new MemoryFsPort();
    memory.seed({ 'a.png': PNG, 'b.png': JPEG });
    const port: FsPort = {
      pickDirectory: () => memory.pickDirectory(),
      join: (root, rel) => memory.join(root, rel),
      readDir: (abs) => memory.readDir(abs),
      lstat: (abs) => memory.lstat(abs),
      readFile: (abs) => memory.readFile(abs),
      writeFile: (abs, data, mode) => memory.writeFile(abs, data, mode),
      mkdirp: (abs) => memory.mkdirp(abs),
    };
    const provider = new LocalFsProvider(port);
    const handle = await provider.open();
    expect((await provider.readImage(handle, 'a.png')).kind).toBe('png');
    expect(await codeOf(provider.readImage(handle, 'b.png'))).toBe('UNSUPPORTED_IMAGE');
    expect(memory.calls().filter((c) => c.op === 'readFile')).toHaveLength(2);
  });

  test('extensão × bytes trocados → UNSUPPORTED_IMAGE (AC-I1.8)', async () => {
    const { provider, handle } = await setup({
      'jpeg.png': JPEG,
      'html.png': '<!doctype html><script>alert(1)</script>',
      'svg.png': SVG,
      'png.svg': PNG,
      'html.svg': '<!doctype html><svg/>',
    });
    for (const path of ['jpeg.png', 'html.png', 'svg.png', 'png.svg', 'html.svg'])
      expect(await codeOf(provider.readImage(handle, path)), path).toBe('UNSUPPORTED_IMAGE');
  });

  test('extensão fora dos 5 tipos → UNSUPPORTED_IMAGE com 0 chamadas à porta', async () => {
    // F-01: extensões que são chaves do protótipo também caem antes de qualquer chamada.
    const { port, provider, handle } = await setup({
      'a.bmp': 'BM',
      'nota.md': '# n',
      'x.constructor': Uint8Array.of(0x89, 0x50, 0x4e, 0x47),
    });
    for (const path of [
      'a.bmp',
      'nota.md',
      'x.svgz',
      'semextensao',
      'x.constructor',
      'x.__proto__',
      'x.toString',
      'x.hasOwnProperty',
    ])
      expect(await codeOf(provider.readImage(handle, path)), path).toBe('UNSUPPORTED_IMAGE');
    expect(port.calls()).toEqual([]);
  });

  test('teto pelo lstat: teto + 1 → TOO_LARGE com 0 leituras (AC-I1.9, NFR-45); teto exato lê', async () => {
    const big = new Uint8Array(IMAGE_MAX_BYTES.raster + 1);
    big.set(PNG);
    const svgBig = new Uint8Array(IMAGE_MAX_BYTES.svg + 1).fill(0x20);
    svgBig.set(new TextEncoder().encode('<svg>'));
    const { provider, handle, reads } = await setup({
      'grande.png': big,
      'exata.png': big.subarray(0, IMAGE_MAX_BYTES.raster),
      'grande.svg': svgBig,
    });
    const started = performance.now();
    expect(await codeOf(provider.readImage(handle, 'grande.png'))).toBe('TOO_LARGE');
    expect(await codeOf(provider.readImage(handle, 'grande.svg'))).toBe('TOO_LARGE');
    const elapsed = performance.now() - started;
    // Estrutural (sempre): a recusa vem do lstat, com 0 leituras; o tempo de relógio só vale com
    // SIMPLEMD_PERF=1 (runners compartilhados do CI).
    expect(reads()).toBe(0);
    if (PERF_GATE) expect(elapsed).toBeLessThan(50);
    expect((await provider.readImage(handle, 'exata.png')).size).toBe(IMAGE_MAX_BYTES.raster);
    expect(reads()).toBe(1);
  });

  test('porta que entrega mais que o teto (arquivo cresceu depois do lstat) → TOO_LARGE', async () => {
    const { port, provider, handle } = await setup({ 'a.png': PNG });
    const big = new Uint8Array(IMAGE_MAX_BYTES.raster + 1);
    big.set(PNG);
    port.readImage = async () => big;
    expect(await codeOf(provider.readImage(handle, 'a.png'))).toBe('TOO_LARGE');
  });

  test('link final ou intermediário → OUTSIDE_VAULT com 0 leituras (AC-I1.8)', async () => {
    const { port, provider, handle, reads } = await setup({ 'a.png': PNG });
    port.symlink('atalho.png', '/fora/x.png');
    port.symlink('pasta', '/fora');
    port.resetCalls();
    expect(await codeOf(provider.readImage(handle, 'atalho.png'))).toBe('OUTSIDE_VAULT');
    expect(await codeOf(provider.readImage(handle, 'pasta/x.png'))).toBe('OUTSIDE_VAULT');
    expect(reads()).toBe(0);
  });

  test('.git/, .env, oculto e .simplemd/ recusados com 0 chamadas; ../ e absoluto → OUTSIDE_VAULT', async () => {
    const { port, provider, handle } = await setup({
      '.git/x.png': PNG,
      '.simplemd/x.png': PNG,
      'a/.oculta.png': PNG,
    });
    const table: Record<string, string> = {
      '.git/x.png': 'INVALID_PATH',
      '.env': 'INVALID_PATH',
      'a/.oculta.png': 'INVALID_PATH',
      '.simplemd/x.png': 'PERMISSION_DENIED',
      '.simplemd/themes/t/x.png': 'PERMISSION_DENIED',
      '../x.png': 'OUTSIDE_VAULT',
      'a/../../x.png': 'OUTSIDE_VAULT',
      '/etc/x.png': 'OUTSIDE_VAULT',
      'C:/x.png': 'OUTSIDE_VAULT',
      'a\\x.png': 'INVALID_PATH',
    };
    for (const [path, code] of Object.entries(table))
      expect(await codeOf(provider.readImage(handle, path)), path).toBe(code);
    expect(port.calls()).toEqual([]);
  });

  test('ausente → NOT_FOUND; pasta → INVALID_PATH; falha da porta passa adiante', async () => {
    const { port, provider, handle } = await setup({ 'p.png/x.md': 'x', 'ok.png': PNG });
    expect(await codeOf(provider.readImage(handle, 'nada.png'))).toBe('NOT_FOUND');
    expect(await codeOf(provider.readImage(handle, 'p.png'))).toBe('INVALID_PATH');
    port.failNext('readImage', 'IO');
    expect(await codeOf(provider.readImage(handle, 'ok.png'))).toBe('IO');
  });
});
