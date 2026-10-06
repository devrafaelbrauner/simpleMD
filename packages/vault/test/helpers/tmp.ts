import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LocalFsProvider, type VaultHandle } from '../../src/index';
import { NodeFsPort } from '../../src/ports/node';

export interface TempVault {
  readonly root: string;
  readonly provider: LocalFsProvider;
  readonly port: NodeFsPort;
  readonly handle: VaultHandle;
  abs(rel: string): string;
  put(rel: string, content: string | Uint8Array): void;
  bytes(rel: string): Buffer;
  sha(rel: string): string;
  cleanup(): void;
}

export const sha256 = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

/**
 * Vault em pasta temporária REAL (APFS/ext4/NTFS conforme a perna do CI). `realpathSync.native`
 * evita o apelido `/var` → `/private/var` do macOS e nomes curtos 8.3 do Windows.
 */
export async function makeTempVault(
  files: Record<string, string | Uint8Array> = {},
): Promise<TempVault> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'simplemd-vault-')));
  const port = new NodeFsPort(root);
  const provider = new LocalFsProvider(port);
  const abs = (rel: string) => join(root, ...rel.split('/'));
  const put = (rel: string, content: string | Uint8Array) => {
    mkdirSync(dirname(abs(rel)), { recursive: true });
    writeFileSync(abs(rel), content);
  };
  for (const [rel, content] of Object.entries(files)) put(rel, content);
  const handle = await provider.open();
  return {
    root,
    provider,
    port,
    handle,
    abs,
    put,
    bytes: (rel) => readFileSync(abs(rel)),
    sha: (rel) => sha256(readFileSync(abs(rel))),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
