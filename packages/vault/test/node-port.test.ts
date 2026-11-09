import { readdirSync, statSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import { makeTempVault, sha256, type TempVault } from './helpers/tmp';

let vault: TempVault | undefined;
afterEach(() => {
  vault?.cleanup();
  vault = undefined;
});

const encoder = new TextEncoder();

describe('NodeFsPort classifica erros nativos como VaultError', () => {
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
      port.writeFile(vault.abs('nada/x.md'), new Uint8Array(), { expectedSha256: sha256('') }),
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

describe('NodeFsPort: sobrescrita condicional e atômica, como o gateway em Rust (r26)', () => {
  const temps = () => readdirSync(vault!.root).filter((name) => name.startsWith('.~simplemd-'));

  test('sha256 diferente → CONFLICT sem gravar; bytes iguais → nada muda; senão troca sem sobra', async () => {
    vault = await makeTempVault({ 'n.md': '\uFEFFbase\r\n' });
    const { port } = vault;
    const abs = vault.abs('n.md');
    await expect(
      port.writeFile(abs, encoder.encode('app'), { expectedSha256: sha256('outra base') }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(vault.bytes('n.md').toString()).toBe('\uFEFFbase\r\n');
    const before = statSync(abs).mtimeMs;
    await port.writeFile(abs, encoder.encode('\uFEFFbase\r\n'), {
      expectedSha256: vault.sha('n.md'),
    });
    expect(statSync(abs).mtimeMs).toBe(before);
    await port.writeFile(abs, encoder.encode('nova\r\n'), { expectedSha256: vault.sha('n.md') });
    expect(vault.bytes('n.md').toString()).toBe('nova\r\n');
    expect(temps()).toEqual([]);
  });

  test('provider: o temporário (em curso ou órfão) nunca é listado nem indexado (AC-R26-4)', async () => {
    vault = await makeTempVault({ 'n.md': 'v1', '.~simplemd-0123456789abcdef.tmp': 'órfão' });
    const { provider, handle } = vault;
    const { text, mtime } = await provider.read(handle, 'n.md');
    await provider.writeIfUnchanged(handle, 'n.md', 'v2', { text, mtime });
    expect(vault.bytes('n.md').toString()).toBe('v2');
    expect((await provider.list(handle)).map((entry) => entry.path)).toEqual(['n.md']);
    expect((await provider.listNotes(handle)).map((note) => note.path)).toEqual(['n.md']);
    expect(temps()).toEqual(['.~simplemd-0123456789abcdef.tmp']); // só o órfão plantado
  });
});
