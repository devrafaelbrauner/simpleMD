import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
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

describe('<CommandPalette> 2º passo (r12 D-R12-U1/F3; AC-12.1, AC-12.3)', () => {
  const COLORS = [
    ['red', 'Vermelho'],
    ['blue', 'Azul'],
    ['teal', 'Azul-petróleo'],
  ] as const;

  function Stateful({ onRun, stepRun }: { onRun(id: string): void; stepRun(id: string): void }) {
    const [open, setOpen] = useState(true);
    const items: PaletteItem[] = [
      {
        id: 'app:folder-set-color',
        label: 'Pasta: definir cor…',
        detail: 'pasta “a/b”',
        step: () => ({
          label: 'Cor para “b”',
          placeholder: 'Cor para “b”…',
          active: 'blue',
          options: COLORS.map(([id, label]) => ({
            id,
            label,
            swatch: id,
            ...(id === 'blue' ? { detail: 'cor atual' } : {}),
          })),
          run: stepRun,
        }),
      },
      { id: 'app:outro', label: 'Outro comando' },
    ];
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          reabrir
        </button>
        <CommandPalette
          open={open}
          initialQuery=""
          getItems={() => items}
          onClose={() => setOpen(false)}
          onRun={onRun}
        />
      </>
    );
  }

  const input = () => screen.getByTestId('palette-input') as HTMLInputElement;

  test('Enter troca a lista na mesma caixa: busca vazia, rótulos do passo, bolinhas e cor atual', () => {
    render(<Stateful onRun={vi.fn()} stepRun={vi.fn()} />);
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(input().value).toBe('');
    expect(input().placeholder).toBe('Cor para “b”…');
    screen.getByRole('combobox', { name: 'Cor para “b”' });
    const list = screen.getByRole('listbox', { name: 'Cor para “b”' });
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.dataset.commandId)).toEqual(['red', 'blue', 'teal']);
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    expect(options[1]?.textContent).toContain('cor atual');
    const dot = options[0]?.querySelector('.smd-palette-swatch > .smd-folder-dot');
    expect(dot?.getAttribute('data-folder-color')).toBe('red');
    expect(dot?.getAttribute('aria-hidden')).toBe('true');
    expect(list.querySelectorAll('[data-folder-color]')).toHaveLength(3);
  });

  test('filtro "az" → Azul, Azul-petróleo; Enter fecha e roda o passo no quadro seguinte', async () => {
    const onRun = vi.fn();
    const stepRun = vi.fn();
    render(<Stateful onRun={onRun} stepRun={stepRun} />);
    fireEvent.keyDown(input(), { key: 'Enter' });
    fireEvent.change(input(), { target: { value: 'az' } });
    expect(screen.getAllByRole('option').map((o) => o.dataset.commandId)).toEqual(['blue', 'teal']);
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(screen.queryByTestId('palette')).toBeNull();
    expect(stepRun).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(stepRun).toHaveBeenCalledWith('teal'));
    expect(onRun).not.toHaveBeenCalled();
  });

  test('Esc em qualquer passo fecha tudo sem rodar nada; reabrir volta à lista de comandos', async () => {
    const onRun = vi.fn();
    const stepRun = vi.fn();
    render(<Stateful onRun={onRun} stepRun={stepRun} />);
    fireEvent.keyDown(input(), { key: 'Enter' });
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(screen.queryByTestId('palette')).toBeNull();
    fireEvent.click(screen.getByText('reabrir'));
    screen.getByRole('combobox', { name: 'Buscar comando' });
    expect(screen.getAllByRole('option').map((o) => o.dataset.commandId)).toEqual([
      'app:folder-set-color',
      'app:outro',
    ]);
    fireEvent.keyDown(input(), { key: 'Escape' });
    await act(async () => {
      const frame = Promise.withResolvers<number>();
      requestAnimationFrame(frame.resolve);
      await frame.promise;
    });
    expect(stepRun).not.toHaveBeenCalled();
    expect(onRun).not.toHaveBeenCalled();
  });
});
