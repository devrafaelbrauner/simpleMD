import {
  EMPTY_INDEX_DATA,
  type CatalogNoteMeta,
  type IndexedLink,
  type NoteExtractor,
  type NoteIndexData,
} from '../../src/index';

/**
 * Extrator de teste (o real é o `createNoteExtractor` do core, coberto nos testes do core e do
 * desktop): metadados por `meta` e, se dado, links por `links` — um trabalho de uma fatia só, ou de
 * `slices` fatias (para provar a cessão da vez entre fatias). `data` acrescenta tarefas,
 * propriedades e tags do corpo (índice v3).
 */
export function testExtractor(
  meta: (text: string, path: string) => CatalogNoteMeta,
  links: (text: string, path: string) => IndexedLink[] = () => [],
  slices = 1,
  data: (text: string, path: string) => Partial<NoteIndexData> = () => ({}),
): NoteExtractor & { readonly steps: string[] } {
  const steps: string[] = [];
  return {
    steps,
    meta,
    start(text, path) {
      let left = slices;
      return {
        step() {
          steps.push(path);
          left--;
          return left <= 0;
        },
        result() {
          const all = links(text, path);
          const extra = data(text, path);
          return {
            ...EMPTY_INDEX_DATA,
            ...extra,
            links: all.slice(0, 1000),
            truncated: [...(all.length > 1000 ? ['links' as const] : []), ...(extra.truncated ?? [])],
          };
        },
      };
    },
  };
}
