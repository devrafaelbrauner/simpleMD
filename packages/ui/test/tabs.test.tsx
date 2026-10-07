import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EditorPanel, TabBar, tabDomId, type TabView } from '../src';

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
