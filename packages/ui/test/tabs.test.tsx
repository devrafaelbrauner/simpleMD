import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FOLDER_COLOR_IDS } from '@simplemd/themes';
import { EditorPanel, FOLDER_COLOR_SPOKEN, TabBar, tabDomId, type TabView } from '../src';

afterEach(cleanup);

const TABS: TabView[] = [
  { id: 'a/nota.md', path: 'a/nota.md', name: 'nota.md', folder: 'a', saveState: 'clean' },
  { id: 'b/nota.md', path: 'b/nota.md', name: 'nota.md', folder: 'b', saveState: 'dirty' },
  { id: 'x.md', path: 'x.md', name: 'x.md', saveState: 'error' },
  { id: 'y.md', path: 'y.md', name: 'y.md', saveState: 'conflict' },
];

describe('<TabBar> (R-2.8, AC-2.15)', () => {
  test('tablist "Arquivos abertos", aria-selected, nomes com o sufixo do estado, sem botão focável dentro da aba', () => {
    render(<TabBar tabs={TABS} activeId="b/nota.md" onActivate={() => {}} onClose={() => {}} />);
    screen.getByRole('tablist', { name: 'Arquivos abertos' });
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ]);
    // Nome exato (aria-label): sem espaço antes da vírgula em nenhum navegador (EC F-7 / a11y F-6).
    expect(screen.getByRole('tab', { name: 'nota.md · b, não salvo' }).dataset.saveState).toBe(
      'dirty',
    );
    expect(tabs.map((t) => t.getAttribute('aria-label'))).toEqual([
      'nota.md · a',
      'nota.md · b, não salvo',
      'x.md, erro ao salvar',
      'y.md, em conflito',
    ]);
    screen.getByRole('tab', { name: 'x.md, erro ao salvar' });
    screen.getByRole('tab', { name: 'y.md, em conflito' });
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0, -1, -1]);
    expect(tabs[1]?.id).toBe(tabDomId(1));
    expect(tabs[1]?.getAttribute('aria-controls')).toBe('editor-panel');
    // EC3-A11Y-1 (AC-B14.3): só a aba selecionada carrega aria-controls.
    expect(tabs.map((t) => t.getAttribute('aria-controls'))).toEqual([
      null,
      'editor-panel',
      null,
      null,
    ]);
    expect(
      screen.getByRole('tablist').querySelectorAll('button, [tabindex="0"] [tabindex]'),
    ).toHaveLength(0);
    expect(tabs[1]?.querySelector('[data-testid=tab-dirty]')).not.toBeNull();
    expect(
      screen.getAllByTestId('tab-close').every((g) => g.getAttribute('aria-hidden') === 'true'),
    ).toBe(true);
  });

  test('sem abas não há tablist (UX-D11)', () => {
    render(<TabBar tabs={[]} activeId={null} onActivate={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  test('clique ativa (e pede foco no editor); × fecha sem ativar; ←/→/Home/End ativam; Delete fecha a aba focada', () => {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    render(<TabBar tabs={TABS} activeId="a/nota.md" onActivate={onActivate} onClose={onClose} />);
    const tabs = screen.getAllByRole('tab');
    fireEvent.click(tabs[2]!);
    expect(onActivate).toHaveBeenLastCalledWith('x.md', { focusEditor: true });
    fireEvent.click(screen.getAllByTestId('tab-close')[3]!);
    expect(onClose).toHaveBeenLastCalledWith('y.md');
    expect(onActivate).toHaveBeenCalledTimes(1);
    const list = screen.getByRole('tablist');
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    expect(onActivate).toHaveBeenLastCalledWith('b/nota.md', { focusEditor: false });
    fireEvent.keyDown(list, { key: 'End' });
    expect(onActivate).toHaveBeenLastCalledWith('y.md', { focusEditor: false });
    fireEvent.keyDown(tabs[0]!, { key: 'Delete' });
    expect(onClose).toHaveBeenLastCalledWith('a/nota.md');
  });
});

describe('<TabBar> com cor de pasta (r12 AC-12.5, AC-12.11, AC-12.12; D-R12-09)', () => {
  const noop = () => {};
  const bar = (tabs: TabView[], activeId: string | null = null) =>
    render(<TabBar tabs={tabs} activeId={activeId} onActivate={noop} onClose={noop} />);

  test('sem cor: nem atributo, nem bolinha, nem origem (DOM de main, AC-12.2)', () => {
    const { container } = bar(TABS, 'a/nota.md');
    expect(container.querySelector('[data-folder-color], .smd-folder-dot, .smd-tab-origin')).toBe(
      null,
    );
  });

  test('com cor: atributo, bolinha aria-hidden à esquerda, origem em texto e nome acessível', () => {
    bar(
      [
        {
          id: 'p/ideias.md',
          path: 'p/ideias.md',
          name: 'ideias.md',
          saveState: 'clean',
          folderColor: { id: 'blue', origin: 'Projetos' },
        },
      ],
      'p/ideias.md',
    );
    const tab = screen.getByRole('tab', { name: 'ideias.md · pasta Projetos, cor azul' });
    expect(tab.dataset.folderColor).toBe('blue');
    const children = [...tab.children].map((el) => el.className);
    expect(children).toEqual(['smd-folder-dot', 'smd-tab-label', 'smd-tab-origin', 'smd-tab-slot']);
    expect(tab.querySelector('.smd-folder-dot')?.getAttribute('aria-hidden')).toBe('true');
    expect(tab.querySelector('.smd-tab-origin')?.textContent).toBe(' · Projetos');
    expect(tab.title).toBe('p/ideias.md');
  });

  test('5 estados: o sufixo vem depois da cor; erro/conflito com glifo; a cor não muda por estado', () => {
    const states = ['clean', 'saving', 'dirty', 'error', 'conflict'] as const;
    bar(
      states.map((saveState) => ({
        id: `f/${saveState}.md`,
        path: `f/${saveState}.md`,
        name: `${saveState}.md`,
        saveState,
        folderColor: { id: 'red', origin: 'Financeiro' },
      })),
    );
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-label'))).toEqual([
      'clean.md · pasta Financeiro, cor vermelha',
      'saving.md · pasta Financeiro, cor vermelha',
      'dirty.md · pasta Financeiro, cor vermelha, não salvo',
      'error.md · pasta Financeiro, cor vermelha, erro ao salvar',
      'conflict.md · pasta Financeiro, cor vermelha, em conflito',
    ]);
    expect(tabs.every((t) => t.dataset.folderColor === 'red')).toBe(true);
    expect(tabs[3]?.querySelector('.smd-tab-glyph-danger')).not.toBeNull();
    expect(tabs[4]?.querySelector('.smd-tab-glyph-danger')).not.toBeNull();
    expect(tabs[2]?.querySelector('[data-testid=tab-dirty]')).not.toBeNull();
  });

  test('duplicado: igual à origem aparece uma vez; diferente fica no rótulo antes da origem', () => {
    bar([
      {
        id: 'Projetos/ideias.md',
        path: 'Projetos/ideias.md',
        name: 'ideias.md',
        folder: 'Projetos',
        saveState: 'clean',
        folderColor: { id: 'blue', origin: 'Projetos' },
      },
      {
        id: 'Projetos/2026/notas.md',
        path: 'Projetos/2026/notas.md',
        name: 'notas.md',
        folder: '2026',
        saveState: 'clean',
        folderColor: { id: 'blue', origin: 'Projetos' },
      },
    ]);
    const [same, diff] = screen.getAllByRole('tab');
    expect(same?.getAttribute('aria-label')).toBe('ideias.md · pasta Projetos, cor azul');
    expect(same?.querySelector('.smd-tab-dup')).toBeNull();
    expect(diff?.getAttribute('aria-label')).toBe('notas.md · 2026 · pasta Projetos, cor azul');
    expect(diff?.querySelector('.smd-tab-dup')?.textContent).toBe(' · 2026');
  });

  test('as 8 cores no nome acessível (só vermelho muda de forma)', () => {
    bar(
      FOLDER_COLOR_IDS.map((id) => ({
        id: `${id}/n.md`,
        path: `${id}/n.md`,
        name: 'n.md',
        saveState: 'clean' as const,
        folderColor: { id, origin: id },
      })),
    );
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label'))).toEqual(
      FOLDER_COLOR_IDS.map((id) => `n.md · pasta ${id}, cor ${FOLDER_COLOR_SPOKEN[id]}`),
    );
    expect(Object.values(FOLDER_COLOR_SPOKEN)).toEqual([
      'vermelha',
      'laranja',
      'âmbar',
      'verde',
      'azul-petróleo',
      'azul',
      'violeta',
      'rosa',
    ]);
  });
});

describe('<EditorPanel>', () => {
  test('sem abas: estado vazio e o painel escondido; com aba: tabpanel rotulado pela aba', () => {
    const { rerender } = render(
      <EditorPanel labelledBy={null} openingName={null}>
        <div data-testid="editor" />
      </EditorPanel>,
    );
    expect(screen.getByText('Nenhum arquivo aberto')).toBeDefined();
    expect(screen.queryByRole('tabpanel')).toBeNull();
    expect(screen.getByTestId('editor')).toBeDefined();
    rerender(
      <EditorPanel labelledBy="tab-0" openingName={null}>
        <div data-testid="editor" />
      </EditorPanel>,
    );
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('tab-0');
    expect(screen.queryByText('Nenhum arquivo aberto')).toBeNull();
  });
});
