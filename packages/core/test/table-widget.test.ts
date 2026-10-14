// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('r14: formatação em linha nas células e rolagem do invólucro', () => {
  const cells = (doc: string) => [
    ...tableWidget(doc).widget.toDOM().querySelectorAll<HTMLElement>('tbody td'),
  ];
  // Um só stub: o widget guarda o 1º `ResizeObserver` criado (singleton do módulo).
  let resize: ResizeObserverCallback | undefined;
  const observed = new Set<Element>();
  class ResizeObserverStub {
    constructor(callback: ResizeObserverCallback) {
      resize = callback;
    }
    observe(target: Element) {
      observed.add(target);
    }
    unobserve(target: Element) {
      observed.delete(target);
    }
    disconnect() {}
  }
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('negrito, itálico (* e _), negrito+itálico, tachado e código sem os marcadores', () => {
    const doc =
      '| a | b | c | d | e | f |\n|---|---|---|---|---|---|\n' +
      '| **Atropina** | *x* _y_ | ***z*** | ~~w~~ | `mg` | dose **3 mg** total |\n';
    const [strong, em, both, strike, code, mixed] = cells(doc);
    expect(strong!.textContent).toBe('Atropina');
    expect(strong!.querySelector('.cm-md-strong')?.textContent).toBe('Atropina');
    expect(em!.textContent).toBe('x y');
    expect([...em!.querySelectorAll('.cm-md-em')].map((s) => s.textContent)).toEqual(['x', 'y']);
    expect(both!.textContent).toBe('z');
    expect(both!.querySelector('.cm-md-em .cm-md-strong, .cm-md-strong .cm-md-em')).not.toBeNull();
    expect(strike!.querySelector('.cm-md-strike')?.textContent).toBe('w');
    expect(strike!.textContent).toBe('w');
    expect(code!.querySelector('.cm-md-code')?.textContent).toBe('mg');
    expect(code!.textContent).toBe('mg');
    expect(mixed!.textContent).toBe('dose 3 mg total');
  });

  it('link e autolink: só o rótulo com cm-md-link, sem href nem role; o resto fica cru', () => {
    const doc =
      '| a | b |\n|---|---|\n' +
      '| [t](https://u) <https://v> [r] | [[Nota]] ![i](x.png) $x$ `**k**` |\n';
    const [links, raw] = cells(doc);
    expect(links!.textContent).toBe('t https://v [r]');
    const spans = [...links!.querySelectorAll('.cm-md-link')];
    expect(spans.map((s) => [s.tagName, s.textContent])).toEqual([
      ['SPAN', 't'],
      ['SPAN', 'https://v'],
    ]);
    expect(links!.querySelector('a, [href], [role]')).toBeNull();
    expect(raw!.textContent).toBe('[[Nota]] ![i](x.png) $x$ **k**');
    expect(raw!.querySelector('.cm-md-code .cm-md-strong, img')).toBeNull();
  });

  it('injeção: <img onerror>, <script> e <b> viram texto, inclusive dentro do negrito', () => {
    const html = '<b>x</b><img src=x onerror=alert(1)><script>alert(2)</script>';
    const [plain, bold] = cells(`| a | b |\n|---|---|\n| ${html} | **${html}** |\n`);
    expect(plain!.textContent).toBe(html);
    expect(bold!.textContent).toBe(html);
    expect(bold!.querySelector('.cm-md-strong')?.textContent).toBe(html);
    for (const td of [plain!, bold!]) {
      expect(td.querySelector('b, img, script')).toBeNull();
      const attrs = [td, ...td.querySelectorAll('*')].flatMap((el) => el.getAttributeNames());
      expect(attrs.filter((name) => name.startsWith('on'))).toEqual([]);
    }
  });

  it('célula faltante fica vazia (não puxa a vizinha) e \\| dentro da formatação é pipe', () => {
    const rows = cells('| a | b |\n|---|---|\n| **x** |\n| **x \\| y** | z |\n');
    expect(rows.map((td) => td.textContent)).toEqual(['x', '', 'x | y', 'z']);
    expect(rows[1]!.childElementCount).toBe(0);
    expect(rows[2]!.querySelector('.cm-md-strong')?.textContent).toBe('x | y');
  });

  it('\\\\| é barra invertida escapada seguida de separador: divide como o Lezer (S-1)', () => {
    const rows = cells('| a | b | c |\n|---|---|---|\n| x \\\\| y | z |\n');
    expect(rows.map((td) => td.textContent)).toEqual(['x \\\\', 'y', 'z']);
  });

  it('ênfase aninhada que estoura a pilha do Lezer: toDOM não lança (célula cai no texto cru, N2)', () => {
    // Limiares do Node em `appsec-r14/deep-jsdom-vitest.txt` (n=1250 e n=2000 lançavam).
    for (const n of [1250, 2000]) {
      const deep = '*a _b '.repeat(n) + 'x' + ' b_ a*'.repeat(n);
      const dom = new TableWidget(`| id | profundo |\n| --- | --- |\n| n | ${deep} |`).toDOM();
      expect(dom.querySelectorAll('tbody td')[1]?.textContent).toContain('x');
    }
  }, 30_000);

  it('clique sobre o trecho formatado põe o cursor nesse texto da fonte (MNC-R14-1)', () => {
    const doc = 'x\n\n| a | b |\n| --- | --- |\n| **Atropina** | dose `mg` |\n';
    const view = new EditorView({
      state: previewState(doc, { anchor: 0, focus: false }),
      parent: document.body.appendChild(document.createElement('div')),
    });
    views.push(view);
    for (const [selector, text] of [
      ['td .cm-md-strong', 'Atropina'],
      ['td .cm-md-code', 'mg'],
    ] as const) {
      const span = view.contentDOM.querySelector(selector);
      expect(span).not.toBeNull();
      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
      span!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      const head = view.state.selection.main.head;
      expect(view.state.doc.sliceString(head, head + text.length)).toBe(text);
    }
  });

  it('tabindex e ←/→/Home/End só quando o invólucro transborda (D-R14-04)', () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    const wrap = tableWidget('| a | b |\n|---|---|\n| 1 | 2 |\n').widget.toDOM();
    expect(resize).toBeDefined();
    const size = (scrollWidth: number, clientWidth: number) => {
      Object.defineProperties(wrap, {
        scrollWidth: { value: scrollWidth, configurable: true },
        clientWidth: { value: clientWidth, configurable: true },
      });
      resize!([{ target: wrap } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    };
    const key = (name: string, target: Element = wrap) => {
      const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    Object.defineProperty(wrap, 'scrollLeft', { value: 0, writable: true });

    size(300, 300);
    expect(wrap.hasAttribute('tabindex')).toBe(false);
    expect(key('ArrowRight')).toBe(false);
    expect(wrap.scrollLeft).toBe(0);

    size(600, 300);
    expect(wrap.getAttribute('tabindex')).toBe('0');
    expect(key('ArrowRight')).toBe(true);
    expect(wrap.scrollLeft).toBe(40);
    expect(key('End')).toBe(true);
    expect(wrap.scrollLeft).toBe(600);
    expect(key('ArrowLeft')).toBe(true);
    expect(wrap.scrollLeft).toBe(560);
    expect(key('Home')).toBe(true);
    expect(wrap.scrollLeft).toBe(0);
    // Tecla vinda de dentro do invólucro (não dele mesmo) não rola.
    expect(key('ArrowRight', wrap.querySelector('td')!)).toBe(false);
    expect(wrap.scrollLeft).toBe(0);
    expect(key('a')).toBe(false);

    size(300, 300);
    expect(wrap.hasAttribute('tabindex')).toBe(false);
  });

  it('destroy deixa de observar o invólucro', () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    const { widget } = tableWidget('| a |\n|---|\n| 1 |\n');
    const wrap = widget.toDOM();
    expect(observed.has(wrap)).toBe(true);
    widget.destroy(wrap);
    expect(observed.has(wrap)).toBe(false);
  });
});
