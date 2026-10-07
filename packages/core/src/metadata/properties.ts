import type { EditorState } from '@codemirror/state';
import { detectFrontMatter, FRONT_MATTER_SEARCH_LIMIT } from '../frontmatter/detect';
import { parseFrontMatterYaml } from './yaml';

/** Valores acima disto são cortados com "…" no painel; o texto inteiro vai no `title` (R-9.4). */
export const PROPERTY_DISPLAY_MAX = 200;

export interface PropertyRow {
  readonly key: string;
  /** Valor compacto, cortado em 200 caracteres com "…". */
  readonly display: string;
  /** Valor compacto inteiro (dica). */
  readonly full: string;
  /** `tags` válidas viram chips (sem `#`). */
  readonly chips?: readonly string[];
  /** Posição da linha da chave no documento do editor (clique leva o cursor até ela). */
  readonly pos: number;
  readonly warning?: string;
}

export type NoteProperties =
  | { readonly kind: 'none' }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'error'; readonly line: number; readonly message: string }
  | { readonly kind: 'ok'; readonly rows: readonly PropertyRow[] };

/** Forma compacta de um valor YAML: listas `[a, b]`, mapas `{chave: valor}`, texto como está. */
export function compactValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return `[${value.map(compactValue).join(', ')}]`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const pairs = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${key}: ${compactValue(item)}`,
    );
    return `{${pairs.join(', ')}}`;
  }
  return String(value);
}

/**
 * Propriedades da nota no editor (painel "Propriedades", R-9.4; leitura apenas, D-14). O texto do
 * editor não tem BOM nem CRLF, então os offsets do detector são os do documento.
 */
export function readNoteProperties(state: EditorState): NoteProperties {
  const doc = state.doc;
  if (doc.sliceString(0, 3) !== '---') return { kind: 'none' };
  const head = doc.sliceString(0, Math.min(doc.length, FRONT_MATTER_SEARCH_LIMIT + 1));
  const fm = detectFrontMatter(head);
  if (!fm) return { kind: 'none' };
  if (fm.tooLarge) return { kind: 'too-large' };
  const parsed = parseFrontMatterYaml(head.slice(fm.contentFrom, fm.contentTo));
  if (!parsed.ok) return { kind: 'error', line: parsed.line, message: parsed.message };
  const rows = parsed.properties.map((property): PropertyRow => {
    const full = compactValue(property.value);
    const chips = property.key === 'tags' && !property.warning ? parsed.tags : undefined;
    return {
      key: property.key,
      display:
        full.length > PROPERTY_DISPLAY_MAX ? `${full.slice(0, PROPERTY_DISPLAY_MAX)}…` : full,
      full,
      pos: doc.lineAt(fm.contentFrom + property.offset).from,
      ...(chips === undefined ? {} : { chips }),
      ...(property.warning === undefined ? {} : { warning: property.warning }),
    };
  });
  return { kind: 'ok', rows };
}
