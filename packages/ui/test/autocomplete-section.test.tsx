import { DEFAULT_AUTOCOMPLETE } from '@simplemd/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AutocompleteSection } from '../src';
import type * as PlatformKeys from '../src/lib/platform-keys';

const platform = vi.hoisted(() => ({ isMac: false }));
vi.mock('../src/lib/platform-keys', async (orig) => ({
  ...(await orig<typeof PlatformKeys>()),
  get isMac() {
    return platform.isMac;
  },
}));

afterEach(() => {
  cleanup();
  platform.isMac = false;
});

describe('L2 "Autocompletar" (AC-8.5 rótulos, SAC-CLAMP)', () => {
  test('interruptor, modo, mínimo (limitado ao confirmar), fontes e prefixo', () => {
    const onChange = vi.fn();
    render(<AutocompleteSection settings={DEFAULT_AUTOCOMPLETE} onChange={onChange} />);
    const toggle = screen.getByRole('switch', { name: 'Autocompletar' });
    expect(toggle.id).toBe('set-ac-enabled');
    expect(screen.getByText('Ligado')).toBeTruthy();
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenLastCalledWith({ enabled: false });
    fireEvent.change(screen.getByRole('combobox', { name: 'Quando sugerir' }), {
      target: { value: 'manual' },
    });
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'manual' });
    const min = screen.getByRole('spinbutton', { name: 'Mínimo de letras' });
    expect(min.getAttribute('aria-describedby')).toBe('set-ac-min-hint');
    fireEvent.change(min, { target: { value: '9' } });
    expect(onChange).not.toHaveBeenCalledWith({ minChars: 9 });
    fireEvent.blur(min);
    expect(onChange).toHaveBeenLastCalledWith({ minChars: 9 }); // o controlador limita a 5
    expect(screen.getByRole('group', { name: 'Fontes' })).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Notas ([[)' }));
    expect(onChange).toHaveBeenLastCalledWith({
      sources: { words: true, snippets: true, notes: false },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Prefixo dos snippets' }), {
      target: { value: ';' },
    });
    expect(onChange).toHaveBeenLastCalledWith({ snippetPrefix: ';' });
  });

  test('W-03 / STR-93: a dica mostra Ctrl+Espaço ou Ctrl+Shift+Espaço fora do macOS', () => {
    render(<AutocompleteSection settings={DEFAULT_AUTOCOMPLETE} onChange={vi.fn()} />);
    const hint = screen.getByText(/Para sugerir na hora:/);
    expect(hint.textContent).toBe('Para sugerir na hora: Ctrl+Espaço ou Ctrl+Shift+Espaço.');
    expect([...hint.querySelectorAll('kbd.smd-kbd')].map((k) => k.textContent)).toEqual([
      'Ctrl+Espaço',
      'Ctrl+Shift+Espaço',
    ]);
  });

  test('W-03: no macOS a dica não muda (Ctrl+Espaço ou ⌘⇧Espaço)', () => {
    platform.isMac = true;
    render(<AutocompleteSection settings={DEFAULT_AUTOCOMPLETE} onChange={vi.fn()} />);
    expect(screen.getByText(/Para sugerir na hora:/).textContent).toBe(
      'Para sugerir na hora: Ctrl+Espaço ou ⌘⇧Espaço.',
    );
  });
});
