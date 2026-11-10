import { Channel, invoke } from '@tauri-apps/api/core';
import { sep } from '@tauri-apps/api/path';
import {
  VaultError,
  type FsDirItem,
  type FsPort,
  type FsSearchOptions,
  type FsStat,
  type TextSearchNote,
  type TextSearchSummary,
  type VaultErrorCode,
  type WriteMode,
} from '@simplemd/vault';

/**
 * Códigos do gateway que o vault conhece com o mesmo nome (arch-backend r2 §1.10; r7 §1.3). `CONFLICT`
 * (r26) não pode virar `IO`: o autosave tentaria de novo uma gravação que o disco recusou.
 * `INVALID_QUERY` (r37b): a consulta que o `vault_search_text` recusa (Reality r37a b).
 */
const SAME_CODES = new Set<string>([
  'CONFLICT',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'INVALID_PATH',
  'OUTSIDE_VAULT',
  'TOO_LARGE',
  'UNSUPPORTED_IMAGE',
  'INVALID_QUERY',
  'IO',
]);

/** Pasta aberta no Rust: a raiz (para converter caminhos) e o token desta abertura. */
interface OpenVault {
  readonly root: string;
  readonly token: number;
}

type WatchEvent = { readonly paths: readonly string[] } | { readonly error: string };

/** Evento do canal de `vault_search_text` (`SearchEvent` do Rust): o resumo vem sempre por último. */
type SearchEvent =
  | { readonly notes: readonly TextSearchNote[] }
  | { readonly progress: number }
  | { readonly done: TextSearchSummary };

/**
 * Resumo de uma busca abortada sem o resumo do Rust (antes de começar, ou com erro depois do
 * abort): um objeto novo a cada vez, porque quem recebe pode mudá-lo (code review r37b NB-5).
 */
const aborted = (): TextSearchSummary => ({
  scanned: 0,
  matched: 0,
  truncated: false,
  cancelled: true,
  skipped: { hidden: 0, links: 0, cloud: 0, tooLarge: 0, notUtf8: 0, unreadable: 0 },
});

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
 *
 * Troca em duas fases (r1 CR-02, CR2-02): a pasta do diálogo fica pendente e a atual continua
 * valendo (o app regrava o que foi digitado com o diálogo aberto) até `activateDirectory`. O Rust
 * troca no primeiro uso do token pendente. Quem usa a pasta nova sem ativar (um só `open()`, sem
 * pasta anterior a regravar) a ativa no primeiro caminho dela que não é da pasta atual.
 */
export class TauriFsPort implements FsPort {
  /** Id da última busca no texto desta janela (o `vault_search_cancel` só cancela a atual). */
  static #lastSearch = 0;
  #vault: OpenVault | null = null;
  #pending: OpenVault | null = null;

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
    this.#pending = picked;
    return picked.root;
  }

  activateDirectory(root: string): void {
    if (this.#pending?.root !== root) return;
    this.#vault = this.#pending;
    this.#pending = null;
  }

  abandonDirectory(root: string): void {
    if (this.#pending?.root === root) this.#pending = null;
  }

  join(root: string, relPosix: string): string {
    const separator = sep();
    return `${root.replace(/[\\/]+$/, '')}${separator}${relPosix.split('/').join(separator)}`;
  }

  async readDir(abs: string): Promise<FsDirItem[]> {
    // O Rust devolve tamanho e mtime de cada item (revalidação do índice sem `lstat` por nota) e,
    // só quando verdadeira, a marca de só na nuvem (r36b, `ops::is_cloud_only`).
    const items = await this.#call<FsDirItem[]>('vault_read_dir', abs);
    return items.map(({ name, kind, size, mtime, cloudOnly }) =>
      kind === 'file' && typeof size === 'number' && typeof mtime === 'number'
        ? { name, kind, size, mtime, ...(cloudOnly === true ? { cloudOnly } : {}) }
        : { name, kind },
    );
  }

  /** `cloudOnly` (r36b) vem do Rust só quando verdadeiro, como na listagem. */
  lstat(abs: string): Promise<FsStat | null> {
    return this.#call<FsStat | null>('vault_lstat', abs);
  }

  async readFile(abs: string): Promise<Uint8Array> {
    return new Uint8Array(await this.#call<ArrayBuffer>('vault_read_file', abs));
  }

  /** Imagem (r7 §1.3): o Rust confere caminho, tipo pela extensão, teto e bytes mágicos. */
  async readImage(abs: string): Promise<Uint8Array> {
    return new Uint8Array(await this.#call<ArrayBuffer>('vault_read_image', abs));
  }

  /**
   * Sobrescrita condicional (r26, D-R26-2): o Rust confere o sha256 da base e troca o arquivo de
   * forma atômica numa só chamada; `create-new` não leva hash.
   */
  async writeFile(abs: string, data: Uint8Array, mode: WriteMode): Promise<void> {
    const { token, rel } = this.#target(abs);
    const headers: Record<string, string> = {
      'x-simplemd-token': String(token),
      'x-simplemd-rel': encodeURIComponent(rel),
      'x-simplemd-mode': mode === 'create-new' ? mode : 'overwrite',
    };
    if (mode !== 'create-new') headers['x-simplemd-expected-sha256'] = mode.expectedSha256;
    try {
      await invoke('vault_write_file', data, { headers });
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

  /**
   * Busca no texto (r37b, design-r37 §3) pelo Rust (`vault_search_text`): só a pasta inteira, com
   * o token da abertura. Os eventos chegam pelo canal na ordem — lotes, progresso e, por último, o
   * resumo (`done`), que resolve a busca — e o `abort` chama `vault_search_cancel` com o id desta
   * busca. O Rust guarda o maior id cancelado, então o cancelamento que chega antes da busca a faz
   * nascer cancelada (code review r37b NB-1); o reenvio no 1º evento depois do abort fica para a
   * busca que ativou a pasta pendente nesse meio-tempo. Depois do `abort` nem lote nem progresso
   * sai, e o resumo diz `cancelled`, também se o Rust devolver erro (NB-5); signal já abortado →
   * nenhuma chamada IPC.
   */
  async searchText(abs: string, options: FsSearchOptions): Promise<TextSearchSummary> {
    const { token, rel } = this.#target(abs);
    if (rel !== '') throw new VaultError('INVALID_PATH', 'Só a pasta inteira é buscada.');
    const { signal } = options;
    if (signal.aborted) return aborted();
    const searchId = ++TauriFsPort.#lastSearch;
    let cancels = 0;
    const cancel = () => {
      cancels++;
      void invoke('vault_search_cancel', { searchId }).catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      // Forma com executor de propósito: `Promise.withResolvers` não existe no WKWebView < 14.4
      // (CR-08).
      return await new Promise<TextSearchSummary>((resolve, reject) => {
        const channel = new Channel<SearchEvent>();
        channel.onmessage = (event) => {
          if ('done' in event) {
            resolve({ ...event.done, cancelled: event.done.cancelled || signal.aborted });
          } else if (signal.aborted) {
            if (cancels === 1) cancel();
          } else if ('notes' in event) options.onNotes(event.notes);
          else options.onProgress?.(event.progress);
        };
        const args = { token, searchId, query: options.query, limit: options.limit };
        void invoke('vault_search_text', { ...args, onEvent: channel }).catch((error: unknown) =>
          signal.aborted ? resolve(aborted()) : reject(toVaultError(error, abs)),
        );
      });
    } finally {
      signal.removeEventListener('abort', cancel);
    }
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
    const current = this.#vault && this.#within(this.#vault, abs);
    if (current) return current;
    const pending = this.#pending && this.#within(this.#pending, abs);
    if (pending) {
      this.#vault = this.#pending;
      this.#pending = null;
      return pending;
    }
    throw new VaultError('PERMISSION_DENIED', 'Pasta fechada.', { path: abs });
  }

  #within(vault: OpenVault, abs: string): (OpenVault & { readonly rel: string }) | null {
    const root = vault.root.replace(/[\\/]+$/, '');
    const separator = sep();
    if (abs === root) return { ...vault, rel: '' };
    if (!abs.startsWith(`${root}${separator}`)) return null;
    return {
      ...vault,
      rel: abs
        .slice(root.length + 1)
        .split(separator)
        .join('/'),
    };
  }
}
