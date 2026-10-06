import { ensureSyntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createMarkdownState } from '../src';

function nodeNames(state: EditorState): Set<string> {
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  if (!tree) throw new Error('a árvore de sintaxe não ficou pronta a tempo');
  const names = new Set<string>();
  tree.iterate({ enter: (node) => void names.add(node.name) });
  return names;
}

describe('árvore de sintaxe markdown (AC-1.2)', () => {
  it('contém ATXHeading1 e StrongEmphasis para "# T\\n\\n**b**"', () => {
    const names = nodeNames(createMarkdownState('# T\n\n**b**'));
    expect(names).toContain('ATXHeading1');
    expect(names).toContain('StrongEmphasis');
  });

  it('tem GFM ligado: uma tabela vira nós Table/TableHeader/TableDelimiter/TableRow', () => {
    const names = nodeNames(createMarkdownState('| a | b |\n| :- | -: |\n| 1 | 2 |\n'));
    for (const name of ['Table', 'TableHeader', 'TableDelimiter', 'TableRow', 'TableCell']) {
      expect(names).toContain(name);
    }
  });
});
