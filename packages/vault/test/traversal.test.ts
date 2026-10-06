import {
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { LocalFsProvider } from '../src/index';
import { MEMORY_ROOT, MemoryFsPort } from '../src/testing/index';
import { makeTempVault, type TempVault } from './helpers/tmp';

const ESCAPES = [
  '../x.md',
  '/etc/x.md',
  'C:/x.md',
  'a\\..\\x.md',
  'a.md:s',
  '.git/config',
  'sub/../../x.md',
];

describe('AC-2.7: caminhos fora do vault são recusados sem tocar o disco fora da raiz', () => {
  test.each(ESCAPES)(
    'memória: %s é recusado em read e write com 0 chamadas à porta',
    async (path) => {
      const port = new MemoryFsPort();
      port.seed({ 'a.md': 'a' });
      const provider = new LocalFsProvider(port);
      const handle = await provider.open();
      port.resetCalls();
      await expect(provider.read(handle, path)).rejects.toMatchObject({
        code: expect.stringMatching(/^(OUTSIDE_VAULT|INVALID_PATH)$/),
      });
      await expect(provider.write(handle, path, 'x', 1)).rejects.toMatchObject({
        code: expect.stringMatching(/^(OUTSIDE_VAULT|INVALID_PATH)$/),
      });
      expect(port.calls()).toEqual([]);
    },
  );

  test('memória: link simbólico para fora (pasta e arquivo) → OUTSIDE_VAULT; toda chamada fica sob a raiz', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'a.md': 'a' });
    port.symlink('saida', '/fora');
    port.symlink('arquivo.md', '/fora/segredo.md');
    const provider = new LocalFsProvider(port);
    const handle = await provider.open();
    port.resetCalls();
    for (const path of ['saida/x.md', 'arquivo.md']) {
      await expect(provider.read(handle, path)).rejects.toMatchObject({ code: 'OUTSIDE_VAULT' });
      await expect(provider.write(handle, path, 'x', 1)).rejects.toMatchObject({
        code: 'OUTSIDE_VAULT',
      });
      await expect(provider.write(handle, path, 'x')).rejects.toMatchObject({
        code: 'OUTSIDE_VAULT',
      });
    }
    expect(port.calls().length).toBeGreaterThan(0);
    for (const call of port.calls()) expect(call.abs.startsWith(`${MEMORY_ROOT}/`)).toBe(true);
    expect(port.calls().filter((c) => c.op === 'writeFile' || c.op === 'readFile')).toEqual([]);
  });

  describe('Node fs (pasta temporária real)', () => {
    let vault: TempVault | undefined;
    let outside: string | undefined;
    afterEach(() => {
      vault?.cleanup();
      if (outside) rmSync(outside, { recursive: true, force: true });
      vault = undefined;
      outside = undefined;
    });

    test('link de pasta/junção para fora do vault → OUTSIDE_VAULT e o alvo fica intacto', async () => {
      outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'simplemd-fora-')));
      writeFileSync(join(outside, 'segredo.md'), 'segredo');
      vault = await makeTempVault({ 'a.md': 'a' });
      symlinkSync(outside, vault.abs('saida'), process.platform === 'win32' ? 'junction' : 'dir');
      await expect(vault.provider.read(vault.handle, 'saida/segredo.md')).rejects.toMatchObject({
        code: 'OUTSIDE_VAULT',
      });
      await expect(vault.provider.write(vault.handle, 'saida/novo.md', 'x')).rejects.toMatchObject({
        code: 'OUTSIDE_VAULT',
      });
      await expect(vault.provider.list(vault.handle, 'saida')).rejects.toMatchObject({
        code: 'OUTSIDE_VAULT',
      });
      expect(readdirSync(outside)).toEqual(['segredo.md']);
    });

    test('link de arquivo para fora do vault → OUTSIDE_VAULT', async (ctx) => {
      outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'simplemd-fora-')));
      writeFileSync(join(outside, 'segredo.md'), 'segredo');
      vault = await makeTempVault({ 'a.md': 'a' });
      try {
        symlinkSync(join(outside, 'segredo.md'), vault.abs('link.md'), 'file');
      } catch {
        // Windows sem privilégio de criar links de arquivo (A-4): o caso da junção acima cobre o NTFS.
        ctx.skip();
      }
      await expect(vault.provider.read(vault.handle, 'link.md')).rejects.toMatchObject({
        code: 'OUTSIDE_VAULT',
      });
      await expect(vault.provider.write(vault.handle, 'link.md', 'x', 1)).rejects.toMatchObject({
        code: 'OUTSIDE_VAULT',
      });
    });
  });
});
