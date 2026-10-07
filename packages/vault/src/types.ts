import type { FsDirItem, FsStat } from './port';

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

/**
 * `VaultProvider` do app (fora da interface §4.3, AC-2.1): escrita autorizada por base de conteúdo
 * e as leituras que o carregador de plugins usa (arch-backend r2 §1.2).
 *
 * Troca de pasta em duas fases (r1 CR-02, CR2-02): o handle de `open()` pode estar PENDENTE (a pasta
 * atual continua valendo, para regravar o que foi digitado com o diálogo aberto) até `activate`;
 * `abandon` desiste dele e mantém a atual. Quem só chama `open()` e usa o handle não precisa disso.
 */
export interface ContentVaultProvider extends VaultProvider {
  /** Segunda fase da troca: o handle de `open()` vira a pasta ativa; as anteriores são esquecidas. */
  activate(handle: VaultHandle): void;
  /** Desiste do handle de `open()` ainda não ativado; a pasta atual continua valendo. */
  abandon(handle: VaultHandle): void;
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
  /** Bytes crus, lidos uma vez; acima de `maxBytes` → `TOO_LARGE` sem ler. */
  readBytes(
    handle: VaultHandle,
    path: string,
    options?: { maxBytes?: number },
  ): Promise<{ bytes: Uint8Array; mtime: number }>;
  /** `stat` dentro do vault (links recusados), `null` se não existe. */
  stat(handle: VaultHandle, path: string): Promise<FsStat | null>;
  /** Filhos diretos de uma pasta, sem itens ocultos. */
  listChildren(handle: VaultHandle, dir: string): Promise<FsDirItem[]>;
  /**
   * As notas `.md` do vault (mesmos filtros de `list`) com tamanho e mtime, para o índice revalidar
   * sem ler arquivos: uma leitura por pasta (arch-backend r2 §1.4). Com `dir`, só as dessa pasta e
   * das subpastas.
   */
  listNotes(handle: VaultHandle, dir?: string): Promise<NoteStat[]>;
}

/** Uma nota listada com o `stat` da listagem. */
export interface NoteStat {
  readonly path: string;
  readonly size: number;
  readonly mtime: number;
}
