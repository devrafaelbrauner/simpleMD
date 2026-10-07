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
    onOpenThemeEditor: vi.fn(),
    canImport: true,
    onImportFile: vi.fn(),
    importError: null,
    onExport: vi.fn(),
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

describe('<SettingsDialog> importar/exportar (L2, etapa 5)', () => {
  test('ordem dos botões; editor de temas e exportar chamam os callbacks', () => {
    const { props } = setup();
    const names = screen.getAllByRole('button').map((b) => b.textContent);
    expect(names.slice(0, 3)).toEqual(['Editor de temas…', 'Importar tema…', 'Exportar tema…']);
    fireEvent.click(screen.getByRole('button', { name: 'Editor de temas…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exportar tema…' }));
    expect(props.onOpenThemeEditor).toHaveBeenCalledOnce();
    expect(props.onExport).toHaveBeenCalledOnce();
  });

  test('sem diálogo nativo: o botão aciona o input de arquivo e o arquivo chega a onImportFile', () => {
    const { props } = setup();
    const input = screen.getByTestId<HTMLInputElement>('set-import-input');
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Importar tema…' }));
    expect(click).toHaveBeenCalledOnce();
    const file = new File(['{}'], 'tema.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(props.onImportFile).toHaveBeenCalledWith(file);
  });

  test('com diálogo nativo: sem input de arquivo; o botão chama onImport', () => {
    const onImport = vi.fn();
    setup({ onImport });
    expect(screen.queryByTestId('set-import-input')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Importar tema…' }));
    expect(onImport).toHaveBeenCalledOnce();
  });

  test('sem pasta: importar fica aria-disabled com o motivo STR-39 e não faz nada', () => {
    const onImport = vi.fn();
    setup({ canImport: false, onImport });
    const button = screen.getByRole('button', { name: 'Importar tema…' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(
      document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('Abra uma pasta para salvar ou importar temas.');
    fireEvent.click(button);
    expect(onImport).not.toHaveBeenCalled();
  });

  test('erro de importação: alerta com a mensagem, que recebe o foco (AC-5.9)', () => {
    const { props, view } = setup();
    const alert = screen.getByTestId('set-import-error');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toBe('');
    const message = 'Tema inválido — campo “tokens.--bg”: nome fora do padrão. Nada foi gravado.';
    view.rerender(<SettingsDialog {...props} importError={message} />);
    expect(alert.textContent).toBe(message);
    expect(document.activeElement).toBe(alert);
  });
});

describe('<SettingsDialog> correções da QA (fase 4)', () => {
  test('a11y F-3 / EC F-2: L2 é modal (aria-modal) e o cabeçalho/rodapé seguem a estrutura do diálogo', () => {
    setup();
    const dialog = screen.getByRole('dialog', { name: 'Configurações' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // L2 não tem faixa de status: a linha de persistência fica no corpo (DESIGN §8.7).
    expect(dialog.querySelector('.smd-dialog-status')).toBeNull();
  });
});
