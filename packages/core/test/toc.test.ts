import { ensureSyntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { computeToc, createMarkdownExtensions, extractNoteMeta, type TocEntry } from '../src';
import { generateVault, VAULT_TAG_POOL, vaultNoteKind, vaultNotePath } from '../src/testing';

const outline = (entries: readonly TocEntry[]): unknown[] =>
  entries.map((e) => [e.level, e.text, ...(e.children.length ? [outline(e.children)] : [])]);

/**
 * TA-R2-20: estado com a árvore COMPLETA (padrão de `b533ba5`). `computeToc` tem orçamento de 25 ms
 * e cai na árvore parcial; sob CPU disputada o teste via um sumário cortado.
 */
function stateOf(doc: string): EditorState {
  const base = EditorState.create({ doc, extensions: createMarkdownExtensions() });
  if (!ensureSyntaxTree(base, base.doc.length, 5000)) throw new Error('parse incompleto');
  const state = base.update({}).state;
  if (!syntaxTreeAvailable(state, state.doc.length)) throw new Error('árvore parcial publicada');
  return state;
}

describe('AC-9.5 sumário', () => {
  it('h1, h2, h3, setext h2; exclui `# fake` em código e o title do front matter', () => {
    const doc = [
      '---',
      'title: Do YAML',
      '---',
      '# Um',
      '',
      '## Dois',
      '',
      '### Três',
      '',
      '```',
      '# fake',
      '```',
      '',
      'Setext dois',
      '-----------',
      '',
    ].join('\n');
    const state = stateOf(doc);
    const toc = computeToc(state);
    expect(outline(toc)).toEqual([
      [
        1,
        'Um',
        [
          [2, 'Dois', [[3, 'Três']]],
          [2, 'Setext dois'],
        ],
      ],
    ]);
    const three = toc[0]?.children[0]?.children[0];
    expect(doc.slice(three?.from, (three?.from ?? 0) + 8)).toBe('### Três');
  });

  it('nível que pula (h1 → h3) aninha sob o anterior; h2 sem h1 fica na raiz', () => {
    const state = stateOf('## A\n\n# B\n\n### C\n\n# D\n');
    expect(outline(computeToc(state))).toEqual([
      [2, 'A'],
      [1, 'B', [[3, 'C']]],
      [1, 'D'],
    ]);
    expect(computeToc(stateOf('sem títulos'))).toEqual([]);
  });
});

describe('R-9.9 gerador do vault de teste', () => {
  const vault = generateVault();
  const paths = Object.keys(vault);

  it('2.000 notas em 20 pastas × 100, ~2 KB, distribuição exata 75/20/5', () => {
    expect(paths).toHaveLength(2000);
    expect(new Set(paths.map((p) => p.split('/')[0])).size).toBe(20);
    const sizes = Object.values(vault).map((t) => new TextEncoder().encode(t).length);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(1800);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(2600);
    const kinds = paths.map((_, i) => vaultNoteKind(i));
    expect(kinds.filter((k) => k === 'front-matter')).toHaveLength(1500);
    expect(kinds.filter((k) => k === 'h1')).toHaveLength(400);
    expect(kinds.filter((k) => k === 'invalid-yaml')).toHaveLength(100);
    expect(VAULT_TAG_POOL).toHaveLength(50);
    expect(vaultNotePath(0)).toBe('receitas/nota-001.md');
  });

  it('metadados extraídos batem com o tipo de cada nota; mesma semente = mesmos bytes', () => {
    const metas = paths.map((p) => extractNoteMeta(vault[p] ?? '', p));
    expect(metas.filter((m) => m.fmError)).toHaveLength(100);
    expect(metas.filter((m) => m.tags.length >= 1 && m.tags.length <= 4 && m.date)).toHaveLength(
      1500,
    );
    expect(metas.every((m) => m.tags.every((t) => VAULT_TAG_POOL.includes(t)))).toBe(true);
    expect(metas.some((m) => m.tags.includes('receita'))).toBe(true);
    expect(generateVault()).toEqual(vault);
    expect(generateVault({ seed: 1 })).not.toEqual(vault);
    const withSentinel = generateVault({ folders: 1, perFolder: 3, bodySentinel: 'SENTINELA' });
    expect(Object.values(withSentinel).every((t) => t.includes('SENTINELA'))).toBe(true);
  });
});
