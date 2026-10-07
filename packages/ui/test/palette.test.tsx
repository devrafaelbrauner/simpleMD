import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CommandPalette, type PaletteItem } from '../src';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ITEMS: readonly PaletteItem[] = [
  { id: 'ai.summarize', label: 'IA: Resumir' },
  { id: 'export.html', label: 'Exportar como HTML…' },
];

function palette(open: boolean, onRun = vi.fn()) {
  return (
    <CommandPalette
      open={open}
      initialQuery="IA: "
      getItems={() => ITEMS}
      onClose={() => {}}
      onRun={onRun}
    />
  );
}

/** Todo valor que o React grava no campo de busca, na ordem (o que cada quadro mostraria). */
function recordSearchValues(): string[] {
  const seen: string[] = [];
  const own = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
  vi.spyOn(HTMLInputElement.prototype, 'value', 'set').mockImplementation(function (
    this: HTMLInputElement,
    value: string,
  ) {
    if (this.dataset.testid === 'palette-input') seen.push(value);
    own.set!.call(this, value);
  });
  return seen;
}

describe('<CommandPalette> (L5)', () => {
  test('A11Y-R2-03: reabrir nunca mostra a busca anterior, nem por um quadro', () => {
    const { rerender } = render(palette(true));
    fireEvent.change(screen.getByTestId('palette-input'), { target: { value: 'IA: Resumir' } });
    rerender(palette(false));
    const seen = recordSearchValues();
    rerender(palette(true));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((value) => value === 'IA: ')).toBe(true);
    expect((screen.getByTestId('palette-input') as HTMLInputElement).value).toBe('IA: ');
    expect(screen.getByRole('status').textContent).toBe('');
  });

  test('A11Y-R2-02: o foco que o comando já moveu não volta para quem abriu a paleta', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const opener = document.body.appendChild(document.createElement('button'));
    const card = document.body.appendChild(document.createElement('button'));
    opener.focus();
    const { rerender } = render(palette(true));
    expect(document.activeElement).toBe(screen.getByTestId('palette-input'));
    rerender(palette(false));
    // O comando (resposta instantânea da IA) leva o foco ao cartão antes da devolução do Radix.
    card.focus();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(document.activeElement).toBe(card);

    // Sem comando que mova o foco (Esc), ele volta para quem abriu.
    opener.focus();
    rerender(palette(true));
    rerender(palette(false));
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(document.activeElement).toBe(opener);
    vi.useRealTimers();
    opener.remove();
    card.remove();
  });
});
