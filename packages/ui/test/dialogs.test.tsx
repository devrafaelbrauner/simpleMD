import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useLayoutEffect, useRef } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AlertDialog, ConflictDialog, Dialog, Notices, UnsavedCloseDialog, Welcome } from '../src';

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

  test('boas-vindas: "Abrir pasta…" focado; alerta de permissão; engrenagem abre as configurações', () => {
    const onOpenVault = vi.fn();
    const onOpenSettings = vi.fn();
    const props = { onOpenVault, onOpenSettings };
    const { rerender } = render(<Welcome opening={false} error={null} {...props} />);
    expect(document.activeElement?.textContent).toBe('Abrir pasta…');
    expect(screen.getByRole('alert').textContent).toBe('');
    rerender(<Welcome opening={false} error={{ kind: 'denied' }} {...props} />);
    expect(screen.getByRole('alert').textContent).toContain(
      'Sem permissão para acessar esta pasta.',
    );
    rerender(<Welcome opening error={null} {...props} />);
    fireEvent.click(screen.getByTestId('open-vault'));
    expect(onOpenVault).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Configurações' }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});

describe('correções da QA (fase 4)', () => {
  test('EC F-6: em cada contêiner o aviso mais novo fica em cima', () => {
    render(
      <Notices
        onDismiss={() => {}}
        items={[
          { id: 'i1', kind: 'info', notice: 'external-reload', text: 'info 1' },
          { id: 'e1', kind: 'error', notice: 'save-failed', text: 'erro 1' },
          { id: 'i2', kind: 'info', notice: 'external-reload', text: 'info 2' },
          { id: 'e2', kind: 'error', notice: 'save-failed', text: 'erro 2' },
        ]}
      />,
    );
    const titles = (role: 'alert' | 'status') =>
      [...screen.getByRole(role).querySelectorAll('.smd-notice-title')].map((p) => p.textContent);
    expect(titles('alert')).toEqual(['erro 2', 'erro 1']);
    expect(titles('status')).toEqual(['info 2', 'info 1']);
  });

  test('a11y F-3 / EC F-2 e UIF F-04: L1 é modal (aria-modal) numa camada acima de L2/L3', () => {
    render(
      <ConflictDialog
        conflict={{ id: 'c1', name: 'nota.md', reason: 'external-change' }}
        failed={false}
        busy={false}
        onKeepBoth={() => {}}
        onReload={() => {}}
        onShown={() => {}}
      />,
    );
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.classList.contains('smd-dialog-alert')).toBe(true);
    expect(document.querySelector('.smd-overlay.smd-overlay-alert')).not.toBeNull();
  });

  test('L4 também é modal e fica na camada de alerta', () => {
    render(<UnsavedCloseDialog paths={['nota.md']} onBack={() => {}} onDiscard={() => {}} />);
    const dialog = screen.getByRole('alertdialog', { name: 'Algumas alterações não foram salvas' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.classList.contains('smd-dialog-alert')).toBe(true);
  });

  test('r7 B1: Esc logo após o alerta abrir sobre o L2 fecha só o alerta (Esc = onEscape, 1×)', () => {
    const onClose = vi.fn();
    const onEscape = vi.fn();
    /** Esc no mesmo commit que abre o alerta: antes dos efeitos passivos que trocam a camada do Radix. */
    function EscOnOpen() {
      useLayoutEffect(() => {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
      }, []);
      return null;
    }
    function Stack({ alert }: { alert: boolean }) {
      const cancel = useRef<HTMLButtonElement>(null);
      return (
        <>
          <Dialog open onClose={onClose} title="Configurações" footer={null}>
            <p>L2</p>
          </Dialog>
          <AlertDialog
            open={alert}
            title="Aviso"
            description="Texto"
            initialFocus={cancel}
            onEscape={onEscape}
            footer={<button ref={cancel}>Cancelar</button>}
          />
          {alert && <EscOnOpen />}
        </>
      );
    }
    const { rerender } = render(<Stack alert={false} />);
    rerender(<Stack alert />);
    expect(onClose).not.toHaveBeenCalled();
    expect(onEscape).toHaveBeenCalledOnce();
    // Com a camada do Radix já trocada, um Esc continua chamando `onEscape` uma vez só.
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
  });

  test('r7 B1: onClosed roda com o alerta já fora do DOM e o foco dado ali fica (sem quadro no <body>)', () => {
    const removed: boolean[] = [];
    function Host({ open }: { open: boolean }) {
      const cancel = useRef<HTMLButtonElement>(null);
      const opener = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={opener}>Abrir</button>
          <AlertDialog
            open={open}
            title="Aviso"
            description="Texto"
            initialFocus={cancel}
            onClosed={() => {
              removed.push(document.querySelector('[role="alertdialog"]') === null);
              opener.current?.focus();
            }}
            footer={<button ref={cancel}>Cancelar</button>}
          />
        </>
      );
    }
    const { rerender } = render(<Host open />);
    expect(document.activeElement?.textContent).toBe('Cancelar');
    rerender(<Host open={false} />);
    expect(removed).toEqual([true]);
    expect(document.activeElement?.textContent).toBe('Abrir');
  });
});
