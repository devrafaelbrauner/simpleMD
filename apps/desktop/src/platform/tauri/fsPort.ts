import { invoke } from '@tauri-apps/api/core';
import { sep } from '@tauri-apps/api/path';
import { lstat, mkdir, readDir, readFile, watch, writeFile } from '@tauri-apps/plugin-fs';
import {
  VaultError,
  type FsDirItem,
  type FsKind,
  type FsPort,
  type FsStat,
  type VaultErrorCode,
  type WriteMode,
} from '@simplemd/vault';

/** Erros nativos chegam como texto: classifica pelo `(os error N)` (arch-backend §1.8). */
const UNIX_CODES: Record<number, VaultErrorCode> = {
  1: 'PERMISSION_DENIED',
  2: 'NOT_FOUND',
  13: 'PERMISSION_DENIED',
  17: 'ALREADY_EXISTS',
};
const WINDOWS_CODES: Record<number, VaultErrorCode> = {
  2: 'NOT_FOUND',
  3: 'NOT_FOUND',
  5: 'PERMISSION_DENIED',
  80: 'ALREADY_EXISTS',
  183: 'ALREADY_EXISTS',
};
const isWindows = sep() === '\\';

function classify(error: unknown, abs: string): VaultError {
  const message = error instanceof Error ? error.message : String(error);
  const os = /\(os error (\d+)\)/.exec(message);
  let code: VaultErrorCode = 'IO';
  if (/forbidden path|not allowed/i.test(message)) code = 'PERMISSION_DENIED';
  else if (os?.[1]) code = (isWindows ? WINDOWS_CODES : UNIX_CODES)[Number(os[1])] ?? 'IO';
  if (message === 'NOT_A_DIRECTORY' || message === 'INVALID_PATH') code = 'INVALID_PATH';
  return new VaultError(code, `Falha de E/S: ${message}`, { path: abs, cause: error });
}

function kindOf(entry: { isSymlink: boolean; isDirectory: boolean; isFile: boolean }): FsKind {
  if (entry.isSymlink) return 'symlink';
  if (entry.isDirectory) return 'dir';
  return entry.isFile ? 'file' : 'other';
}

/**
 * Porta de produção sobre `@tauri-apps/plugin-fs` (arch-backend §1.5.2). O escopo de fs vem só de
 * `pick_vault` (pasta escolhida + `.simplemd`); qualquer caminho fora dele é recusado pelo Tauri.
 */
export class TauriFsPort implements FsPort {
  async pickDirectory(): Promise<string | null> {
    try {
      return await invoke<string | null>('pick_vault');
    } catch (error) {
      throw classify(error, '');
    }
  }

  join(root: string, relPosix: string): string {
    const separator = sep();
    return `${root.replace(/[\\/]+$/, '')}${separator}${relPosix.split('/').join(separator)}`;
  }

  async readDir(abs: string): Promise<FsDirItem[]> {
    try {
      return (await readDir(abs)).map((entry) => ({ name: entry.name, kind: kindOf(entry) }));
    } catch (error) {
      throw classify(error, abs);
    }
  }

  async lstat(abs: string): Promise<FsStat | null> {
    try {
      const info = await lstat(abs);
      return { kind: kindOf(info), size: info.size, mtime: info.mtime?.getTime() ?? 0 };
    } catch (error) {
      const classified = classify(error, abs);
      if (classified.code === 'NOT_FOUND') return null;
      throw classified;
    }
  }

  async readFile(abs: string): Promise<Uint8Array> {
    try {
      return await readFile(abs);
    } catch (error) {
      throw classify(error, abs);
    }
  }

  async writeFile(abs: string, data: Uint8Array, mode: WriteMode): Promise<void> {
    try {
      await writeFile(abs, data, mode === 'create-new' ? { createNew: true } : {});
    } catch (error) {
      // A mensagem nativa é frágil: no modo só-criação, o lstat decide se o arquivo já existia.
      if (mode === 'create-new' && (await this.lstat(abs).catch(() => null)) !== null) {
        throw new VaultError('ALREADY_EXISTS', 'O arquivo já existe.', { path: abs, cause: error });
      }
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

  async watch(abs: string, onPaths: (absPaths: string[]) => void): Promise<() => void> {
    try {
      return await watch(abs, (event) => onPaths(event.paths), { recursive: true, delayMs: 500 });
    } catch (error) {
      throw classify(error, abs);
    }
  }
}
