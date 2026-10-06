import { rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'vitest';
import { ConflictError, LocalFsProvider, isVaultError } from '../src/index';
import { NodeFsPort } from '../src/ports/node';
import { makeTempVault, sha256, type TempVault } from './helpers/tmp';

let vault: TempVault | undefined;
afterEach(() => {
  vault?.cleanup();
  vault = undefined;
});

/** Força um mtime distinto (V-9): nunca depender do relógio de parede em FS de baixa resolução. */
function bumpMtime(v: TempVault, rel: string, seconds = 10): void {
  const st = statSync(v.abs(rel));
  const next = new Date(st.mtimeMs + seconds * 1000);
  utimesSync(v.abs(rel), next, next);
}

describe('AC-2.3: read', () => {
  test('devolve o texto exato (CRLF e BOM incluídos) e o mtime do stat em ms', async () => {
    const raw = '\uFEFF# Título\r\nlinha\r\n';
    vault = await makeTempVault({ 'nota.md': raw });
    const result = await vault.provider.read(vault.handle, 'nota.md');
    expect(result.text).toBe(raw);
    expect(result.mtime).toBe(Math.trunc(statSync(vault.abs('nota.md')).mtimeMs));
  });

  test('arquivo ausente → NOT_FOUND; UTF-8 inválido → NOT_UTF8; pasta → INVALID_PATH', async () => {
    vault = await makeTempVault({
      'latin1.md': new Uint8Array([0x61, 0xe9, 0x0a]),
      'd.md/x.md': '',
    });
    await expect(vault.provider.read(vault.handle, 'nada.md')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(vault.provider.read(vault.handle, 'latin1.md')).rejects.toMatchObject({
      code: 'NOT_UTF8',
    });
    await expect(vault.provider.read(vault.handle, 'd.md')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
  });

  test('só *.md e .simplemd/**/*.json são legíveis', async () => {
    vault = await makeTempVault({ 'b.txt': 'x', '.simplemd/config.json': '{"x":1}' });
    await expect(vault.provider.read(vault.handle, 'b.txt')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
    await expect(vault.provider.read(vault.handle, '.simplemd/config.json')).resolves.toMatchObject(
      {
        text: '{"x":1}',
      },
    );
    await expect(vault.provider.read(vault.handle, '.simplemd/x.md')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
  });

  test('readLimits recusa arquivo grande demais pelo lstat, sem lê-lo', async () => {
    vault = await makeTempVault({ '.simplemd/config.json': 'x'.repeat(2048) });
    const port = new NodeFsPort(vault.root);
    const reads: string[] = [];
    const original = port.readFile.bind(port);
    port.readFile = async (abs) => {
      reads.push(abs);
      return original(abs);
    };
    const provider = new LocalFsProvider(port, {
      readLimits: [{ match: (p) => p === '.simplemd/config.json', maxBytes: 1024 }],
    });
    const handle = await provider.open();
    await expect(provider.read(handle, '.simplemd/config.json')).rejects.toMatchObject({
      code: 'TOO_LARGE',
    });
    expect(reads).toEqual([]);
  });
});

describe('AC-2.4 … AC-2.6: write com expectedMtime', () => {
  test('AC-2.4: mtime correto grava os bytes (sha256 igual) e devolve o novo mtime', async () => {
    vault = await makeTempVault({ 'nota.md': 'antes\n' });
    const { mtime } = await vault.provider.read(vault.handle, 'nota.md');
    const text = 'depois — ação\n';
    const result = await vault.provider.write(vault.handle, 'nota.md', text, mtime);
    expect(vault.sha('nota.md')).toBe(sha256(text));
    expect(result.mtime).toBe(Math.trunc(statSync(vault.abs('nota.md')).mtimeMs));
  });

  test('AC-2.5: depois de escrita externa com outros bytes, mtime antigo → ConflictError e 0 bytes gravados', async () => {
    vault = await makeTempVault({ 'nota.md': 'original\n' });
    const { mtime } = await vault.provider.read(vault.handle, 'nota.md');
    writeFileSync(vault.abs('nota.md'), 'externo\n');
    bumpMtime(vault, 'nota.md');
    const before = vault.sha('nota.md');
    const error = await vault.provider
      .write(vault.handle, 'nota.md', 'app\n', mtime)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ code: 'CONFLICT', reason: 'modified', expectedMtime: mtime });
    expect(vault.sha('nota.md')).toBe(before);
  });

  test('AC-2.5 (mesmo mtime): bytes diferentes no mesmo tique ainda geram conflito', async () => {
    vault = await makeTempVault({ 'nota.md': 'original\n' });
    const { mtime } = await vault.provider.read(vault.handle, 'nota.md');
    writeFileSync(vault.abs('nota.md'), 'externo!\n');
    const at = new Date(mtime);
    utimesSync(vault.abs('nota.md'), at, at);
    await expect(
      vault.provider.write(vault.handle, 'nota.md', 'app\n', mtime),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(vault.bytes('nota.md').toString()).toBe('externo!\n');
  });

  test('AC-2.6: só o mtime mudou (bytes iguais) → salva sem conflito', async () => {
    vault = await makeTempVault({ 'nota.md': 'mesmo conteúdo\n' });
    // Criação e escrita podem cair no mesmo tique do relógio do FS (Linux): recua o mtime inicial.
    bumpMtime(vault, 'nota.md', -60);
    const { mtime } = await vault.provider.read(vault.handle, 'nota.md');
    bumpMtime(vault, 'nota.md');
    const result = await vault.provider.write(vault.handle, 'nota.md', 'novo\n', mtime);
    expect(vault.bytes('nota.md').toString()).toBe('novo\n');
    expect(result.mtime).not.toBe(mtime);
  });

  test('salvar bytes iguais aos do disco não grava (mtime preservado)', async () => {
    vault = await makeTempVault({ 'nota.md': 'igual\n' });
    const { mtime } = await vault.provider.read(vault.handle, 'nota.md');
    bumpMtime(vault, 'nota.md');
    const touched = Math.trunc(statSync(vault.abs('nota.md')).mtimeMs);
    const result = await vault.provider.write(vault.handle, 'nota.md', 'igual\n', mtime);
    expect(result.mtime).toBe(touched);
    expect(Math.trunc(statSync(vault.abs('nota.md')).mtimeMs)).toBe(touched);
  });

  test('provider novo (sem conhecimento): o mtime é o único sinal', async () => {
    vault = await makeTempVault({ 'nota.md': 'a\n' });
    const { mtime } = await vault.provider.read(vault.handle, 'nota.md');
    const fresh = new LocalFsProvider(new NodeFsPort(vault.root));
    const handle = await fresh.open();
    await expect(fresh.write(handle, 'nota.md', 'b\n', mtime - 5000)).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(fresh.write(handle, 'nota.md', 'b\n', mtime)).resolves.toHaveProperty('mtime');
    expect(vault.bytes('nota.md').toString()).toBe('b\n');
  });

  test('arquivo removido → ConflictError com reason "deleted"', async () => {
    vault = await makeTempVault({ 'nota.md': 'a\n' });
    const { mtime } = await vault.provider.read(vault.handle, 'nota.md');
    rmSync(vault.abs('nota.md'));
    await expect(vault.provider.write(vault.handle, 'nota.md', 'b\n', mtime)).rejects.toMatchObject(
      {
        code: 'CONFLICT',
        reason: 'deleted',
        actualMtime: null,
      },
    );
  });

  test('sem expectedMtime a escrita só cria: arquivo existente → ALREADY_EXISTS, nada muda', async () => {
    vault = await makeTempVault({ 'nota.md': 'original\n' });
    const error = await vault.provider.write(vault.handle, 'nota.md', 'x').catch((e: unknown) => e);
    expect(isVaultError(error, 'ALREADY_EXISTS')).toBe(true);
    expect(vault.bytes('nota.md').toString()).toBe('original\n');
    const created = await vault.provider.write(vault.handle, 'nova/pasta/n.md', 'novo\n');
    expect(vault.bytes('nova/pasta/n.md').toString()).toBe('novo\n');
    expect(created.mtime).toBe(Math.trunc(statSync(vault.abs('nova/pasta/n.md')).mtimeMs));
  });

  test('escritas concorrentes no mesmo caminho são serializadas', async () => {
    vault = await makeTempVault({ 'nota.md': 'v0\n' });
    const { mtime } = await vault.provider.read(vault.handle, 'nota.md');
    const first = vault.provider.write(vault.handle, 'nota.md', 'v1\n', mtime);
    const second = first.then(({ mtime: m }) =>
      vault!.provider.write(vault!.handle, 'nota.md', 'v2\n', m),
    );
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(vault.bytes('nota.md').toString()).toBe('v2\n');
  });
});
