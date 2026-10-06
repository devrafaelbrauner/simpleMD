import { afterEach, describe, expect, test } from 'vitest';
import { makeTempVault, type TempVault } from './helpers/tmp';

describe('NodeFsPort classifica erros nativos como VaultError', () => {
  let vault: TempVault | undefined;
  afterEach(() => {
    vault?.cleanup();
    vault = undefined;
  });

  test('ENOENT, EEXIST e pasta como arquivo', async () => {
    vault = await makeTempVault({ 'a.md': 'a', 'd/x.md': '' });
    const { port } = vault;
    await expect(port.readDir(vault.abs('nada'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(port.readFile(vault.abs('nada.md'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      port.writeFile(vault.abs('a.md'), new Uint8Array(), 'create-new'),
    ).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
    });
    await expect(
      port.writeFile(vault.abs('nada/x.md'), new Uint8Array(), 'overwrite'),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(port.readFile(vault.abs('d'))).rejects.toMatchObject({
      code: expect.stringMatching(/^(INVALID_PATH|PERMISSION_DENIED|IO)$/),
    });
    expect(await port.lstat(vault.abs('a.md/x'))).toBeNull();
    expect(await port.lstat(vault.abs('d'))).toMatchObject({ kind: 'dir' });
  });
});
