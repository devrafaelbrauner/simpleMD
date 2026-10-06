import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SettingsDialog, type SettingsDialogProps } from '../src';

afterEach(cleanup);

function setup(overrides: Partial<SettingsDialogProps> = {}) {
  const props: SettingsDialogProps = {
    open: true,
    onClose: vi.fn(),
    themes: [
      { id: 'simplemd-light', name: 'simpleMD Claro' },
      { id: 'simplemd-dark', name: 'simpleMD Escuro' },
    ],
    themeId: 'simplemd-light',
    onThemeChange: vi.fn(),
    fontFamily: 'JetBrains Mono',
    onFontFamilyChange: vi.fn(),
    fontSize: 15,
    onFontSizeChange: vi.fn(),
    ligatures: true,
    onLigaturesChange: vi.fn(),
    persistence: 'saved',
    ...overrides,
  };
  const view = render(<SettingsDialog {...props} />);
  return { props, view };
}

describe('<SettingsDialog> (L2, R-4.7)', () => {
  test('diálogo "Configurações", foco inicial em "Tema"; família com as 4 opções em ordem', () => {
    const { props } = setup();
    const dialog = screen.getByRole('dialog', { name: 'Configurações' });
    expect(document.activeElement).toBe(screen.getByLabelText('Tema'));
    expect(
      within(dialog)
        .getAllByRole('option')
        .slice(2)
        .map((o) => o.textContent),
    ).toEqual(['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Monospace do sistema']);
    fireEvent.change(screen.getByLabelText('Tema'), { target: { value: 'simplemd-dark' } });
    expect(props.onThemeChange).toHaveBeenCalledWith('simplemd-dark');
    fireEvent.change(screen.getByLabelText('Família'), { target: { value: 'Fira Code' } });
    expect(props.onFontFamilyChange).toHaveBeenCalledWith('Fira Code');
  });

  test('tamanho: texto cru ao digitar; 9 → 10 e 33 → 32 ao confirmar (AC-4.6, UX-D17)', () => {
    const { props } = setup();
    const size = screen.getByLabelText('Tamanho (px)');
    expect(size.getAttribute('aria-describedby')).toBe('settings-font-size-hint');
    expect(screen.getByText('Entre 10 e 32.').id).toBe('settings-font-size-hint');
    fireEvent.change(size, { target: { value: '9' } });
    expect(props.onFontSizeChange).not.toHaveBeenCalled();
    fireEvent.blur(size);
    expect(props.onFontSizeChange).toHaveBeenLastCalledWith(10);
    fireEvent.change(size, { target: { value: '33' } });
    fireEvent.keyDown(size, { key: 'Enter' });
    expect(props.onFontSizeChange).toHaveBeenLastCalledWith(32);
    fireEvent.change(size, { target: { value: '' } });
    fireEvent.blur(size);
    expect(props.onFontSizeChange).toHaveBeenCalledTimes(2);
    expect((size as HTMLInputElement).value).toBe('15');
  });

  test('ligaduras: role=switch com estado em texto', () => {
    const { props, view } = setup();
    const toggle = screen.getByRole('switch', { name: 'Ligaduras' });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Ativadas')).toBeDefined();
    fireEvent.click(toggle);
    expect(props.onLigaturesChange).toHaveBeenCalledWith(false);
    view.rerender(<SettingsDialog {...props} ligatures={false} />);
    expect(screen.getByText('Desativadas')).toBeDefined();
  });

  test.each([
    ['session', 'status', 'Sem pasta aberta: as preferências valem só nesta sessão.'],
    ['saved', 'status', 'As preferências são salvas em .simplemd/config.json.'],
    [
      'malformed',
      'status',
      'O arquivo .simplemd/config.json é inválido; as preferências valem só nesta sessão.',
    ],
    [
      'failed',
      'alert',
      'Não foi possível salvar as preferências em .simplemd/config.json. Elas valem só nesta sessão.',
    ],
  ] as const)('linha de persistência "%s" (STR-29/STR-47)', (persistence, role, text) => {
    setup({ persistence });
    const line = screen.getByTestId('settings-persistence');
    expect(line.getAttribute('role')).toBe(role);
    expect(line.textContent).toBe(text);
  });

  test('Esc e "Fechar" fecham', () => {
    const { props } = setup();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });
});
