// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { TableWidget } from '../src/live-preview/table';
import { decorate, decosIn, previewState } from './helpers/live-preview';
import fixture from './fixtures/live-preview.md?raw';

const tableFrom = fixture.indexOf('| Coluna');
const tableTo = fixture.indexOf('| 42 |') + '| 42 |'.length;

/** O widget da única tabela do documento, com o editor sem foco (nada revelado). */
function tableWidget(doc: string): { widget: TableWidget; from: number; to: number } {
  const blocks = decorate(previewState(doc, { anchor: 0, focus: false })).block;
  expect(blocks).toHaveLength(1);
  const [deco] = blocks;
  expect(deco?.widget).toBeInstanceOf(TableWidget);
  return { widget: deco!.widget as TableWidget, from: deco!.from, to: deco!.to };
}

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.innerHTML = '';
});

describe('tabela GFM (AC-3.7)', () => {
  it('cursor fora: widget de bloco cobrindo exatamente a fonte da tabela', () => {
    const { from, to } = tableWidget(fixture);
    expect([from, to]).toEqual([tableFrom, tableTo]);
    expect(decorate(previewState(fixture)).block[0]?.block).toBe(true);
  });

  it('DOM: <table> com th scope=col, mesmo nº de colunas e de linhas, alinhamento por coluna', () => {
    const dom = tableWidget(fixture).widget.toDOM();
    const table = dom.querySelector('table.cm-md-table');
    expect(table).not.toBeNull();
    const ths = [...dom.querySelectorAll('thead th')] as HTMLTableCellElement[];
    expect(ths.map((th) => th.textContent)).toEqual([
      'Coluna à esquerda',
      'Coluna centralizada',
      'Coluna à direita',
    ]);
    expect(ths.every((th) => th.scope === 'col')).toBe(true);
    expect(ths.map((th) => th.style.textAlign)).toEqual(['left', 'center', 'right']);
    const rows = [...dom.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    expect(rows.map((tr) => [...tr.children].map((td) => td.textContent))).toEqual([
      ['a', 'b', 'c'],
      ['texto', 'mais texto', '42'],
    ]);
    const tds = [...rows[1]!.children] as HTMLTableCellElement[];
    expect(tds.map((td) => td.style.textAlign)).toEqual(['left', 'center', 'right']);
  });

  it('conteúdo só por textContent: <b>x</b> numa célula aparece como texto', () => {
    const doc = '| h |\n| --- |\n| <b>x</b> |\n';
    const dom = tableWidget(doc).widget.toDOM();
    const td = dom.querySelector('tbody td')!;
    expect(td.textContent).toBe('<b>x</b>');
    expect(td.querySelector('b')).toBeNull();
    expect(td.getAttribute('style')).toBeNull();
  });

  it('células faltantes viram vazias, excedentes são ignoradas, \\| é texto', () => {
    const doc = '| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |\n| x \\| y | z |\n';
    const dom = tableWidget(doc).widget.toDOM();
    const rows = [...dom.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.children].map((td) => td.textContent),
    );
    expect(rows).toEqual([
      ['1', ''],
      ['1', '2'],
      ['x | y', 'z'],
    ]);
  });

  it('cursor dentro: sem widget, fonte crua com cm-md-table-src em cada linha', () => {
    for (const anchor of [tableFrom, tableFrom + 30, tableTo]) {
      const state = previewState(fixture, { anchor });
      const { block } = decorate(state);
      expect(block).toEqual([]);
      const lines = decosIn(state, tableFrom, tableTo);
      expect(lines.map((d) => d.class)).toEqual(Array(4).fill('cm-md-table-src'));
    }
  });

  it('sem foco (F-2): cursor dentro mantém o widget', () => {
    expect(
      decorate(previewState(fixture, { anchor: tableFrom + 3, focus: false })).block,
    ).toHaveLength(1);
  });

  it('tabela dentro de lista não vira widget (só tabelas de topo, C-1)', () => {
    const doc = 'x\n\n- item\n\n  | a | b |\n  | - | - |\n  | 1 | 2 |\n';
    expect(decorate(previewState(doc, { anchor: 0 })).block).toEqual([]);
  });

  it('eq compara a fonte: mesma tabela em outra posição reaproveita o DOM', () => {
    const a = tableWidget('| a |\n| - |\n| 1 |').widget;
    const b = tableWidget('texto\n\n| a |\n| - |\n| 1 |').widget;
    const c = tableWidget('| a |\n| - |\n| 2 |').widget;
    expect(a.eq(b)).toBe(true);
    expect(a.eq(c)).toBe(false);
    expect(a.estimatedHeight).toBeGreaterThan(0);
  });

  it('clique numa célula põe o cursor na fonte dessa célula e foca o editor', () => {
    const state = previewState(fixture, { anchor: 0, focus: false });
    const parent = document.body.appendChild(document.createElement('div'));
    const view = new EditorView({ state, parent });
    views.push(view);
    const cell = [...view.contentDOM.querySelectorAll('td')].find(
      (td) => td.textContent === 'mais texto',
    );
    expect(cell).toBeDefined();
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    cell!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const head = view.state.selection.main.head;
    expect(view.state.doc.sliceString(head, head + 'mais texto'.length)).toBe('mais texto');
    expect(head).toBeGreaterThan(tableFrom);
    expect(head).toBeLessThan(tableTo);
  });
});
