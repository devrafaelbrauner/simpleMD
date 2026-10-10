import {
  BacklinkIndex,
  createNoteNameIndex,
  resolveWikilink,
  type Backlinks,
  type NoteNameIndex,
  type WikilinkIndex,
  type WikilinkResolution,
} from '@simplemd/core';
import type { CatalogSnapshot, Entry } from '@simplemd/vault';
import { missingWikilink } from '../app/note-create';

/** O catálogo como o índice de links o lê (o `CatalogController`). */
export interface CatalogSource {
  getSnapshot(): CatalogSnapshot;
  subscribe(listener: () => void): () => void;
}

/** A árvore do explorador (todas as entradas listadas do vault; o store do app). */
export interface ExplorerSource {
  entries(): readonly Entry[];
  subscribe(listener: () => void): () => void;
}

const MD = /\.md$/i;

/**
 * Fachada de wikilinks e backlinks do app (arch-frontend r7 §6; arch-backend r7 §1.7.8). O conjunto
 * de notas é a UNIÃO das entradas do índice com os `.md` do explorador (JEV D-R7-S2-04: nada pisca
 * "inexistente" enquanto o índice ainda lê as notas). `version` muda só quando esse conjunto muda
 * (o editor redecora o viewport); o índice reverso é atualizado por origem mudada.
 */
export class LinksIndex implements WikilinkIndex {
  readonly #catalog: CatalogSource;
  readonly #explorer: ExplorerSource;
  readonly #listeners = new Set<() => void>();
  readonly #backlinks = new BacklinkIndex();
  #notes: NoteNameIndex = createNoteNameIndex([]);
  #seenEntries: CatalogSnapshot['entries'] | null = null;
  #seenExplorer: readonly Entry[] | null = null;
  #backlinksOf: CatalogSnapshot['entries'] | null = null;
  #backlinksNotes: NoteNameIndex | null = null;
  #version = 0;

  constructor(catalog: CatalogSource, explorer: ExplorerSource) {
    this.#catalog = catalog;
    this.#explorer = explorer;
    this.#sync();
    catalog.subscribe(() => this.#changed());
    explorer.subscribe(() => {
      if (explorer.entries() !== this.#seenExplorer) this.#changed();
    });
  }

  get version(): number {
    return this.#version;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /**
   * Mesma regra do editor e da exportação (`resolveWikilink`, R-I2.3). Inexistente: o caminho de
   * criação e a recusa vêm da MESMA validação do clique (`wikilinkCreation`; CR-S2-03).
   */
  resolve(target: string, fromPath: string | null): WikilinkResolution {
    this.#sync();
    const resolution = resolveWikilink(target, fromPath, this.#notes);
    return resolution.kind === 'resolved' ? resolution : missingWikilink(target, fromPath);
  }

  /** O alvo existe a partir da nota `fromPath` (exportação, AC-EX.3). */
  exists(target: string, fromPath: string | null): boolean {
    // Só a existência: sem validar o nome de criação (D-N2 da revisão).
    this.#sync();
    return resolveWikilink(target, fromPath, this.#notes).kind === 'resolved';
  }

  /** Notas que apontam para `path` (R-I2.7): wikilinks resolvidos + links `.md` relativos. */
  backlinks(path: string): Backlinks {
    this.#sync();
    const entries = this.#catalog.getSnapshot().entries;
    if (entries !== this.#backlinksOf || this.#notes !== this.#backlinksNotes) {
      this.#backlinks.update(entries, this.#notes);
      this.#backlinksOf = entries;
      this.#backlinksNotes = this.#notes;
    }
    return this.#backlinks.backlinks(path);
  }

  /** O índice tem a nota `path` com links cortados pelo teto (aviso LNK-LIMIT). */
  overLimit(path: string): boolean {
    const entry = this.#catalog.getSnapshot().entries.find((e) => e.path === path);
    return entry?.truncated.includes('links') ?? false;
  }

  /** Avisa só quando o conjunto de notas mudou (o painel lê o catálogo pela própria assinatura). */
  #changed(): void {
    const before = this.#version;
    this.#sync();
    if (this.#version === before) return;
    for (const listener of [...this.#listeners]) listener();
  }

  /** Refaz o índice de nomes só quando o CONJUNTO de caminhos mudou (versão nova). */
  #sync(): void {
    const entries = this.#catalog.getSnapshot().entries;
    const explorer = this.#explorer.entries();
    if (entries === this.#seenEntries && explorer === this.#seenExplorer) return;
    this.#seenEntries = entries;
    this.#seenExplorer = explorer;
    const paths = new Set<string>();
    for (const entry of entries) paths.add(entry.path);
    for (const entry of explorer)
      if (entry.kind === 'file' && MD.test(entry.path)) paths.add(entry.path);
    const known = this.#notes.paths;
    if (paths.size === known.size && [...paths].every((path) => known.has(path))) return;
    this.#notes = createNoteNameIndex(paths);
    this.#version++;
  }
}
