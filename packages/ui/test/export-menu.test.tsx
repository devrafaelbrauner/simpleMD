import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ExportMenu } from '../src';

afterEach(cleanup);

function toolbar() {
  const onSelect = vi.fn();
  render(
    <div>
      <button type="button">Abrir pasta…</button>
      <ExportMenu disabledReason={null} busy={false} onSelect={onSelect} />
      <button type="button">Comandos</button>
    </div>,
  );
  return { trigger: screen.getByTestId('export-menu'), onSelect };
}

async function openWithKeyboard(trigger: HTMLElement) {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  await screen.findByRole('menu', { name: 'Exportar' });
  await vi.waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('menuitem'));
}

describe('<ExportMenu> M1 (arch-ux §6.2, A11Y-R2-04)', () => {
  test('Tab dentro do menu fecha e leva o foco ao elemento seguinte ao "Exportar"', async () => {
    const { trigger, onSelect } = toolbar();
    await openWithKeyboard(trigger);
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    });
    await vi.waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Comandos' })),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('Shift+Tab fecha e devolve o foco ao "Exportar"', async () => {
    const { trigger } = toolbar();
    await openWithKeyboard(trigger);
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    });
    await vi.waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
