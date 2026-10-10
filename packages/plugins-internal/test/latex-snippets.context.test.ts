import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { createMarkdownExtensions } from '@simplemd/core';
import { describe, expect, test } from 'vitest';
import { contextAt, excludedAt } from '../src/latex-snippets/context';
import { blockedSpans, blockMathIn, inlineMathIn, mathAt } from '../src/shared/scan';

/**
 * R-I6.1 (AC-I6.2): o contexto matemático dos snippets usa as MESMAS varreduras do KaTeX. Teste de
 * equivalência: em todo ponto do documento, `mathAt` diz "fórmula fechada" exatamente onde o
 * KaTeX desenha uma fórmula (entre os delimitadores); o resto é a extensão "ainda sem fechamento"
 * da digitação (JEV D-R7-S6-01), testada à parte.
 */
function stateOf(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [createMarkdownExtensions()] });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

const CORPUS = [
  'Texto com $a+b$ e $$ não, e \\$5 e $x$ ok.',
  'preço $5 e $10, e $ x$ não abre; $y $ não fecha; $z$2 não fecha.',
  '`$codigo$` e $fora$ e `x` $y$',
  '$$\nx^2\n$$\n\ntexto $a$ depois\n\n$$\n\\frac{1}{2}\n\\sum\n$$',
  '---\ntitulo: $a$\n---\n\n$b$',
  '```\n$a$\n```\n\n$c$',
  '- item $a$\n- $$\n  b\n  $$',
];

describe('R-I6.1 equivalência com o KaTeX (fórmulas fechadas)', () => {
  test.each(CORPUS)('%s', (doc) => {
    const state = stateOf(doc);
    const blocked = blockedSpans(state, 0, doc.length);
    const inline = inlineMathIn(state, 0, doc.length, blocked);
    const blocks = blockMathIn(state, 0, doc.length).map((b) => {
      const first = state.doc.lineAt(b.from);
      const last = state.doc.lineAt(b.to);
      return { from: first.to + 1, to: last.from - 1 };
    });
    for (let pos = 0; pos <= doc.length; pos++) {
      const katex =
        inline.some((s) => s.from < pos && pos < s.to) ||
        blocks.some((b) => b.from <= pos && pos <= b.to);
      const ours = mathAt(state, pos);
      // O par vazio `$|$` é a única fórmula "fechada" só nossa (o que `mk` deixa; D-R7-S6-01).
      const emptyPair = ours?.from === pos && ours.to === pos;
      expect({ pos, closed: ours?.closed === true && !emptyPair }).toEqual({ pos, closed: katex });
    }
  });
});

describe('extensão da digitação e exclusões', () => {
  test('`$` aberto sem fechamento: em linha, até o fim da linha', () => {
    const state = stateOf('Seja $x+');
    expect(mathAt(state, 8)).toEqual({ kind: 'inline', from: 6, to: 8, closed: false });
    expect(mathAt(stateOf('custa $ 5'), 9)).toBeNull();
  });

  test('par vazio `$|$` e bloco aberto (linha `$$` seguida de linha vazia)', () => {
    expect(mathAt(stateOf('$$'), 1)).toEqual({ kind: 'inline', from: 1, to: 1, closed: true });
    expect(mathAt(stateOf('$$\n\n$$'), 3)?.kind).toBe('block');
    expect(mathAt(stateOf('$$\nx+'), 5)).toEqual({ kind: 'block', from: 3, to: 5, closed: false });
  });

  test.each([
    ['código cercado', '```\n$x$\n```', 6],
    ['código em linha', 'a `$x$` b', 5],
    ['front matter', '---\nt: $x$\n---\n', 9],
    ['bloco HTML', '<div>\n$x$\n</div>', 8],
    ['tag HTML', '<span title="$x$">a</span>', 15],
  ])('%s: sem contexto', (_name, doc, pos) => {
    const state = stateOf(doc);
    expect(excludedAt(state, pos)).toBe(true);
    expect(contextAt(state, pos)).toBeNull();
  });

  test('texto comum: modo texto', () => {
    const ctx = contextAt(stateOf('palavra'), 3);
    expect(ctx?.mode.text).toBe(true);
    expect(ctx?.mode.inMath()).toBe(false);
  });
});
