// @vitest-environment jsdom
import { ensureSyntaxTree, forceParsing, syntaxTree } from '@codemirror/language';
import type * as Language from '@codemirror/language';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EditorHost, EMPTY_CONTRIBUTIONS } from '../src';

/**
 * r7 perf — CR-ST-14: o fallback de lista só completa o parse (`ensureSyntaxTree` até o fim, até
 * 50 ms por tecla num documento de vários MB) quando a árvore atual não cobre o item; CR-ST-04
 * (item fora da árvore atual) continua completando.
 */
const parse = vi.hoisted(() => ({ ensured: [] as number[] }));
vi.mock('@codemirror/language', async (importOriginal) => {
  const mod = await importOriginal<typeof Language>();
  return {
    ...mod,
    ensureSyntaxTree: (...args: Parameters<typeof mod.ensureSyntaxTree>) => {
      parse.ensured.push(args[1]);
      return mod.ensureSyntaxTree(...args);
    },
  };
});

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
});

function mount(doc: string, anchor: number) {
  const host = new EditorHost({ ...EMPTY_CONTRIBUTIONS, captureTab: false, pluginExtensions: [] });
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new EditorView({ state: host.createState(doc, { notePath: 'a/b.md' }), parent });
  view.dispatch({ selection: { anchor } });
  views.push(view);
  return view;
}

/** `Mod-]` pelo atalho real; devolve as posições pedidas a `ensureSyntaxTree` durante a tecla. */
function indent(view: EditorView): number[] {
  parse.ensured.length = 0;
  const event = new KeyboardEvent('keydown', { key: ']', ctrlKey: true, bubbles: true, cancelable: true });
  expect(runScopeHandlers(view, event, 'editor')).toBe(true);
  return [...parse.ensured];
}

const PARA = 'parágrafo de texto comum.\n\n';

describe('CR-ST-14: completar o parse só quando a árvore atual não cobre o item', () => {
  test('lista no início de um documento grande: usa a árvore atual, sem ensureSyntaxTree', () => {
    const doc = `- a\n- b\n  - c\n\n${PARA.repeat(40_000)}`;
    const view = mount(doc, '- a\n- b'.length);
    // O que o parse de fundo faz depois de abrir (viewport + ~1e5 caracteres), sem relógio.
    expect(forceParsing(view, 50_000, 1e9)).toBe(true);
    const tree = syntaxTree(view.state).length;
    expect(tree).toBeGreaterThanOrEqual(50_000);
    expect(tree).toBeLessThan(doc.length);
    expect(indent(view)).toEqual([]);
    expect(view.state.doc.sliceString(0, 19)).toBe('- a\n  - b\n    - c\n\n');
  });

  test('item que chega ao fim da árvore atual: completa até o fim (subitens juntos)', () => {
    const head = PARA.repeat(600);
    const doc = `${head}- a\n- b\n  - c\n\nfim.\n`;
    const view = mount(doc, head.length + '- a\n- b'.length);
    expect(ensureSyntaxTree(view.state, doc.length, 1e9)?.length).toBe(doc.length);
    expect(syntaxTree(view.state).length).toBeLessThan(head.length);
    expect(indent(view)).toEqual([doc.length]);
    expect(view.state.doc.sliceString(head.length)).toBe('- a\n  - b\n    - c\n\nfim.\n');
  });

  test('árvore completa: nenhuma chamada', () => {
    const doc = '- a\n- b\n  - c\n';
    const view = mount(doc, '- a\n- b'.length);
    expect(syntaxTree(view.state).length).toBe(doc.length);
    expect(indent(view)).toEqual([]);
    expect(view.state.doc.toString()).toBe('- a\n  - b\n    - c\n');
  });
});
