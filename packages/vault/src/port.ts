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

/**
 * Um casamento da busca no texto (r37, design-r37 §1): posição no texto do editor e o trecho da
 * linha original. Mesmo formato no Rust (`vault/search.rs`, r37b) e na fixture `search-fold.json`.
 */
export interface TextSearchHit {
  /** Linha 0-based do texto do editor: sem BOM; CR, LF e CRLF valem uma quebra cada (`codec.ts`). */
  readonly line: number;
  /**
   * Início e tamanho do casamento na linha, em unidades UTF-16. O fim vai até o próximo ponto de
   * código que sobra na dobra (ou o fim da linha): as marcas que seguem o casamento entram nele.
   */
  readonly col: number;
  readonly len: number;
  /**
   * Trecho da linha: até 40 unidades antes do casamento e 80 depois dele (do casamento, no máximo
   * 256 unidades entram), sem partir um par substituto.
   */
  readonly text: string;
  /** Onde o casamento começa em `text`. */
  readonly at: number;
  /** A linha continua antes (`cutBefore`) ou depois (`cutAfter`) do trecho. */
  readonly cutBefore: boolean;
  readonly cutAfter: boolean;
}

/** Uma nota com resultado: até 5 trechos, na ordem do texto, e o total contado até 999. */
export interface TextSearchNote {
  /** Caminho relativo POSIX da nota. */
  readonly path: string;
  readonly total: number;
  readonly hits: readonly TextSearchHit[];
}

/** O que a busca pulou, por motivo (nada disso é lido, exceto o que falha na leitura). */
export interface TextSearchSkipped {
  /** Itens ocultos (`.simplemd`, `.git`, temporários…): pasta oculta não é percorrida. */
  readonly hidden: number;
  /** Links simbólicos e junções, nunca seguidos; também a nota trocada por link antes de abrir. */
  readonly links: number;
  /** Notas só na nuvem (r36b), nunca lidas, mesmo com `index.cloudOnly` (D-R37-1). */
  readonly cloud: number;
  /** Notas acima de 2 MiB, recusadas sem ler o conteúdo. */
  readonly tooLarge: number;
  readonly notUtf8: number;
  /** Nota (ou subpasta) que falhou ao abrir ou ler. */
  readonly unreadable: number;
}

export interface TextSearchSummary {
  /** Notas `.md` examinadas: lidas ou recusadas na leitura (as só na nuvem não entram). */
  readonly scanned: number;
  /** Notas entregues em `onNotes`. */
  readonly matched: number;
  /** Havia mais notas com resultado além do `limit`: a busca parou nelas. */
  readonly truncated: boolean;
  /** O `signal` foi abortado antes do fim: nenhum lote saiu depois. */
  readonly cancelled: boolean;
  readonly skipped: TextSearchSkipped;
}

/** Opções de {@link FsPort.searchText} (r37a). */
export interface FsSearchOptions {
  /**
   * Consulta como digitada; a porta a dobra (`foldForSearch`) e confere de novo: até 256 pontos de
   * código e, dobrada, ao menos 2.
   */
  readonly query: string;
  /** Notas com resultado antes de parar (1 a 500). */
  readonly limit: number;
  /** Conferido antes de cada pasta e de cada arquivo. */
  readonly signal: AbortSignal;
  /** Lotes de até 16 notas (ou o que juntou em 50 ms), na ordem do percurso. */
  readonly onNotes: (notes: readonly TextSearchNote[]) => void;
  /** Notas examinadas até agora, a cada 200. */
  readonly onProgress?: (scanned: number) => void;
}

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
  /**
   * Busca no texto das notas sob `abs` (r37, padrão do `watch?`): caminhos relativos POSIX, links
   * nunca seguidos, ocultos e notas só na nuvem pulados, 2 MiB por nota, casamento literal sem
   * acento nem caixa (`search.ts`). Sem ela, o provider responde `unavailable`.
   */
  searchText?(abs: string, options: FsSearchOptions): Promise<TextSearchSummary>;
}
