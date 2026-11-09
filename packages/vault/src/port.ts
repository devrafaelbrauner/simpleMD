/**
 * Porta injetável de sistema de arquivos (arch-backend §1.5.2, R-2.2). A produção usa os plugins
 * do Tauri (apps/desktop/src/platform); os testes usam Node `fs` (`@simplemd/vault/node`) e a porta
 * em memória (`@simplemd/vault/testing`). Todo método lança apenas `VaultError`.
 */
export type FsKind = 'file' | 'dir' | 'symlink' | 'other';

/**
 * `mtime` em milissegundos inteiros. `cloudOnly` (r36b): arquivo só na nuvem — o conteúdo não está
 * no disco e lê-lo faz o sistema baixá-lo; ausente = local (ou porta que não sabe dizer).
 */
export interface FsStat {
  readonly kind: FsKind;
  readonly size: number;
  readonly mtime: number;
  readonly cloudOnly?: true;
}

/**
 * `size`/`mtime` (arquivos) quando a porta os tem na listagem; senão o provider faz `lstat`.
 * `cloudOnly` como em {@link FsStat}.
 */
export interface FsDirItem {
  readonly name: string;
  readonly kind: FsKind;
  readonly size?: number;
  readonly mtime?: number;
  readonly cloudOnly?: true;
}

/**
 * `create-new` só cria. O objeto é a sobrescrita condicional (r26, D-R26-2): troca o arquivo de forma
 * atômica só se o sha256 (hex minúsculo) do conteúdo atual for `expectedSha256`. Não existe
 * sobrescrita cega.
 */
export type WriteMode = 'create-new' | { readonly expectedSha256: string };

export interface FsPort {
  /**
   * Diálogo de pasta; `null` quando o usuário cancela. Numa porta em duas fases (Tauri) a pasta
   * devolvida fica PENDENTE: a atual continua valendo até {@link FsPort.activateDirectory}.
   */
  pickDirectory(): Promise<string | null>;
  /** Troca para a pasta pendente `root` (porta em duas fases; nas outras, ausente). */
  activateDirectory?(root: string): void;
  /** Esquece a pasta pendente `root`; a atual continua valendo (porta em duas fases). */
  abandonDirectory?(root: string): void;
  /** Junta a raiz nativa com um caminho relativo POSIX, usando o separador nativo. */
  join(root: string, relPosix: string): string;
  readDir(abs: string): Promise<FsDirItem[]>;
  /** `null` quando o caminho não existe. Nunca segue links simbólicos. */
  lstat(abs: string): Promise<FsStat | null>;
  readFile(abs: string): Promise<Uint8Array>;
  /**
   * Imagem do vault (r7 §1.3, D-R7-B17: opcional). No Tauri, `vault_read_image` (tipo, teto e bytes
   * mágicos conferidos no Rust); sem ele, o provider usa `readFile` e confere tudo no TS.
   */
  readImage?(abs: string): Promise<Uint8Array>;
  /**
   * `create-new` falha com `ALREADY_EXISTS` se o arquivo existir. `{ expectedSha256 }`: conteúdo atual
   * com outro sha256 → `CONFLICT` e 0 bytes gravados; igual aos bytes novos → nada é gravado;
   * inexistente → `NOT_FOUND`; senão troca atômica (no Tauri, temporário + `rename` no Rust).
   */
  writeFile(abs: string, data: Uint8Array, mode: WriteMode): Promise<void>;
  mkdirp(abs: string): Promise<void>;
  /** Observa a árvore sob `abs`; devolve a função que para a observação. */
  watch?(
    abs: string,
    onPaths: (absPaths: string[]) => void,
    onError: (reason: string) => void,
  ): Promise<() => void>;
}
