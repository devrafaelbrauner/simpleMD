/**
 * Contrato do vault: exatamente o formato de PLANO §4.3 (arch-backend §1.5.1). Símbolos extras
 * são exportados à parte para não alterar esta interface (AC-2.1).
 */
export type Unsubscribe = () => void;

/** `root` é o caminho nativo opaco escolhido pelo usuário. */
export interface VaultHandle {
  readonly id: string;
  readonly name: string;
  readonly root: string;
}

/** `path` é relativo ao vault, com `/` em todo SO e sem barra final em pastas. */
export interface Entry {
  readonly path: string;
  readonly name: string;
  readonly kind: 'file' | 'dir';
}

export type VaultWatchEvent =
  | { readonly kind: 'change'; readonly paths: readonly string[] }
  | { readonly kind: 'unavailable'; readonly reason: string };

export interface VaultProvider {
  open(): Promise<VaultHandle>;
  list(handle: VaultHandle, dir?: string): Promise<Entry[]>;
  read(handle: VaultHandle, path: string): Promise<{ text: string; mtime: number }>;
  /** Sem `expectedMtime` a escrita só cria (nunca sobrescreve); com ele, falha se o arquivo mudou. */
  write(
    handle: VaultHandle,
    path: string,
    text: string,
    expectedMtime?: number,
  ): Promise<{ mtime: number }>;
  watch?(handle: VaultHandle, cb: (event: VaultWatchEvent) => void): Unsubscribe;
}
