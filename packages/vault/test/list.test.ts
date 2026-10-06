import { symlinkSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import { LocalFsProvider, VaultError } from '../src/index';
import { MemoryFsPort } from '../src/testing/index';
import { makeTempVault, type TempVault } from './helpers/tmp';

let vault: TempVault | undefined;
afterEach(() => {
  vault?.cleanup();
  vault = undefined;
});

const AC_2_2_FILES = {
  'a.md': '# a\n',
  'b.txt': 'texto',
  '.hidden.md': 'oculto',
  '.simplemd/config.json': '{}',
  'sub/c.md': '# c\n',
};

describe('AC-2.2: list em pasta temporária real (Node fs)', () => {
  test('devolve exatamente sub, sub/c.md e a.md, pastas primeiro, com "/"', async () => {
    vault = await makeTempVault(AC_2_2_FILES);
    const entries = await vault.provider.list(vault.handle);
    expect(entries).toEqual([
      { path: 'sub', name: 'sub', kind: 'dir' },
      { path: 'sub/c.md', name: 'c.md', kind: 'file' },
      { path: 'a.md', name: 'a.md', kind: 'file' },
    ]);
  });

  test('ordem: pastas primeiro, depois alfabética sem diferenciar maiúsculas', async () => {
    vault = await makeTempVault({
      'Zeta.md': '',
      'alfa.md': '',
      'Beta.MD': '',
      'b/x.md': '',
      'A/y.md': '',
      'img.png': '',
    });
    const paths = (await vault.provider.list(vault.handle)).map((e) => e.path);
    expect(paths).toEqual(['A', 'A/y.md', 'b', 'b/x.md', 'alfa.md', 'Beta.MD', 'Zeta.md']);
  });

  test('lista uma subpasta e recusa caminhos inválidos', async () => {
    vault = await makeTempVault({ 'sub/deep/d.md': '', 'sub/c.md': '' });
    const sub = await vault.provider.list(vault.handle, 'sub');
    expect(sub.map((e) => e.path)).toEqual(['sub/deep', 'sub/deep/d.md', 'sub/c.md']);
    await expect(vault.provider.list(vault.handle, 'nada')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(vault.provider.list(vault.handle, 'sub/c.md')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
    await expect(vault.provider.list(vault.handle, '../fora')).rejects.toBeInstanceOf(VaultError);
  });

  test('links simbólicos (ou junções no Windows) nunca aparecem nem são seguidos', async () => {
    vault = await makeTempVault({ 'real/r.md': '', 'a.md': '' });
    symlinkSync(
      vault.abs('real'),
      vault.abs('link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const paths = (await vault.provider.list(vault.handle)).map((e) => e.path);
    expect(paths).toEqual(['real', 'real/r.md', 'a.md']);
  });

  test('NFR-4: 2.000 arquivos (20 pastas × 100) são listados', async () => {
    const files: Record<string, string> = {};
    for (let d = 1; d <= 20; d++) {
      for (let f = 1; f <= 100; f++) {
        files[`pasta-${String(d).padStart(2, '0')}/nota-${String(f).padStart(3, '0')}.md`] = 'x';
      }
    }
    vault = await makeTempVault(files);
    const started = performance.now();
    const entries = await vault.provider.list(vault.handle);
    const elapsed = performance.now() - started;
    expect(entries).toHaveLength(2020);
    expect(entries.at(-1)?.path).toBe('pasta-20/nota-100.md');
    // O orçamento de 500 ms (NFR-4) vale para o macOS local; no CI o tempo é só informativo.
    console.info(`[NFR-4] list de 2.000 arquivos: ${elapsed.toFixed(1)} ms`);
  });
});

describe('list sobre a porta em memória', () => {
  test('mesma forma de AC-2.2 e nomes que a guarda recusaria ficam de fora', async () => {
    const port = new MemoryFsPort();
    port.seed({ ...AC_2_2_FILES, 'aux.md': '', 'ok.md': '' });
    const provider = new LocalFsProvider(port);
    const handle = await provider.open();
    expect(handle).toMatchObject({ name: 'vault', root: '/vault' });
    expect((await provider.list(handle)).map((e) => e.path)).toEqual([
      'sub',
      'sub/c.md',
      'a.md',
      'ok.md',
    ]);
  });

  test('open cancelado rejeita com CANCELLED', async () => {
    const port = new MemoryFsPort();
    port.setPickDirectory(() => null);
    await expect(new LocalFsProvider(port).open()).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
