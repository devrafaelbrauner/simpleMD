import type { Entry } from '@simplemd/vault';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Explorer, buildRows, explorerKeyReducer, type ExplorerProps } from '../src';

// O jsdom não faz layout: a área rolável do explorador passa a medir 240 × 600.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(240);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SMALL: Entry[] = [
  { path: 'sub', name: 'sub', kind: 'dir' },
  { path: 'sub/deep', name: 'deep', kind: 'dir' },
  { path: 'sub/deep/d.md', name: 'd.md', kind: 'file' },
  { path: 'sub/c.md', name: 'c.md', kind: 'file' },
  { path: 'a.md', name: 'a.md', kind: 'file' },
  { path: 'nota.md', name: 'nota.md', kind: 'file' },
];

function entries2000(): Entry[] {
  const list: Entry[] = [];
  for (let d = 1; d <= 20; d++) {
    const folder = `pasta-${String(d).padStart(2, '0')}`;
    list.push({ path: folder, name: folder, kind: 'dir' });
    for (let n = 1; n <= 100; n++) {
      const name = `nota-${String(n).padStart(3, '0')}.md`;
      list.push({ path: `${folder}/${name}`, name, kind: 'file' });
    }
  }
  return list;
}

describe('buildRows', () => {
  test('pastas recolhidas escondem os descendentes; posinset/setsize vêm da lista completa', () => {
    const collapsed = buildRows(SMALL, {});
    expect(collapsed.map((r) => r.path)).toEqual(['sub', 'a.md', 'nota.md']);
    expect(collapsed.map((r) => `${r.posinset}/${r.setsize}`)).toEqual(['1/3', '2/3', '3/3']);
    const open = buildRows(SMALL, { sub: true });
    expect(open.map((r) => `${r.path}@${r.level}`)).toEqual([
      'sub@1',
      'sub/deep@2',
      'sub/c.md@2',
      'a.md@1',
      'nota.md@1',
    ]);
    expect(open[1]).toMatchObject({ expanded: false, posinset: 1, setsize: 2, parent: 'sub' });
    expect(buildRows(SMALL, { sub: true, 'sub/deep': true })).toHaveLength(6);
  });
});

describe('explorerKeyReducer (AC-2.16)', () => {
  const rows = buildRows(SMALL, { sub: true });
  test.each([
    ['ArrowDown', 0, { type: 'focus', index: 1 }],
    ['ArrowDown', 4, { type: 'focus', index: 4 }],
    ['ArrowUp', 0, { type: 'focus', index: 0 }],
    ['Home', 3, { type: 'focus', index: 0 }],
    ['End', 0, { type: 'focus', index: 4 }],
    ['ArrowRight', 0, { type: 'focus', index: 1 }],
    ['ArrowRight', 1, { type: 'toggle', path: 'sub/deep' }],
    ['ArrowRight', 3, { type: 'none' }],
    ['ArrowLeft', 2, { type: 'focus', index: 0 }],
    ['ArrowLeft', 0, { type: 'toggle', path: 'sub' }],
    ['ArrowLeft', 3, { type: 'none' }],
    ['Enter', 3, { type: 'open', path: 'a.md' }],
    [' ', 1, { type: 'toggle', path: 'sub/deep' }],
    ['x', 1, { type: 'none' }],
    ['ArrowDown', -1, { type: 'focus', index: 0 }],
  ] as const)('%s na linha %i', (key, focused, expected) => {
    expect(explorerKeyReducer(rows, focused, key)).toEqual(expected);
  });
});

/** Explorador controlado, como o app o usa. */
function Harness(
  props: Partial<ExplorerProps> & { entries: Entry[]; onOpen?: (path: string) => void },
) {
  const [expanded, setExpanded] = useState<Record<string, true>>(props.expanded ?? {});
  const [focused, setFocused] = useState<string | null>(null);
  return (
    <Explorer
      status="ready"
      activePath={null}
      onRetry={() => {}}
      onPickOther={() => {}}
      onOpenVault={() => {}}
      onNewNote={() => {}}
      folderColors={new Map()}
      live=""
      rowHeight={20}
      {...props}
      expanded={expanded}
      focusedPath={focused}
      onFocusPath={setFocused}
      onToggle={(path) =>
        setExpanded((prev) => {
          const next = { ...prev };
          if (next[path]) delete next[path];
          else next[path] = true;
          return next;
        })
      }
      onOpen={props.onOpen ?? (() => {})}
    />
  );
}

describe('<Explorer>', () => {
  test('árvore nomeada "Arquivos" com treeitems e atributos ARIA; um único item com tabindex 0', () => {
    render(<Harness entries={SMALL} />);
    expect(screen.getByRole('navigation', { name: 'Arquivos' })).toBeDefined();
    const tree = screen.getByRole('tree', { name: 'Arquivos' });
    const items = screen.getAllByRole('treeitem');
    expect(items.map((i) => i.dataset.path)).toEqual(['sub', 'a.md', 'nota.md']);
    expect(items[0]?.getAttribute('aria-expanded')).toBe('false');
    expect(items[1]?.getAttribute('aria-expanded')).toBeNull();
    expect(items.map((i) => i.getAttribute('aria-level'))).toEqual(['1', '1', '1']);
    expect(items.filter((i) => i.tabIndex === 0)).toHaveLength(1);
    expect(tree.contains(items[0]!)).toBe(true);
  });

  test('teclado: → expande, ↓ move, Enter abre o arquivo', () => {
    const onOpen = vi.fn();
    render(<Harness entries={SMALL} onOpen={onOpen} />);
    const tree = screen.getByRole('tree');
    screen.getAllByRole('treeitem')[0]!.focus();
    fireEvent.keyDown(tree, { key: 'ArrowRight' });
    expect(screen.getAllByRole('treeitem').map((i) => i.dataset.path)).toContain('sub/c.md');
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('data-path')).toBe('sub/c.md');
    fireEvent.keyDown(tree, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('sub/c.md');
  });

  test('clique: pasta alterna, arquivo abre', () => {
    const onOpen = vi.fn();
    render(<Harness entries={SMALL} onOpen={onOpen} />);
    fireEvent.click(screen.getByText('sub'));
    expect(screen.getAllByRole('treeitem')).toHaveLength(5);
    fireEvent.click(screen.getByText('nota.md'));
    expect(onOpen).toHaveBeenCalledWith('nota.md');
  });

  test('NFR-3: 2.000 arquivos expandidos montam ≤ 60 linhas e o item itinerante continua montado', () => {
    const list = entries2000();
    const expanded = Object.fromEntries(
      list.filter((e) => e.kind === 'dir').map((e) => [e.path, true as const]),
    );
    render(<Harness entries={list} expanded={expanded} />);
    const rows = screen.getAllByRole('treeitem');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(60);
    const tree = screen.getByRole('tree');
    rows[0]!.focus();
    fireEvent.keyDown(tree, { key: 'End' });
    const last = screen
      .getAllByRole('treeitem')
      .find((r) => r.dataset.path === 'pasta-20/nota-100.md');
    expect(last?.getAttribute('aria-posinset')).toBe('100');
    expect(last?.getAttribute('aria-setsize')).toBe('100');
    expect(last?.tabIndex).toBe(0);
    expect(screen.getAllByRole('treeitem').length).toBeLessThanOrEqual(60);
  });

  test('estados: vazio sem role=tree, erro com "Tentar novamente", negado com "Escolher outra pasta…"', () => {
    const onRetry = vi.fn();
    const onPickOther = vi.fn();
    const { rerender } = render(<Harness entries={[]} />);
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Nenhum arquivo .md nesta pasta.');
    rerender(<Harness entries={[]} status="error" onRetry={onRetry} />);
    expect(screen.getByRole('alert').textContent).toContain(
      'Não foi possível listar os arquivos da pasta.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(onRetry).toHaveBeenCalledOnce();
    rerender(<Harness entries={[]} status="denied" onPickOther={onPickOther} />);
    fireEvent.click(screen.getByRole('button', { name: 'Escolher outra pasta…' }));
    expect(onPickOther).toHaveBeenCalledOnce();
  });

  test('carregando: o indicador só aparece depois de 150 ms', () => {
    vi.useFakeTimers();
    try {
      render(<Harness entries={[]} status="loading" />);
      expect(screen.queryByText('Carregando arquivos…')).toBeNull();
      act(() => vi.advanceTimersByTime(150));
      expect(screen.getByText('Carregando arquivos…')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('<Explorer> com cores de pasta (r12 AC-12.1, AC-12.12, R-12.4, D-R12-U4)', () => {
  const TREE: Entry[] = [
    { path: 'Financeiro', name: 'Financeiro', kind: 'dir' },
    { path: 'Financeiro/f.md', name: 'f.md', kind: 'file' },
    { path: 'Projetos', name: 'Projetos', kind: 'dir' },
    { path: 'Projetos/b', name: 'b', kind: 'dir' },
    { path: 'Projetos/b/c', name: 'c', kind: 'dir' },
    { path: 'Projetos/b/c/n.md', name: 'n.md', kind: 'file' },
    { path: 'x.md', name: 'x.md', kind: 'file' },
  ];
  const COLORS = new Map([
    ['Financeiro', 'red'],
    ['Projetos', 'blue'],
    ['Projetos/b/c', 'teal'],
  ] as const);

  test('bolinha só na pasta com cor própria, depois do nome; herdeira, nota e recolhida sem nada', () => {
    render(
      <Harness
        entries={TREE}
        expanded={{ Financeiro: true, Projetos: true }}
        folderColors={COLORS}
      />,
    );
    const rows = screen.getAllByRole('treeitem');
    expect(rows.map((r) => [r.dataset.path, r.querySelector('.smd-folder-dot') !== null])).toEqual([
      ['Financeiro', true],
      ['Financeiro/f.md', false],
      ['Projetos', true],
      ['Projetos/b', false],
      ['x.md', false],
    ]);
    const dot = screen.getByRole('img', { name: 'cor vermelha' });
    expect(dot.dataset.folderColor).toBe('red');
    expect(dot.previousElementSibling?.className).toBe('smd-row-name');
    // Nome do treeitem = nome + "cor <forma falada>". O jsdom não aplica `display` (itens flex), então
    // não põe o espaço que o navegador põe entre os dois; o leitor real é conferido na Fase 4.
    screen.getByRole('treeitem', { name: /^Financeiro ?cor vermelha$/ });
    screen.getByRole('treeitem', { name: /^Projetos ?cor azul$/ });
    expect(screen.queryByRole('img', { name: 'cor azul-petróleo' })).toBeNull();
  });

  test('a região do anúncio existe antes do texto e mostra o que o comando disse', () => {
    const { rerender } = render(<Harness entries={TREE} />);
    const nav = screen.getByRole('navigation', { name: 'Arquivos' });
    const live = nav.querySelector('p.sr-only[role=status]');
    expect(live?.textContent).toBe('');
    rerender(<Harness entries={TREE} live="Pasta “b”: cor azul." />);
    expect(nav.querySelector('p.sr-only[role=status]')).toBe(live);
    expect(live?.textContent).toBe('Pasta “b”: cor azul.');
  });
});
