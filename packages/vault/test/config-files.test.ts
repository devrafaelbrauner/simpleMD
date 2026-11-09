// r7 arch-backend §1.13 (D-R7-B18; R-I5.2, R-I6.7): arquivos de configuração do vault lidos por
// plugins internos. Lista fechada, só leitura, teto pelo `lstat` com 0 leituras, `.cjs`/`.yaml`
// nunca tocados, e o `watch` deixa passar exatamente os 3 caminhos da lista.
// r32a (AC-R32A-2): a classe dos dicionários da pasta, `.simplemd/dictionaries/<nome>.txt`, é lida e
// gravada pelo provider dentro do teto de 10 MiB, e os eventos dela passam pelo `watch`.
import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import {
  LocalFsProvider,
  VAULT_CONFIG_FILES,
  VaultError,
  isVaultConfigFile,
  type VaultConfigFile,
  type VaultWatchEvent,
} from '../src/index';
import { MemoryFsPort } from '../src/testing/index';

// O sha256 puro-JS (@noble/hashes) fica ~12× mais lento sob a cobertura v8 do CI: os 2 hashes de
// 10 MiB do "teto de 10 MiB" passavam de 5 s no Linux (r32d). Mesmo digest (content-base.test.ts),
// calculado em C++ pelo Node; o mock de `../src/hash` alcança o `./hash` do provider.
vi.mock('../src/hash', () => ({
  sha256Hex: (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
}));

async function setup(files: Record<string, string | Uint8Array> = {}) {
  const port = new MemoryFsPort();
  port.seed(files);
  const provider = new LocalFsProvider(port);
  const handle = await provider.open();
  port.resetCalls();
  return { port, provider, handle };
}

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (error: unknown) => (error instanceof VaultError ? error.code : `RAW ${String(error)}`),
  );

describe('config-files: lista fechada', () => {
  test('3 nomes com tetos de 64/64/256 KiB', () => {
    expect(VAULT_CONFIG_FILES).toEqual({
      '.markdownlint.json': 64 * 1024,
      '.markdownlint.jsonc': 64 * 1024,
      '.simplemd/latex-snippets.json': 256 * 1024,
    });
    for (const name of [
      '.markdownlint.yaml',
      '.markdownlint.cjs',
      'a/.markdownlint.json',
      'toString',
    ])
      expect(isVaultConfigFile(name), name).toBe(false);
  });
});

describe('readConfigFile', () => {
  test('ausente → null (caso normal), com só lstat', async () => {
    const { port, provider, handle } = await setup();
    expect(await provider.readConfigFile(handle, '.markdownlint.json')).toBeNull();
    expect(port.calls().every((c) => c.op === 'lstat')).toBe(true);
  });

  test('presente → texto e mtime', async () => {
    const { port, provider, handle } = await setup({
      '.markdownlint.jsonc': '{ // c\n "MD013": false }',
      '.simplemd/latex-snippets.json': '[]',
    });
    const read = await provider.readConfigFile(handle, '.markdownlint.jsonc');
    expect(read?.text).toBe('{ // c\n "MD013": false }');
    expect(read?.mtime).toBe((await port.lstat('/vault/.markdownlint.jsonc'))?.mtime);
    expect((await provider.readConfigFile(handle, '.simplemd/latex-snippets.json'))?.text).toBe(
      '[]',
    );
  });

  test('teto + 1 → TOO_LARGE com 0 leituras', async () => {
    const { port, provider, handle } = await setup({
      '.markdownlint.json': ' '.repeat(64 * 1024 + 1),
      '.simplemd/latex-snippets.json': ' '.repeat(256 * 1024 + 1),
    });
    expect(await codeOf(provider.readConfigFile(handle, '.markdownlint.json'))).toBe('TOO_LARGE');
    expect(await codeOf(provider.readConfigFile(handle, '.simplemd/latex-snippets.json'))).toBe(
      'TOO_LARGE',
    );
    expect(port.calls().filter((c) => c.op === 'readFile')).toHaveLength(0);
  });

  test('não UTF-8 → NOT_UTF8; link → OUTSIDE_VAULT; pasta → INVALID_PATH', async () => {
    const { port, provider, handle } = await setup({
      '.markdownlint.json': Uint8Array.of(0x7b, 0xff, 0x7d),
      '.markdownlint.jsonc/x.md': 'x',
    });
    port.symlink('.simplemd/latex-snippets.json', '/fora/snippets.json');
    expect(await codeOf(provider.readConfigFile(handle, '.markdownlint.json'))).toBe('NOT_UTF8');
    expect(await codeOf(provider.readConfigFile(handle, '.markdownlint.jsonc'))).toBe(
      'INVALID_PATH',
    );
    expect(await codeOf(provider.readConfigFile(handle, '.simplemd/latex-snippets.json'))).toBe(
      'OUTSIDE_VAULT',
    );
  });

  test('nome fora da lista (chamada sem tipos) → PERMISSION_DENIED com 0 chamadas; .cjs nunca tocado', async () => {
    const { port, provider, handle } = await setup({ '.markdownlint.cjs': 'module.exports={}' });
    for (const name of ['.markdownlint.cjs', '.markdownlint.yaml', '.env', '../x.json'])
      expect(await codeOf(provider.readConfigFile(handle, name as VaultConfigFile)), name).toBe(
        'PERMISSION_DENIED',
      );
    expect(port.calls()).toEqual([]);
  });

  test('gravar um arquivo da lista → PERMISSION_DENIED com 0 chamadas', async () => {
    const { port, provider, handle } = await setup({ '.simplemd/latex-snippets.json': '[]' });
    for (const name of Object.keys(VAULT_CONFIG_FILES)) {
      expect(await codeOf(provider.write(handle, name, '{}')), name).toBe('PERMISSION_DENIED');
      expect(
        await codeOf(provider.writeIfUnchanged(handle, name, '{}', { mtime: 1, text: '[]' })),
        name,
      ).toBe('PERMISSION_DENIED');
    }
    expect(port.calls()).toEqual([]);
    expect(port.readText('.simplemd/latex-snippets.json')).toBe('[]');
  });
});

describe('watch: os 3 arquivos da lista passam; outros ocultos continuam filtrados', () => {
  test('evento só para os nomes da lista', async () => {
    const { port, provider, handle } = await setup({ 'a.md': 'a' });
    const events: VaultWatchEvent[] = [];
    const stop = provider.watch(handle, (event) => events.push(event));
    for (const path of [
      '.markdownlint.json',
      '.markdownlint.jsonc',
      '.simplemd/latex-snippets.json',
      '.markdownlint.cjs',
      '.markdownlint.yaml',
      '.git/config',
      '.simplemd/config.json',
      'a/.markdownlint.json',
    ])
      port.externalWrite(path, '{}');
    const paths = events.flatMap((e) => (e.kind === 'change' ? e.paths : []));
    expect(new Set(paths)).toEqual(
      new Set(['.markdownlint.json', '.markdownlint.jsonc', '.simplemd/latex-snippets.json']),
    );
    stop();
  });
});

describe('dicionários da pasta (r32a, AC-R32A-2)', () => {
  const MAX = 10 * 1024 * 1024;
  const PATH = '.simplemd/dictionaries/medicos.txt';

  test('cria (com a pasta), lê e regrava com a base; base velha → CONFLICT sem gravar', async () => {
    const { port, provider, handle } = await setup();
    await provider.write(handle, PATH, 'colecistectomia\n');
    expect(
      port
        .calls()
        .filter((c) => c.op === 'mkdirp')
        .map((c) => c.abs),
    ).toEqual(['/vault/.simplemd/dictionaries']);
    const read = await provider.read(handle, PATH);
    expect(read.text).toBe('colecistectomia\n');
    await provider.writeIfUnchanged(handle, PATH, 'colecistectomia\nexceção\n', read);
    expect(port.readText(PATH)).toBe('colecistectomia\nexceção\n');
    expect(await codeOf(provider.writeIfUnchanged(handle, PATH, 'outro\n', read))).toBe('CONFLICT');
    expect(await codeOf(provider.write(handle, PATH, 'outro\n'))).toBe('ALREADY_EXISTS');
    expect(port.readText(PATH)).toBe('colecistectomia\nexceção\n');
    port.symlink('.simplemd/dictionaries/link.txt', '/fora/termos.txt');
    expect(await codeOf(provider.read(handle, '.simplemd/dictionaries/link.txt'))).toBe(
      'OUTSIDE_VAULT',
    );
  });

  test('teto de 10 MiB: o teto passa; teto + 1 → TOO_LARGE sem ler nem gravar', async () => {
    const { port, provider, handle } = await setup({
      '.simplemd/dictionaries/cheio.txt': 'a'.repeat(MAX),
      '.simplemd/dictionaries/grande.txt': 'a'.repeat(MAX + 1),
    });
    expect((await provider.read(handle, '.simplemd/dictionaries/cheio.txt')).text).toHaveLength(
      MAX,
    );
    port.resetCalls();
    const big = '.simplemd/dictionaries/grande.txt';
    expect(await codeOf(provider.read(handle, big))).toBe('TOO_LARGE');
    expect(await codeOf(provider.readBytes(handle, big))).toBe('TOO_LARGE');
    expect(port.calls().filter((c) => c.op === 'readFile')).toEqual([]);
    port.resetCalls();
    const over = 'a'.repeat(MAX + 1);
    expect(await codeOf(provider.write(handle, '.simplemd/dictionaries/novo.txt', over))).toBe(
      'TOO_LARGE',
    );
    const base = { mtime: 1, text: 'a'.repeat(MAX) };
    expect(
      await codeOf(
        provider.writeIfUnchanged(handle, '.simplemd/dictionaries/cheio.txt', over, base),
      ),
    ).toBe('TOO_LARGE');
    expect(port.calls()).toEqual([]);
    await provider.write(handle, '.simplemd/dictionaries/novo.txt', 'a'.repeat(MAX));
    expect(port.readBytes('.simplemd/dictionaries/novo.txt')).toHaveLength(MAX);
  });

  test('só `<nome>.txt` direto na pasta: o resto → INVALID_PATH com 0 chamadas', async () => {
    const { port, provider, handle } = await setup();
    for (const path of [
      '.simplemd/dictionaries/sub/x.txt',
      '.simplemd/dictionaries/x.md',
      '.simplemd/dictionaries/.oculto.txt',
      '.simplemd/dictionaries/con.txt',
      '.simplemd/x.txt',
      'dictionaries/x.txt',
      'x.txt',
    ]) {
      expect(await codeOf(provider.write(handle, path, 'x\n')), path).toBe('INVALID_PATH');
      expect(await codeOf(provider.read(handle, path)), path).toBe('INVALID_PATH');
    }
    expect(port.calls()).toEqual([]);
  });

  test('watch: os dicionários da pasta passam; subpasta, outra extensão e ocultos continuam fora', async () => {
    const { port, provider, handle } = await setup({ 'a.md': 'a' });
    const events: VaultWatchEvent[] = [];
    const stop = provider.watch(handle, (event) => events.push(event));
    for (const path of [
      '.simplemd/dictionaries/pessoal.txt',
      '.simplemd/dictionaries/Lista Antiga.TXT',
      '.simplemd/dictionaries/.oculto.txt',
      '.simplemd/dictionaries/.~simplemd-0123456789abcdef.tmp',
      '.simplemd/dictionaries/sub/x.txt',
      '.simplemd/dictionaries/x.md',
      '.simplemd/dictionaries/con.txt',
      '.simplemd/x.txt',
    ])
      port.externalWrite(path, 'x\n');
    const paths = events.flatMap((e) => (e.kind === 'change' ? e.paths : []));
    expect(new Set(paths)).toEqual(
      new Set(['.simplemd/dictionaries/pessoal.txt', '.simplemd/dictionaries/Lista Antiga.TXT']),
    );
    stop();
  });
});
