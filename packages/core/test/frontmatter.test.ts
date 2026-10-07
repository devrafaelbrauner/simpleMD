import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import type { BlockContext } from '@lezer/markdown';
import { describe, expect, it } from 'vitest';
import { createMarkdownState, detectFrontMatter, FRONT_MATTER_MAX_CONTENT } from '../src';
import { readInput } from '../src/frontmatter/lezer';
import { decorate, previewState } from './helpers/live-preview';

/** Nomes dos filhos diretos do documento, com faixas. */
function topNodes(state: EditorState): string[] {
  // A árvore completa é a DEVOLVIDA por `ensureSyntaxTree`: `syntaxTree(state)` ainda pode ser a
  // parcial da criação do estado num runner lento (instável no Windows do CI).
  const tree = ensureSyntaxTree(state, state.doc.length, 5000) ?? syntaxTree(state);
  const out: string[] = [];
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    out.push(`${node.name}:${node.from}-${node.to}`);
  }
  return out;
}

describe('detectFrontMatter (AC-9.1 parte do detector)', () => {
  it('offset 0, LF: faixas do bloco e do conteúdo', () => {
    const text = '---\ntitle: x\n---\n# Corpo\n';
    expect(detectFrontMatter(text)).toEqual({
      from: 0,
      to: 16,
      contentFrom: 4,
      contentTo: 13,
      closer: '---',
      tooLarge: false,
    });
  });

  it('BOM e CRLF; fechamento `...`; espaços no fim das linhas de cerca', () => {
    const text = '\uFEFF--- \r\ntitle: x\r\n... \r\ncorpo\r\n';
    expect(detectFrontMatter(text)).toEqual({
      from: 1,
      to: 21,
      contentFrom: 7,
      contentTo: 17,
      closer: '...',
      tooLarge: false,
    });
  });

  it('`---` na linha 3 não é front matter; sem fechamento → null; vazio é válido', () => {
    expect(detectFrontMatter('# T\n\n---\na: 1\n---\n')).toBeNull();
    expect(detectFrontMatter('---\na: 1\nsem fim\n')).toBeNull();
    expect(detectFrontMatter('---')).toBeNull();
    expect(detectFrontMatter('----\na\n---\n')).toBeNull();
    expect(detectFrontMatter('---\n---\n')).toMatchObject({ contentFrom: 4, contentTo: 4 });
  });

  it('257 KB de conteúdo → bloco detectado com `tooLarge`', () => {
    const body = 'k: v\n'.repeat(Math.ceil((257 * 1024) / 5));
    const found = detectFrontMatter(`---\n${body}---\ncorpo\n`);
    expect(found?.tooLarge).toBe(true);
    expect(found!.contentTo - found!.contentFrom).toBeGreaterThan(FRONT_MATTER_MAX_CONTENT);
  });
});

describe('nó Lezer FrontMatter (FR-7, C-R2-4)', () => {
  it('no topo da árvore; `title: x\\n---` não vira SetextHeading nem o `---` vira HorizontalRule', () => {
    const doc = '---\ntitle: x\n---\n\n# Corpo\n';
    expect(topNodes(createMarkdownState(doc))).toEqual(['FrontMatter:0-16', 'ATXHeading1:18-25']);
  });

  it('sem fechamento → nenhum nó (a regra horizontal volta a ser regra)', () => {
    const nodes = topNodes(createMarkdownState('---\ntitle: x\n\ntexto\n'));
    expect(nodes[0]).toBe('HorizontalRule:0-3');
    expect(nodes.some((n) => n.startsWith('FrontMatter'))).toBe(false);
  });

  it('`---` que começa na linha 3 não é front matter', () => {
    const nodes = topNodes(createMarkdownState('texto\n\n---\na: 1\n---\n'));
    expect(nodes.some((n) => n.startsWith('FrontMatter'))).toBe(false);
  });

  it('257 KB: o nó existe mesmo sem o YAML ser lido', () => {
    const doc = `---\n${'k: v\n'.repeat(53_000)}---\n# fim\n`;
    expect(topNodes(createMarkdownState(doc))[0]).toBe(
      `FrontMatter:0-${doc.indexOf('\n---\n') + 4}`,
    );
  });

  it('incremental: digitar o fechamento de um bloco longo (> 128 caracteres) cria o nó', () => {
    const open = `---\n${'chave: valor qualquer\n'.repeat(12)}`;
    let state = createMarkdownState(`${open}\n# Título\n`);
    expect(topNodes(state)[0]).toBe('HorizontalRule:0-3');
    state = state.update({ changes: { from: open.length, insert: '---\n' } }).state;
    expect(topNodes(state)[0]).toBe(`FrontMatter:0-${open.length + 3}`);
    // E apagar o fechamento desfaz o nó.
    state = state.update({ changes: { from: open.length, to: open.length + 4 } }).state;
    expect(topNodes(state)[0]).toBe('HorizontalRule:0-3');
  });

  it('acessor protegido: devolve o Input do BlockContext e `null` sem ele', () => {
    const fake = { input: { read: (a: number, b: number) => 'x'.repeat(b - a), length: 3 } };
    expect(readInput(fake as unknown as BlockContext)?.read(0, 2)).toBe('xx');
    expect(readInput({} as unknown as BlockContext)).toBeNull();
    expect(readInput({ input: { length: 1 } } as unknown as BlockContext)).toBeNull();
  });
});

describe('live preview do front matter (FME-CLASS, AC-9.11 metade da decoração)', () => {
  it('linhas com cm-md-frontmatter, cercas com -delim, nenhuma decoração de markdown dentro', () => {
    const doc = '---\n# não é título\n- não é lista\ntitle: **x**\n---\n\n# Corpo\n';
    const { inline } = decorate(previewState(doc, { anchor: doc.length }));
    const end = doc.indexOf('\n\n# Corpo');
    const inside = inline.filter((d) => d.from <= end);
    expect(inside.map((d) => [d.kind, d.class, d.from])).toEqual([
      ['line', 'cm-md-frontmatter cm-md-frontmatter-delim', 0],
      ['line', 'cm-md-frontmatter', 4],
      ['line', 'cm-md-frontmatter', 19],
      ['line', 'cm-md-frontmatter', 33],
      ['line', 'cm-md-frontmatter cm-md-frontmatter-delim', 46],
    ]);
    expect(inline.some((d) => d.class === 'cm-md-h1' && d.from > end)).toBe(true);
  });
});
