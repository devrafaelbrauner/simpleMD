import { Channel, invoke } from '@tauri-apps/api/core';
import { sep } from '@tauri-apps/api/path';
import {
  VaultError,
  type FsDirItem,
  type FsKind,
  type FsPort,
  type FsStat,
  type VaultErrorCode,
  type WriteMode,
} from '@simplemd/vault';

/** Códigos do gateway que o vault conhece com o mesmo nome (arch-backend r2 §1.10). */
const SAME_CODES = new Set<string>([
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'INVALID_PATH',
  'OUTSIDE_VAULT',
  'TOO_LARGE',
  'IO',
]);

/** Pasta aberta no Rust: a raiz (para converter caminhos) e o token desta abertura. */
interface OpenVault {
  readonly root: string;
  readonly token: number;
}

type WatchEvent = { readonly paths: readonly string[] } | { readonly error: string };

/**
 * Erro do gateway (`{ code, message }`) → `VaultError`. Pasta trocada ou fechada vira
 * `PERMISSION_DENIED` (sem nova tentativa); qualquer outra coisa, `IO`.
 */
function toVaultError(error: unknown, path: string): VaultError {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  const mapped: VaultErrorCode = SAME_CODES.has(code)
    ? (code as VaultErrorCode)
    : code === 'NO_VAULT' || code === 'VAULT_CLOSED'
      ? 'PERMISSION_DENIED'
      : 'IO';
  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String(error.message)
      : 'Falha de E/S.';
  return new VaultError(mapped, message, { path, cause: error });
}

/**
 * Porta de produção sobre o gateway do vault em Rust (arch-backend r2 §1.2, D-B2). O webview só
 * envia caminhos RELATIVOS à pasta aberta e o token da abertura; o Rust guarda a raiz, valida o
 * caminho e a classe do arquivo e recusa links. Um caminho fora da pasta atual (por exemplo, de uma
 * pasta anterior) é recusado aqui, com 0 chamadas IPC.
 */
export class TauriFsPort implements FsPort {
  #vault: OpenVault | null = null;

  /** Token da abertura atual (comandos que o Rust resolve pela pasta ativa); `null` sem pasta. */
  get token(): number | null {
    return this.#vault?.token ?? null;
  }

  async pickDirectory(): Promise<string | null> {
    let picked: OpenVault | null;
    try {
      picked = await invoke<OpenVault | null>('pick_vault');
    } catch (error) {
      throw toVaultError(error, '');
    }
    if (picked === null) return null;
    this.#vault = picked;
    return picked.root;
  }

  join(root: string, relPosix: string): string {
    const separator = sep();
    return `${root.replace(/[\\/]+$/, '')}${separator}${relPosix.split('/').join(separator)}`;
  }

  async readDir(abs: string): Promise<FsDirItem[]> {
    const items = await this.#call<Array<{ name: string; kind: FsKind }>>('vault_read_dir', abs);
    return items.map(({ name, kind }) => ({ name, kind }));
  }

  lstat(abs: string): Promise<FsStat | null> {
    return this.#call<FsStat | null>('vault_lstat', abs);
  }

  async readFile(abs: string): Promise<Uint8Array> {
    return new Uint8Array(await this.#call<ArrayBuffer>('vault_read_file', abs));
  }

  async writeFile(abs: string, data: Uint8Array, mode: WriteMode): Promise<void> {
    const { token, rel } = this.#target(abs);
    try {
      await invoke('vault_write_file', data, {
        headers: {
          'x-simplemd-token': String(token),
          'x-simplemd-rel': encodeURIComponent(rel),
          'x-simplemd-mode': mode,
        },
      });
    } catch (error) {
      throw toVaultError(error, abs);
    }
  }

  async mkdirp(abs: string): Promise<void> {
    await this.#call<null>('vault_mkdir', abs);
  }

  async watch(
    abs: string,
    onPaths: (absPaths: string[]) => void,
    onError: (reason: string) => void,
  ): Promise<() => void> {
    const { token, rel, root } = this.#target(abs);
    if (rel !== '') throw new VaultError('INVALID_PATH', 'Só a pasta inteira é observada.');
    const channel = new Channel<WatchEvent>();
    channel.onmessage = (event) => {
      if ('paths' in event) onPaths(event.paths.map((p) => this.join(root, p)));
      else onError(event.error);
    };
    let id: number;
    try {
      id = await invoke<number>('vault_watch', { token, onEvent: channel });
    } catch (error) {
      throw toVaultError(error, abs);
    }
    return () => void invoke('vault_unwatch', { id }).catch(() => undefined);
  }

  async #call<T>(command: string, abs: string): Promise<T> {
    const { token, rel } = this.#target(abs);
    try {
      return await invoke<T>(command, { token, rel });
    } catch (error) {
      throw toVaultError(error, abs);
    }
  }

  /** Caminho absoluto (montado por `join`) → caminho relativo POSIX dentro da pasta atual. */
  #target(abs: string): OpenVault & { readonly rel: string } {
    const vault = this.#vault;
    const root = vault?.root.replace(/[\\/]+$/, '');
    const separator = sep();
    if (vault && root !== undefined) {
      if (abs === root) return { ...vault, rel: '' };
      if (abs.startsWith(`${root}${separator}`)) {
        return {
          ...vault,
          rel: abs
            .slice(root.length + 1)
            .split(separator)
            .join('/'),
        };
      }
    }
    throw new VaultError('PERMISSION_DENIED', 'Pasta fechada.', { path: abs });
  }
}
