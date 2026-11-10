import type { EditorState, Text } from '@codemirror/state';
import { unitSegments, unitsIn } from '../shared/prose';

/**
 * Tokenizador do corretor offline (design-r35 §1, r35c): as palavras da prosa de um trecho, com as
 * mesmas exclusões do LanguageTool (`shared/prose.ts`): front matter, código, matemática, URLs,
 * HTML, destinos de links e wikilinks e as marcas do Markdown nunca viram palavra.
 *
 * Palavra = letras e marcas Unicode, com `'`, `’` ou `-` entre letras ("guarda-chuva", "d’água").
 * Ficam de fora: uma letra só, sigla (todas as letras em maiúsculas), palavra colada a dígito, `_`,
 * `@` ou `#` (código, e-mail, etiqueta) e mais de 64 caracteres (o motor nunca as marca). Ao motor
 * vai a forma NFC, com `’` trocado por `'`.
 */

/** Caracteres (pontos de código, em NFC) de uma palavra que ainda vai ao motor (`spell/mod.rs`). */
export const MAX_WORD_CHARS = 64;

export interface SpellToken {
  readonly from: number;
  readonly to: number;
  /** A palavra como vai ao motor: NFC, com `’` trocado por `'`. */
  readonly word: string;
}

const WORD = /[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu;
/** Vizinho que faz da palavra um pedaço de outra coisa (código, e-mail, etiqueta). */
const GLUED = /[\p{Nd}_@#]/u;
const TYPOGRAPHIC_APOSTROPHE = /’/g;

function tokenAt(doc: Text, from: number, raw: string): SpellToken | null {
  const to = from + raw.length;
  const word = raw.normalize('NFC').replace(TYPOGRAPHIC_APOSTROPHE, "'");
  const chars = [...word].length;
  if (chars < 2 || chars > MAX_WORD_CHARS) return null;
  if (word === word.toUpperCase() && word !== word.toLowerCase()) return null;
  const before = from > 0 ? doc.sliceString(from - 1, from) : '';
  const after = to < doc.length ? doc.sliceString(to, to + 1) : '';
  if (GLUED.test(before) || GLUED.test(after)) return null;
  return { from, to, word };
}

/**
 * As palavras das unidades de prosa que cruzam `[from, to)`, recortadas ao trecho (quem chama passa
 * linhas inteiras: uma palavra nunca atravessa uma quebra de linha), em ordem.
 */
export function tokensIn(state: EditorState, from: number, to: number): SpellToken[] {
  const doc = state.doc;
  const out: SpellToken[] = [];
  for (const unit of unitsIn(state, from, to)) {
    const start = Math.max(unit.from, from);
    const end = Math.min(unit.to, to);
    if (end <= start) continue;
    let pos = start;
    for (const segment of unitSegments(state, start, end)) {
      if ('markup' in segment) {
        pos += segment.markup.length;
        continue;
      }
      for (const match of segment.text.matchAll(WORD)) {
        const token = tokenAt(doc, pos + match.index, match[0]);
        if (token) out.push(token);
      }
      pos += segment.text.length;
    }
  }
  return out;
}
