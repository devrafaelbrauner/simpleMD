import { EditorState } from '@codemirror/state';
import { computeToc, createMarkdownExtensions, readNoteProperties } from '@simplemd/core';
import type { CatalogSnapshot, IndexEntry } from '@simplemd/vault';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CatalogPanel,
  countText,
  dateText,
  foldText,
  PropertiesPanel,
  SidePanel,
  TocPanel,
  type SidePanelTab,
} from '../src';

// O jsdom não faz layout: a lista rolável mede 240 × 600 (como nos testes do explorador).
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(240);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const DAY = Date.UTC(2026, 0, 15, 12);

function entries2000(): IndexEntry[] {
  const list: IndexEntry[] = [];
  for (let i = 0; i < 2000; i++) {
    const folder = `pasta-${String(i % 20).padStart(2, '0')}`;
    list.push({
      path: `${folder}/nota-${String(i).padStart(4, '0')}.md`,
      title: i % 10 === 0 ? `Receita ${i}` : `Nota ${i}`,
      tags: i % 10 === 0 ? ['receita', 'doce', 'forno'] : ['outra'],
      date: i % 3 === 0 ? `2025-${String((i % 12) + 1).padStart(2, '0')}-10` : null,
      fmError: i === 5,
      mtime: DAY + i,
      size: 2000,
    });
  }
  return list;
}

const snapshot = (
  entries: IndexEntry[],
  extra: Partial<CatalogSnapshot> = {},
): CatalogSnapshot => ({
  status: 'ready',
  done: entries.length,
  total: entries.length,
  entries,
  version: 1,
  ...extra,
});

const rows = () => screen.queryAllByTestId('catalog-row');

describe('modelo do catálogo', () => {
  test('busca sem acento/caixa; contagem pt-BR; datas', () => {
    expect(foldText('Fubá Ação')).toBe('fuba acao');
    expect(countText(2000, 2000, false)).toBe('2.000 notas');
    expect(countText(1, 1, false)).toBe('1 nota');
    expect(countText(12, 2000, true)).toBe('12 de 2.000 notas');
    const base: IndexEntry = {
      path: 'a.md',
      title: 'A',
      tags: [],
      date: '2026-10-07',
      fmError: false,
      mtime: 0,
      size: 1,
    };
    expect(dateText(base)).toBe('07/10/2026');
    expect(dateText({ ...base, date: null, mtime: new Date(2026, 9, 6).getTime() })).toBe(
      '06/10/2026 (modificado)',
    );
    expect(dateText({ ...base, date: null, mtime: -1 })).toBe('');
  });
});

describe('AC-9.9 catálogo (C4.1)', () => {
  test('2.000 notas, ≤ 60 linhas montadas, busca, #tag, chip, ordenação e Enter abre', async () => {
    const onOpen = vi.fn();
    const onShown = vi.fn();
    render(
      <CatalogPanel
        snapshot={snapshot(entries2000())}
        activePath="pasta-00/nota-0000.md"
        onOpen={onOpen}
        onShown={onShown}
        rowHeight={56}
      />,
    );
    expect(screen.getByTestId('catalog-count').textContent).toBe('2.000 notas');
    const list = screen.getByRole('listbox', { name: 'Notas' });
    expect(rows().length).toBeGreaterThan(0);
    expect(rows().length).toBeLessThanOrEqual(60);
    expect(rows()[0]?.getAttribute('aria-setsize')).toBe('2000');
    expect(
      within(list)
        .getAllByRole('option')
        .filter((o) => o.tabIndex === 0),
    ).toHaveLength(1);
    const frame = Promise.withResolvers<void>();
    requestAnimationFrame(() => frame.resolve());
    await act(() => frame.promise);
    expect(onShown).toHaveBeenCalledOnce();

    const search = screen.getByRole('searchbox', { name: 'Buscar no catálogo' });
    fireEvent.change(search, { target: { value: 'RÉC' } });
    expect(screen.getByTestId('catalog-count').textContent).toBe('200 de 2.000 notas');
    fireEvent.change(search, { target: { value: '#receita' } });
    expect(screen.getByTestId('catalog-count').textContent).toBe('200 de 2.000 notas');

    // Clicar num chip aplica o filtro (o chip não é focável e não abre a nota).
    const chip = screen.getAllByTestId('catalog-tag').find((c) => c.dataset.tag === 'doce');
    expect(chip?.tabIndex).toBe(-1);
    expect(chip?.getAttribute('title')).toBe('Filtrar por #doce');
    fireEvent.click(chip!);
    expect((search as HTMLInputElement).value).toBe('#doce');
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect((search as HTMLInputElement).value).toBe('');

    // Ordenação: título (padrão), data (mais recentes), caminho.
    expect(rows()[0]?.textContent).toContain('Nota 1');
    const sort = screen.getByRole('combobox', { name: 'Ordenar por' });
    fireEvent.change(sort, { target: { value: 'date' } });
    // Mais recente primeiro: o mtime de 2026 (sem `date`) vence as datas de 2025.
    expect(rows()[0]?.dataset.path).toBe('pasta-19/nota-1999.md');
    expect(rows()[0]?.textContent).toContain('15/01/2026 (modificado)');
    fireEvent.change(sort, { target: { value: 'path' } });
    expect(rows()[0]?.dataset.path).toBe('pasta-00/nota-0000.md');
    expect(rows()[0]?.hasAttribute('data-active')).toBe(true);
    expect(rows()[0]?.querySelector('.smd-catalog-title')?.textContent).toBe('Receita 0');

    // Teclado: ↓, End (linha final montada), Home, Enter abre.
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'End' });
    expect(rows().some((r) => r.dataset.path === 'pasta-19/nota-1999.md')).toBe(true);
    expect(rows().length).toBeLessThanOrEqual(60);
    fireEvent.keyDown(list, { key: 'Home' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('pasta-00/nota-0000.md');
  });

  test('YAML inválido, data de mtime, "+N"; vazio, sem resultado e indexando', () => {
    const list = entries2000().slice(0, 10);
    const { rerender } = render(
      <CatalogPanel snapshot={snapshot(list)} activePath={null} onOpen={() => {}} rowHeight={56} />,
    );
    const broken = rows().find((r) => r.dataset.path === 'pasta-05/nota-0005.md');
    expect(broken?.textContent).toContain('YAML inválido');
    expect(broken?.textContent).toContain('(modificado)');
    const many = rows().find((r) => r.dataset.path === 'pasta-00/nota-0000.md');
    expect(many?.textContent).toContain('+1');

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzzz' } });
    expect(screen.queryByRole('listbox')).toBeNull();
    // CAT-NORESULTS: a mensagem fica num `role=status`.
    expect(screen.getByText('Nenhuma nota corresponde a “zzzz”.').getAttribute('role')).toBe(
      'status',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Limpar busca' }));
    expect(rows().length).toBe(10);

    rerender(
      <CatalogPanel snapshot={snapshot([])} activePath={null} onOpen={() => {}} rowHeight={56} />,
    );
    expect(screen.getByTestId('catalog-empty').textContent).toBe('Nenhuma nota nesta pasta.');
    rerender(
      <CatalogPanel
        snapshot={snapshot(list.slice(0, 3), { status: 'building', done: 3, total: 2000 })}
        activePath={null}
        onOpen={() => {}}
        rowHeight={56}
      />,
    );
    expect(screen.getByTestId('catalog-progress').textContent).toBe('Indexando… 3 de 2.000');
    expect(screen.getByTestId('catalog-progress').getAttribute('aria-live')).toBe('off');
  });

  test('a contagem filtrada é anunciada uma vez, 500 ms depois da última tecla', () => {
    vi.useFakeTimers();
    render(
      <CatalogPanel
        snapshot={snapshot(entries2000())}
        activePath={null}
        onOpen={() => {}}
        rowHeight={56}
      />,
    );
    const status = () =>
      screen
        .getAllByRole('status')
        .map((s) => s.textContent)
        .join('|');
    act(() => vi.advanceTimersByTime(600));
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'r' } });
    act(() => vi.advanceTimersByTime(300));
    fireEvent.change(search, { target: { value: 'receita' } });
    act(() => vi.advanceTimersByTime(499));
    expect(status()).not.toContain('200 de');
    act(() => vi.advanceTimersByTime(1));
    expect(status()).toContain('200 de 2.000 notas');
    expect(screen.getByTestId('catalog-count').getAttribute('aria-hidden')).toBe('true');
  });
});

describe('AC-9.5 / AC-9.4 sumário e propriedades', () => {
  const state = (doc: string) =>
    EditorState.create({ doc, extensions: createMarkdownExtensions() });

  test('sumário aninhado; clique leva à posição; estados vazios', () => {
    const doc = '# Um\n\n## Dois\n\n### Três\n\nSetext\n------\n';
    const onGo = vi.fn();
    render(<TocPanel hasTab entries={computeToc(state(doc))} onGo={onGo} />);
    const nav = screen.getByRole('navigation', { name: 'Sumário da nota' });
    const items = within(nav).getAllByTestId('toc-item');
    expect(items.map((b) => `${b.dataset.level}:${b.textContent}`)).toEqual([
      '1:Um',
      '2:Dois',
      '3:Três',
      '2:Setext',
    ]);
    expect(nav.querySelectorAll('ol ol ol')).toHaveLength(1);
    fireEvent.click(items[2]!);
    expect(onGo).toHaveBeenCalledWith(doc.indexOf('### Três'));
    cleanup();
    render(<TocPanel hasTab={false} entries={[]} onGo={onGo} />);
    expect(screen.getByText('Abra uma nota para ver o sumário.')).toBeTruthy();
    cleanup();
    render(<TocPanel hasTab entries={[]} onGo={onGo} />);
    expect(screen.getByText('Esta nota não tem títulos.')).toBeTruthy();
  });

  test('propriedades: 4 linhas com nome "<chave>: <valor>", chips, 0 campos editáveis, erro estático', () => {
    const doc = '---\ntitle: Bolo\ntags: [doce, forno]\ndate: 2026-10-07\nautor: Ana\n---\n# B\n';
    const onGo = vi.fn();
    const { container } = render(
      <PropertiesPanel hasTab properties={readNoteProperties(state(doc))} onGo={onGo} />,
    );
    const list = screen.getByRole('list', { name: 'Propriedades da nota' });
    const buttons = within(list).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'title: Bolo',
      'tags: [doce, forno]',
      'date: 2026-10-07',
      'autor: Ana',
    ]);
    expect(buttons[1]?.querySelectorAll('.smd-chip')).toHaveLength(2);
    expect(container.querySelectorAll('input, textarea, select, [contenteditable]')).toHaveLength(
      0,
    );
    fireEvent.click(buttons[1]!);
    expect(onGo).toHaveBeenCalledWith(doc.indexOf('tags:'));
    cleanup();

    render(
      <PropertiesPanel
        hasTab
        properties={readNoteProperties(state('---\na: 1\nb: c: d\n---\n'))}
        onGo={onGo}
      />,
    );
    const error = screen.getByTestId('props-error');
    expect(error.textContent).toBe(
      'Front matter inválido: linha 3: mapa aninhado numa chave em linha',
    );
    expect(error.getAttribute('role')).toBeNull();
    expect(error.closest('[aria-live]')).toBeNull();
    cleanup();

    render(<PropertiesPanel hasTab properties={{ kind: 'too-large' }} onGo={onGo} />);
    expect(screen.getByText('Front matter maior que 256 KB; não foi lido.')).toBeTruthy();
    cleanup();
    render(<PropertiesPanel hasTab properties={{ kind: 'none' }} onGo={onGo} />);
    expect(screen.getByText('Esta nota não tem front matter.')).toBeTruthy();
    cleanup();
    render(<PropertiesPanel hasTab={false} properties={{ kind: 'none' }} onGo={onGo} />);
    expect(screen.getByText('Abra uma nota para ver as propriedades.')).toBeTruthy();
  });

  test('aviso de tipo dentro do nome da linha; valor longo cortado com o texto inteiro no title', () => {
    const long = 'y'.repeat(300);
    render(
      <PropertiesPanel
        hasTab
        properties={readNoteProperties(state(`---\ntitle: 5\nnota: ${long}\n---\n`))}
        onGo={() => {}}
      />,
    );
    const [title, nota] = screen.getAllByTestId('props-row');
    expect(title?.getAttribute('aria-label')).toBe('title: 5 Aviso: title deve ser texto.');
    const value = nota?.querySelector('.smd-props-value');
    expect(value?.textContent).toBe(`${'y'.repeat(200)}…`);
    expect(value?.getAttribute('title')).toBe(long);
    expect(nota?.getAttribute('aria-label')).toBe(`nota: ${'y'.repeat(200)}…`);
  });

  /**
   * Palavras como o axe `label-content-name-mismatch` compara (WCAG 2.5.3): NFKD, tudo que não é
   * letra ou número vira espaço, minúsculas.
   */
  const words = (text: string) =>
    text
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  const contiguous = (haystack: string[], needle: string[]) =>
    haystack.some((_, i) => needle.every((word, j) => haystack[i + j] === word));

  test('EC2-A11Y-1: o texto visível de cada linha está, em ordem, dentro do nome (WCAG 2.5.3)', () => {
    // `nota` passa de 200 caracteres e é cortada no meio de uma palavra ("…palav…").
    const doc = `---\ntitle: Bolo de fubá\ntags: [receita, doce]\ndate: 2026-10-07\nautor: 5\nnota: ${'palavras '.repeat(40)}fim\n---\n`;
    render(<PropertiesPanel hasTab properties={readNoteProperties(state(doc))} onGo={() => {}} />);
    const rows = screen.getAllByTestId('props-row');
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      // `textContent` junta os nós de texto sem separador, como o "texto visível" do axe.
      const visible = words(row.textContent ?? '');
      expect(visible.length).toBeGreaterThan(1);
      expect(
        contiguous(words(row.getAttribute('aria-label') ?? ''), visible),
        row.textContent!,
      ).toBe(true);
    }
  });
});

describe('painel lateral com painéis do app', () => {
  test('abas Catálogo/Sumário/Propriedades; cada painel numa região nomeada', () => {
    const onActivate = vi.fn();
    render(
      <SidePanel
        open
        activeId={null}
        onActivate={onActivate}
        panels={[
          { kind: 'builtin', id: 'catalog', title: 'Catálogo', content: <p>lista</p> },
          { kind: 'builtin', id: 'toc', title: 'Sumário', content: <p>sumário</p> },
          { kind: 'builtin', id: 'properties', title: 'Propriedades', content: <p>props</p> },
        ]}
      />,
    );
    const tabs = within(screen.getByRole('tablist', { name: 'Painéis' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Catálogo', 'Sumário', 'Propriedades']);
    expect(screen.getByRole('region', { name: 'Catálogo' }).textContent).toBe('lista');
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    expect(onActivate).toHaveBeenCalledWith('toc');
  });

  test('EC2-U-1: o painel ativo some (plugin desligado) → ativa o vizinho à esquerda', () => {
    const plugin = (id: string, title: string): SidePanelTab => ({
      id,
      title,
      pluginName: 'P',
      el: document.createElement('div'),
      failed: false,
      ensureRendered: () => {},
    });
    const builtins: SidePanelTab[] = [
      { kind: 'builtin', id: 'catalog', title: 'Catálogo', content: <p>lista</p> },
      { kind: 'builtin', id: 'chat', title: 'Chat IA', content: <p>chat</p> },
    ];
    const onActivate = vi.fn();
    const panel = (panels: SidePanelTab[], activeId: string) => (
      <SidePanel open activeId={activeId} onActivate={onActivate} panels={panels} />
    );
    const { rerender } = render(panel([...builtins, plugin('p.t', 'T')], 'p.t'));
    rerender(panel(builtins, 'p.t'));
    expect(onActivate).toHaveBeenLastCalledWith('chat');
    // Entre dois painéis de plugin, o da esquerda continua sendo o escolhido.
    onActivate.mockClear();
    rerender(panel([...builtins, plugin('p.a', 'A'), plugin('p.b', 'B')], 'p.b'));
    rerender(panel([...builtins, plugin('p.b', 'B')], 'p.b'));
    expect(onActivate).not.toHaveBeenCalled();
    rerender(panel([...builtins, plugin('p.a', 'A'), plugin('p.b', 'B')], 'p.b'));
    rerender(panel([...builtins, plugin('p.a', 'A')], 'p.b'));
    expect(onActivate).toHaveBeenLastCalledWith('p.a');
  });
});
