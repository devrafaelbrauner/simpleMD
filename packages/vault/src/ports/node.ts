import { watch as fsWatch, type Dirent, type Stats } from 'node:fs';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VaultError, type VaultErrorCode } from '../errors';
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

  async writeFile(abs: string, data: Uint8Array, mode: WriteMode): Promise<void> {
    try {
      // 'w' trunca e grava no próprio arquivo (escrita no lugar, arch-backend §1.5.4).
      await writeFile(abs, data, { flag: mode === 'create-new' ? 'wx' : 'w' });
    } catch (error) {
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
