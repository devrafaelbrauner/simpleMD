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

/**
 * Base de conteúdo de uma escrita (RR-03, arch-backend r2 D-B1): a versão que o chamador leu, pelo
 * texto exato ou pelo sha256 dos bytes. Só ela autoriza a escrita; o `mtime` serve apenas para os
 * campos do `ConflictError`.
 */
export type ContentBase =
  | { readonly mtime: number; readonly text: string }
  | { readonly mtime: number; readonly sha256: string };

/** `VaultProvider` com escrita autorizada por base de conteúdo (fora da interface §4.3, AC-2.1). */
export interface ContentVaultProvider extends VaultProvider {
  /**
   * Sobrescreve `path` só se os bytes no disco forem os da `base`; senão `ConflictError` e 0 bytes
   * gravados. Bytes iguais aos novos → nada é gravado. Nunca cria o arquivo (sumiu → `deleted`).
   */
  writeIfUnchanged(
    handle: VaultHandle,
    path: string,
    text: string,
    base: ContentBase,
  ): Promise<{ mtime: number }>;
}
