import { resolveNotePath, resolveWikilink, type NoteNameIndex } from './resolve';

/** Link de saída como está no índice (forma legível de `IndexedLink` do `@simplemd/vault`). */
export interface SourceLink {
  readonly line: number;
  readonly column: number;
  readonly length: number;
  readonly kind: 'wikilink' | 'inline' | 'reference';
  readonly target: string;
}

/** Nota de origem: caminho, título e links de saída (entrada do índice). */
export interface LinkSource {
  readonly path: string;
  readonly title: string;
  readonly links: readonly SourceLink[];
}

export interface BacklinkOccurrence {
  readonly line: number;
  readonly column: number;
  readonly length: number;
}

export interface BacklinkGroup {
  readonly path: string;
  readonly title: string;
  readonly occurrences: readonly BacklinkOccurrence[];
}

export interface Backlinks {
  readonly groups: readonly BacklinkGroup[];
  /** Total de ocorrências (resumo STR-152). */
  readonly links: number;
}

/**
 * Índice reverso alvo → origens (R-I2.7, D-39; arch-backend r7 §1.7.8): wikilinks resolvidos pela
 * MESMA função do editor e links `.md` relativos (já resolvidos na extração). Atualizado por
 * origem mudada (identidade da entrada); refeito inteiro só quando o conjunto de notas muda.
 */
export class BacklinkIndex {
  #notes: NoteNameIndex | null = null;
  readonly #sources = new Map<string, { source: LinkSource; targets: Set<string> }>();
  /** alvo → origem → ocorrências. */
  readonly #reverse = new Map<string, Map<string, BacklinkOccurrence[]>>();

  /** Sincroniza com as entradas atuais do índice. */
  update(sources: readonly LinkSource[], notes: NoteNameIndex): void {
    const rebuild = notes !== this.#notes;
    this.#notes = notes;
    if (rebuild) {
      this.#sources.clear();
      this.#reverse.clear();
    }
    const seen = new Set<string>();
    for (const source of sources) {
      seen.add(source.path);
      const known = this.#sources.get(source.path);
      if (known?.source === source) continue;
      if (known) this.#drop(source.path, known.targets);
      this.#add(source, notes);
    }
    for (const [path, known] of [...this.#sources]) {
      if (seen.has(path)) continue;
      this.#drop(path, known.targets);
      this.#sources.delete(path);
    }
  }

  #add(source: LinkSource, notes: NoteNameIndex): void {
    const targets = new Set<string>();
    for (const link of source.links) {
      let target: string | null = null;
      if (link.kind === 'wikilink') {
        const resolved = resolveWikilink(link.target, source.path, notes);
        if (resolved.kind === 'resolved') target = resolved.path;
      } else target = resolveNotePath(link.target, notes);
      if (target === null || target === source.path) continue;
      targets.add(target);
      let bySource = this.#reverse.get(target);
      if (!bySource) this.#reverse.set(target, (bySource = new Map()));
      let list = bySource.get(source.path);
      if (!list) bySource.set(source.path, (list = []));
      list.push({ line: link.line, column: link.column, length: link.length });
    }
    this.#sources.set(source.path, { source, targets });
  }

  #drop(path: string, targets: ReadonlySet<string>): void {
    for (const target of targets) {
      const bySource = this.#reverse.get(target);
      bySource?.delete(path);
      if (bySource?.size === 0) this.#reverse.delete(target);
    }
  }

  /** Notas que apontam para `path` (a própria fora), em ordem de título pt-BR. */
  backlinks(path: string): Backlinks {
    const bySource = this.#reverse.get(path);
    if (!bySource) return { groups: [], links: 0 };
    let links = 0;
    const groups: BacklinkGroup[] = [];
    for (const [sourcePath, occurrences] of bySource) {
      const source = this.#sources.get(sourcePath)?.source;
      if (!source) continue;
      links += occurrences.length;
      groups.push({
        path: sourcePath,
        title: source.title,
        occurrences: [...occurrences].sort((a, b) => a.line - b.line || a.column - b.column),
      });
    }
    groups.sort(
      (a, b) => a.title.localeCompare(b.title, 'pt-BR') || a.path.localeCompare(b.path, 'pt-BR'),
    );
    return { groups, links };
  }
}
