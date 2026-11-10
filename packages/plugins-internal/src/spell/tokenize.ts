import type { EditorState } from '@codemirror/state';
import { unitSegments, unitsIn } from '../shared/prose';

/**
 * Tokenizador do corretor offline (design-r35 §1, r35c): as palavras da prosa de um trecho, com as
 * mesmas exclusões do LanguageTool (`shared/prose.ts`): front matter, código, matemática, URLs,
 * HTML, destinos de links e wikilinks e as marcas do Markdown nunca viram palavra.
 *
 * Palavra = letras e marcas Unicode, com `'`, `’` ou `-` entre letras ("guarda-chuva", "d’água").
 * Ficam de fora: uma letra só, sigla (todas as letras em maiúsculas), palavra colada a dígito, `_`,
 * `@` ou `#` no próprio texto (código, e-mail, etiqueta: `snake_case`, `abc1`) e mais de 64
 * caracteres (o motor nunca as marca). A marca de ênfase é markup, não cola: `_ênfase_` e
 * `__negrito__` são verificadas (code-review r35c NB-2). Ao motor vai a forma NFC, com `’` trocado
 * por `'`.
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

/** A palavra `raw` em `text[index]` (o segmento começa em `pos` no documento). */
function tokenAt(text: string, index: number, raw: string, pos: number): SpellToken | null {
  const word = raw.normalize('NFC').replace(TYPOGRAPHIC_APOSTROPHE, "'");
  const chars = [...word].length;
  if (chars < 2 || chars > MAX_WORD_CHARS) return null;
  if (word === word.toUpperCase() && word !== word.toLowerCase()) return null;
  // O vizinho no segmento de texto, não no documento: o de fora é markup (a marca de ênfase).
  const end = index + raw.length;
  if (GLUED.test(text.charAt(index - 1)) || GLUED.test(text.charAt(end))) return null;
  return { from: pos + index, to: pos + end, word };
}

/**
 * As palavras das unidades de prosa que cruzam `[from, to)`, recortadas ao trecho (quem chama passa
 * linhas inteiras: uma palavra nunca atravessa uma quebra de linha), em ordem.
 */
export function tokensIn(state: EditorState, from: number, to: number): SpellToken[] {
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
        const token = tokenAt(segment.text, match.index, match[0], pos);
        if (token) out.push(token);
      }
      pos += segment.text.length;
    }
  }
  return out;
}
