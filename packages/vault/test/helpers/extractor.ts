import type { CatalogNoteMeta, IndexedLink, NoteExtractor } from '../../src/index';

/**
 * Extrator de teste (o real é o `createNoteExtractor` do core, coberto nos testes do core e do
 * desktop): metadados por `meta` e, se dado, links por `links` — um trabalho de uma fatia só, ou de
 * `slices` fatias (para provar a cessão da vez entre fatias).
 */
export function testExtractor(
  meta: (text: string, path: string) => CatalogNoteMeta,
  links: (text: string, path: string) => IndexedLink[] = () => [],
  slices = 1,
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
          return { links: all.slice(0, 1000), truncated: all.length > 1000 ? ['links'] : [] };
        },
      };
    },
  };
}
