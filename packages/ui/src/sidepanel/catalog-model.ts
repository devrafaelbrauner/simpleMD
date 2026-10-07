import type { IndexEntry } from '@simplemd/vault';

export type CatalogSort = 'title' | 'date' | 'path';

/** Texto sem acentos e sem caixa (busca do catálogo e das notas `[[`; R-9.6, R-8.5). */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

interface SearchKey {
  readonly entry: IndexEntry;
  readonly text: string;
  readonly tags: readonly string[];
  /** Data de ordenação: `date` do front matter, senão o mtime. */
  readonly when: number;
}

/** Chaves de busca e de ordenação, calculadas uma vez por identidade de `entries`. */
export function buildSearchKeys(entries: readonly IndexEntry[]): SearchKey[] {
  return entries.map((entry) => {
    const tags = entry.tags.map(foldText);
    const parsed = entry.date === null ? Number.NaN : Date.parse(entry.date);
    return {
      entry,
      text: `${foldText(entry.title)}\n${foldText(entry.path)}\n${tags.join('\n')}`,
      tags,
      when: Number.isNaN(parsed) ? entry.mtime : parsed,
    };
  });
}

/** Ordena: título A–Z (padrão), data (mais recentes; empate pelo título) ou caminho. */
export function sortKeys(keys: readonly SearchKey[], sort: CatalogSort): SearchKey[] {
  const byTitle = (a: SearchKey, b: SearchKey) =>
    collator.compare(a.entry.title, b.entry.title) || collator.compare(a.entry.path, b.entry.path);
  const compare =
    sort === 'title'
      ? byTitle
      : sort === 'date'
        ? (a: SearchKey, b: SearchKey) => b.when - a.when || byTitle(a, b)
        : (a: SearchKey, b: SearchKey) => collator.compare(a.entry.path, b.entry.path);
  return [...keys].sort(compare);
}

/**
 * Filtra pela busca: cada termo precisa casar. `#tag` = tag exata (sem acento/caixa); os outros
 * termos são substrings de título, caminho ou tags.
 */
export function filterKeys(keys: readonly SearchKey[], query: string): SearchKey[] {
  const terms = foldText(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...keys];
  return keys.filter((key) =>
    terms.every((term) =>
      term.startsWith('#') && term.length > 1
        ? key.tags.includes(term.slice(1))
        : key.text.includes(term),
    ),
  );
}

/** STR-106: "2.000 notas", "1 nota", "12 de 2.000 notas". */
export function countText(shown: number, total: number, filtering: boolean): string {
  const all = total.toLocaleString('pt-BR');
  if (filtering)
    return `${shown.toLocaleString('pt-BR')} de ${all} ${total === 1 ? 'nota' : 'notas'}`;
  return `${all} ${total === 1 ? 'nota' : 'notas'}`;
}

/** `dd/mm/aaaa` (data do front matter como escrita) ou mtime + "(modificado)" (STR-111). */
export function dateText(entry: IndexEntry): string {
  const match = entry.date === null ? null : /^(\d{4})-(\d{2})-(\d{2})/.exec(entry.date);
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;
  if (entry.mtime < 0) return '';
  const d = new Date(entry.mtime);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${d.getFullYear()} (modificado)`;
}
