// Portado de artisticat1/obsidian-latex-suite@5db51cf36abccdbbfa51184bb5fe86be8157cc2f (MIT), © 2022 artisticat1. Modificado para o simpleMD.
// Origem: src/features/auto_enlarge_brackets.ts. Mudanças: devolve as mudanças (compostas por
// `cm/expand.ts` na MESMA transação da expansão, um passo de desfazer) em vez de enfileirar
// snippets; percorre só o TeX da fórmula do cursor.
import type { EditorState } from '@codemirror/state';
import { AUTO_ENLARGE_BRACKETS_TRIGGERS } from '../cm/config';
import { contextAt } from '../context';
import { findMatchingBracket } from './brackets';

const BRACKETS: Readonly<Record<string, string>> = {
  '(': ')',
  '[': ']',
  '\\{': '\\}',
  '\\langle': '\\rangle',
  '\\lvert': '\\rvert',
  '\\lVert': '\\rVert',
  '\\lceil': '\\rceil',
  '\\lfloor': '\\rfloor',
};
const OPEN_BRACKETS = Object.keys(BRACKETS);

/** `( \frac… )` → `\left( \frac… \right)` em toda a fórmula do cursor principal (em ordem). */
export function autoEnlargeBrackets(state: EditorState): { from: number; to: number; insert: string }[] {
  const math = contextAt(state)?.math;
  if (!math) return [];
  const start = math.from;
  const text = state.sliceDoc(start, math.to);
  const left = '\\left';
  const right = '\\right';
  const changes: { from: number; to: number; insert: string }[] = [];
  for (let i = 0; i < text.length; i++) {
    const open = OPEN_BRACKETS.find((bracket) => text.startsWith(bracket, i));
    if (open === undefined) continue;
    const close = BRACKETS[open] ?? '';
    const j = findMatchingBracket(text, i, open, close, false);
    if (j === -1) continue;
    // Já ampliados.
    if (text.slice(i - left.length, i) === left && text.slice(j - right.length, j) === right)
      continue;
    const contents = text.slice(i + 1, j);
    if (!AUTO_ENLARGE_BRACKETS_TRIGGERS.some((word) => contents.includes(`\\${word}`))) {
      i = j;
      continue;
    }
    changes.push({ from: start + i, to: start + i + open.length, insert: `${left}${open} ` });
    changes.push({ from: start + j, to: start + j + close.length, insert: ` ${right}${close}` });
  }
  return changes.sort((a, b) => a.from - b.from);
}
