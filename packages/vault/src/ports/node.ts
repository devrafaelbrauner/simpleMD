import { randomBytes } from 'node:crypto';
import { watch as fsWatch, type Dirent, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { VaultError, type VaultErrorCode } from '../errors';
import { sha256Hex } from '../hash';
import type { FsDirItem, FsKind, FsPort, FsStat, WriteMode } from '../port';

const CODES: Record<string, VaultErrorCode> = {
  ENOENT: 'NOT_FOUND',
  EEXIST: 'ALREADY_EXISTS',
  EACCES: 'PERMISSION_DENIED',
  EPERM: 'PERMISSION_DENIED',
  EISDIR: 'INVALID_PATH',
  ENOTDIR: 'INVALID_PATH',
};

function classify(error: unknown, abs: string): VaultError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? '';
  return new VaultError(CODES[code] ?? 'IO', `Falha de E/S (${code || 'desconhecida'}).`, {
    path: abs,
    cause: error,
  });
}

function kindOf(entry: Dirent | Stats): FsKind {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'dir';
  return entry.isFile() ? 'file' : 'other';
}

/**
 * Porta Node (`node:fs/promises`) usada pelos testes do Vitest em pastas temporárias reais
 * (APFS, ext4 e NTFS na matriz de CI). `pickDirectory` devolve a pasta injetada. Junções do
 * Windows são relatadas como links simbólicos pelo `lstat` do Node.
 */
export class NodeFsPort implements FsPort {
  readonly #picked: string | null;

  constructor(picked: string | null) {
    this.#picked = picked;
  }

  async pickDirectory(): Promise<string | null> {
    return this.#picked;
  }

  join(root: string, relPosix: string): string {
    return join(root, ...relPosix.split('/'));
  }

  async readDir(abs: string): Promise<FsDirItem[]> {
    try {
      const entries = await readdir(abs, { withFileTypes: true });
      return entries.map((entry) => ({ name: entry.name, kind: kindOf(entry) }));
    } catch (error) {
      throw classify(error, abs);
    }
  }

  async lstat(abs: string): Promise<FsStat | null> {
    try {
      const stats = await lstat(abs);
      return { kind: kindOf(stats), size: stats.size, mtime: Math.trunc(stats.mtimeMs) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw classify(error, abs);
    }
  }

  async readFile(abs: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(abs));
    } catch (error) {
      throw classify(error, abs);
    }
  }

  /**
   * Mesma semântica do gateway em Rust (r26, D-R26-2): `create-new` só cria; `{ expectedSha256 }`
   * confere o sha256 atual (`CONFLICT` senão), não grava bytes iguais e troca por um temporário
   * oculto na mesma pasta, com as permissões do original, + `rename` (o arquivo nunca é truncado no
   * lugar).
   */
  async writeFile(abs: string, data: Uint8Array, mode: WriteMode): Promise<void> {
    if (mode === 'create-new') {
      try {
        await writeFile(abs, data, { flag: 'wx' });
      } catch (error) {
        throw classify(error, abs);
      }
      return;
    }
    let current: Buffer;
    let permissions: number;
    try {
      current = await readFile(abs);
      permissions = (await lstat(abs)).mode & 0o777;
    } catch (error) {
      throw classify(error, abs);
    }
    if (sha256Hex(current) !== mode.expectedSha256) {
      throw new VaultError('CONFLICT', 'O arquivo mudou no disco.', { path: abs });
    }
    if (current.equals(data)) return;
    const temp = join(dirname(abs), `.~simplemd-${randomBytes(8).toString('hex')}.tmp`);
    try {
      await writeFile(temp, data, { flag: 'wx', mode: 0o600 });
      await chmod(temp, permissions);
      await rename(temp, abs);
    } catch (error) {
      // EEXIST: o nome é de um arquivo que esta gravação não criou; ele nunca é apagado.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') await rm(temp, { force: true });
      throw classify(error, abs);
    }
  }

  async mkdirp(abs: string): Promise<void> {
    try {
      await mkdir(abs, { recursive: true });
    } catch (error) {
      throw classify(error, abs);
    }
  }

  async watch(
    abs: string,
    onPaths: (absPaths: string[]) => void,
    onError: (reason: string) => void,
  ): Promise<() => void> {
    const watcher = fsWatch(abs, { recursive: true }, (_event, filename) => {
      if (filename) onPaths([join(abs, filename.toString())]);
    });
    watcher.on('error', (error) => onError(error.message));
    return () => watcher.close();
  }
}
