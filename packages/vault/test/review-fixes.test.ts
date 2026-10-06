import { describe, expect, test } from 'vitest';
import {
  ConflictError,
  LocalFsProvider,
  decodeDocument,
  encodeDocument,
  type FsPort,
} from '../src/index';
import { MemoryFsPort } from '../src/testing/index';

describe('CR-05: arquivo só com CR', () => {
  test('é reconhecido como CR (não misto) e faz ida e volta byte a byte', () => {
    const { doc, format } = decodeDocument('a\rb\rc\r');
    expect(doc).toBe('a\nb\nc\n');
    expect(format).toEqual({ eol: '\r', bom: false, mixed: false });
    expect(encodeDocument(doc, format)).toBe('a\rb\rc\r');
    expect(encodeDocument('a\nb\nX', format)).toBe('a\rb\rX');
  });

  test('misto com maioria CR unifica em CR e sinaliza mixed', () => {
    const { format } = decodeDocument('a\rb\rc\r\nd');
    expect(format).toEqual({ eol: '\r', bom: false, mixed: true });
  });
});

describe('CR-06: outro leitor viu uma versão mais nova que a base de quem grava', () => {
  test('a gravação com o mtime antigo vira conflito, mesmo com o disco igual ao último lido', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'nota.md': 'v1' });
    const provider = new LocalFsProvider(port);
    const handle = await provider.open();
    const { mtime: base } = await provider.read(handle, 'nota.md');
    port.externalWrite('nota.md', 'externo');
    // Um segundo leitor (prévia, índice, plugin…) lê a versão externa.
    await provider.read(handle, 'nota.md');
    await expect(provider.write(handle, 'nota.md', 'app', base)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(port.readText('nota.md')).toBe('externo');
  });

  test('toque só de mtime (D-4) continua sem conflito', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'nota.md': 'v1' });
    const provider = new LocalFsProvider(port);
    const handle = await provider.open();
    const { mtime } = await provider.read(handle, 'nota.md');
    port.touch('nota.md');
    await expect(provider.write(handle, 'nota.md', 'v2', mtime)).resolves.toHaveProperty('mtime');
    expect(port.readText('nota.md')).toBe('v2');
  });
});

describe('CR-15: limite de leituras de diretório concorrentes', () => {
  test('nunca passa de 16 readDir simultâneos', async () => {
    const memory = new MemoryFsPort();
    const files: Record<string, string> = {};
    for (let d = 0; d < 60; d++) files[`p${d}/a.md`] = '';
    memory.seed(files);
    let active = 0;
    let peak = 0;
    const port: FsPort = {
      pickDirectory: () => memory.pickDirectory(),
      join: (r, p) => memory.join(r, p),
      lstat: (a) => memory.lstat(a),
      readFile: (a) => memory.readFile(a),
      writeFile: (a, d, m) => memory.writeFile(a, d, m),
      mkdirp: (a) => memory.mkdirp(a),
      async readDir(abs) {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        const items = await memory.readDir(abs);
        active--;
        return items;
      },
    };
    const provider = new LocalFsProvider(port);
    const entries = await provider.list(await provider.open());
    expect(entries).toHaveLength(120);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(16);
  });
});
