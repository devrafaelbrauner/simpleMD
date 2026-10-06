import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConflictDialog, Notices, UnsavedCloseDialog, Welcome } from '../src';

afterEach(cleanup);

describe('<ConflictDialog> (L1, R-2.10, D-3)', () => {
  test('alertdialog com só "Manter ambos" (foco inicial) e "Recarregar do disco"; Esc não fecha', () => {
    const onKeepBoth = vi.fn();
    const onReload = vi.fn();
    const onShown = vi.fn();
    render(
      <ConflictDialog
        conflict={{ id: 'c1', name: 'nota.md', reason: 'external-change' }}
        failed={false}
        busy={false}
        onKeepBoth={onKeepBoth}
        onReload={onReload}
        onShown={onShown}
      />,
    );
    const dialog = screen.getByRole('alertdialog', { name: 'Conflito em “nota.md”' });
    expect(dialog.textContent).toContain('“nota (conflito AAAA-MM-DD HH-mm-ss).md”');
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Recarregar do disco', 'Manter ambos']);
    expect(document.activeElement?.textContent).toBe('Manter ambos');
    expect(onShown).toHaveBeenCalledOnce();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('alertdialog')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Manter ambos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Recarregar do disco' }));
    expect(onKeepBoth).toHaveBeenCalledOnce();
    expect(onReload).toHaveBeenCalledOnce();
  });

  test('arquivo removido usa o texto STR-45; falha mostra STR-21; ocupado bloqueia cliques', () => {
    const onKeepBoth = vi.fn();
    render(
      <ConflictDialog
        conflict={{ id: 'c2', name: 'nota.md', reason: 'deleted' }}
        failed
        busy
        onKeepBoth={onKeepBoth}
        onReload={() => {}}
        onShown={() => {}}
      />,
    );
    expect(screen.getByRole('alertdialog').textContent).toContain('o original não é recriado');
    expect(screen.getByTestId('conflict-error').textContent).toBe(
      'Não foi possível criar a cópia de conflito. Nenhum arquivo foi alterado.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Manter ambos' }));
    expect(onKeepBoth).not.toHaveBeenCalled();
  });
});

describe('<UnsavedCloseDialog> (L4)', () => {
  test('lista os arquivos; foco inicial e Esc = "Voltar"; "Fechar sem salvar" descarta', () => {
    const onBack = vi.fn();
    const onDiscard = vi.fn();
    render(
      <UnsavedCloseDialog paths={['nota.md', 'sub/c.md']} onBack={onBack} onDiscard={onDiscard} />,
    );
    const dialog = screen.getByRole('alertdialog', { name: 'Algumas alterações não foram salvas' });
    expect(dialog.querySelectorAll('li')).toHaveLength(2);
    expect(document.activeElement?.textContent).toBe('Voltar');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onBack).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar sem salvar' }));
    expect(onDiscard).toHaveBeenCalledOnce();
  });
});

describe('<Notices> e <Welcome>', () => {
  test('erros em role=alert, informação em role=status; info some após 8 s', () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      render(
        <Notices
          onDismiss={onDismiss}
          items={[
            {
              id: 'n1',
              kind: 'info',
              notice: 'external-reload',
              text: 'Arquivo alterado fora do simpleMD; recarregado',
              detail: 'nota.md',
            },
            {
              id: 'n2',
              kind: 'error',
              notice: 'save-failed',
              text: 'Não foi possível salvar “a.md”.',
            },
          ]}
        />,
      );
      expect(screen.getByRole('status').textContent).toContain('recarregado');
      expect(screen.getByRole('alert').textContent).toContain('Não foi possível salvar');
      vi.advanceTimersByTime(7999);
      expect(onDismiss).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onDismiss).toHaveBeenCalledWith('n1');
      fireEvent.click(screen.getAllByRole('button', { name: 'Fechar aviso' })[0]!);
      expect(onDismiss).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('boas-vindas: "Abrir pasta…" focado; alerta de permissão', () => {
    const onOpenVault = vi.fn();
    const { rerender } = render(<Welcome opening={false} error={null} onOpenVault={onOpenVault} />);
    expect(document.activeElement?.textContent).toBe('Abrir pasta…');
    expect(screen.getByRole('alert').textContent).toBe('');
    rerender(<Welcome opening={false} error={{ kind: 'denied' }} onOpenVault={onOpenVault} />);
    expect(screen.getByRole('alert').textContent).toContain(
      'Sem permissão para acessar esta pasta.',
    );
    rerender(<Welcome opening error={null} onOpenVault={onOpenVault} />);
    fireEvent.click(screen.getByTestId('open-vault'));
    expect(onOpenVault).not.toHaveBeenCalled();
  });
});
