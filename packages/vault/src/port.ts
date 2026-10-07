/**
 * Porta injetável de sistema de arquivos (arch-backend §1.5.2, R-2.2). A produção usa os plugins
 * do Tauri (apps/desktop/src/platform); os testes usam Node `fs` (`@simplemd/vault/node`) e a porta
 * em memória (`@simplemd/vault/testing`). Todo método lança apenas `VaultError`.
 */
export type FsKind = 'file' | 'dir' | 'symlink' | 'other';

/** `mtime` em milissegundos inteiros. */
export interface FsStat {
  readonly kind: FsKind;
  readonly size: number;
  readonly mtime: number;
}

/** `size`/`mtime` (arquivos) quando a porta os tem na listagem; senão o provider faz `lstat`. */
export interface FsDirItem {
  readonly name: string;
  readonly kind: FsKind;
  readonly size?: number;
  readonly mtime?: number;
}

export type WriteMode = 'create-new' | 'overwrite';

export interface FsPort {
  /** Diálogo de pasta; `null` quando o usuário cancela. */
  pickDirectory(): Promise<string | null>;
  /** Junta a raiz nativa com um caminho relativo POSIX, usando o separador nativo. */
  join(root: string, relPosix: string): string;
  readDir(abs: string): Promise<FsDirItem[]>;
  /** `null` quando o caminho não existe. Nunca segue links simbólicos. */
  lstat(abs: string): Promise<FsStat | null>;
  readFile(abs: string): Promise<Uint8Array>;
  /** `create-new` falha com `ALREADY_EXISTS` se o arquivo existir; `overwrite` grava no lugar. */
  writeFile(abs: string, data: Uint8Array, mode: WriteMode): Promise<void>;
  mkdirp(abs: string): Promise<void>;
  /** Observa a árvore sob `abs`; devolve a função que para a observação. */
  watch?(
    abs: string,
    onPaths: (absPaths: string[]) => void,
    onError: (reason: string) => void,
  ): Promise<() => void>;
}
