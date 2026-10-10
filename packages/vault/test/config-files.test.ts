// r7 arch-backend §1.13 (D-R7-B18; R-I5.2, R-I6.7): arquivos de configuração do vault lidos por
// plugins internos. Lista fechada, só leitura, teto pelo `lstat` com 0 leituras, `.cjs`/`.yaml`
// nunca tocados, e o `watch` deixa passar exatamente os 3 caminhos da lista.
import { describe, expect, test } from 'vitest';
import {
  LocalFsProvider,
  VAULT_CONFIG_FILES,
  VaultError,
  isVaultConfigFile,
  type VaultConfigFile,
  type VaultWatchEvent,
} from '../src/index';
import { MemoryFsPort } from '../src/testing/index';

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
