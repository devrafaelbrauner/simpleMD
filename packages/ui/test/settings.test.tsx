import { DEFAULT_EXPLORER_APPEARANCE } from '@simplemd/themes';
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
    section: 'appearance',
    onSectionChange: vi.fn(),
    explorer: DEFAULT_EXPLORER_APPEARANCE,
    onExplorerChange: vi.fn(),
    plugins: null,
    liveMessage: '',
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
      within(within(dialog).getByRole('combobox', { name: 'Família' }))
        .getAllByRole('option')
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
    // r2 (DESIGN §8.13, UX-R2-D8; corrige UIF R2-N1): a linha de persistência mora na faixa de
    // status fixa, visível em toda seção, junto da região viva local do diálogo.
    const strip = dialog.querySelector('.smd-dialog-status');
    expect(strip?.querySelector('[data-testid="settings-persistence"]')).not.toBeNull();
    expect(strip?.querySelector('[data-testid="settings-live"]')?.getAttribute('role')).toBe(
      'status',
    );
  });
});

describe('<SettingsDialog> seção Explorador (r13 R-13.1, AC-13.2, AC-13.6, AC-13.12; D-R13-U1/U2)', () => {
  const DOT_HINT =
    'Intensidade e Onde aplicar valem para Faixa lateral, Cartão e Cartão com degradê.';
  const select = (name: string) => screen.getByRole<HTMLSelectElement>('combobox', { name });
  const options = (name: string) => [...select(name).options].map((o) => [o.value, o.textContent]);
  const describedBy = (el: HTMLElement) => el.getAttribute('aria-describedby')?.split(' ') ?? [];

  test('depois de "Fonte do editor": título, 4 controles nesta ordem, rótulos e opções literais', () => {
    setup();
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings.slice(-2)).toEqual(['Fonte do editor', 'Explorador']);
    const section = screen.getByRole('heading', { name: 'Explorador' }).closest('section');
    if (!section) throw new Error('sem seção');
    const labels = [
      ...section.querySelectorAll<HTMLInputElement | HTMLSelectElement>('select, input'),
    ].map((el) => el.labels?.[0]?.textContent);
    expect(labels).toEqual([
      'Estilo',
      'Arco-íris nas pastas do topo',
      'Intensidade',
      'Onde aplicar',
    ]);
    expect(options('Estilo')).toEqual([
      ['dot', 'Bolinha'],
      ['stripe', 'Faixa lateral'],
      ['card', 'Cartão'],
      ['gradient', 'Cartão com degradê'],
    ]);
    expect(options('Intensidade')).toEqual([
      ['subtle', 'Sutil'],
      ['medium', 'Média'],
      ['strong', 'Forte'],
    ]);
    expect(options('Onde aplicar')).toEqual([
      ['own', 'Só pastas com cor'],
      ['inherit', 'Também subpastas, em tom mais claro'],
    ]);
    expect(within(section).getByText('Notas nunca são coloridas.').id).toBe(
      'settings-explorer-scope-hint',
    );
  });

  test('Bolinha: Intensidade e Onde aplicar desabilitados com o motivo visível e lido; valor guardado fica', () => {
    setup({ explorer: { style: 'dot', auto: 'off', intensity: 'strong', scope: 'inherit' } });
    const hint = screen.getByText(DOT_HINT);
    expect(hint.id).toBe('settings-explorer-dot-hint');
    expect(select('Intensidade').disabled).toBe(true);
    expect(select('Onde aplicar').disabled).toBe(true);
    expect(select('Estilo').disabled).toBe(false);
    expect(select('Intensidade').value).toBe('strong');
    expect(select('Onde aplicar').value).toBe('inherit');
    expect(describedBy(select('Estilo'))).toEqual([
      'settings-explorer-style-hint',
      'settings-explorer-dot-hint',
    ]);
    expect(describedBy(select('Intensidade'))).toEqual(['settings-explorer-dot-hint']);
    expect(describedBy(select('Onde aplicar'))).toEqual([
      'settings-explorer-scope-hint',
      'settings-explorer-dot-hint',
    ]);
    // O motivo fica logo acima do par desabilitado (D-R13-D06).
    const order = hint.compareDocumentPosition(select('Intensidade'));
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const rainbow = screen.getByRole<HTMLInputElement>('switch', {
      name: 'Arco-íris nas pastas do topo',
    });
    expect(rainbow.disabled).toBe(false);
  });

  test('fora de Bolinha os 4 habilitam e o motivo sai', () => {
    setup({ explorer: { ...DEFAULT_EXPLORER_APPEARANCE, style: 'card' } });
    expect(screen.queryByText(DOT_HINT)).toBeNull();
    expect(select('Intensidade').disabled).toBe(false);
    expect(select('Onde aplicar').disabled).toBe(false);
    expect(describedBy(select('Estilo'))).toEqual(['settings-explorer-style-hint']);
    expect(select('Intensidade').hasAttribute('aria-describedby')).toBe(false);
    expect(describedBy(select('Onde aplicar'))).toEqual(['settings-explorer-scope-hint']);
  });

  test('cada controle aplica no onChange com um patch de 1 campo; o switch mostra Ligado/Desligado', () => {
    const { props, view } = setup({
      explorer: { ...DEFAULT_EXPLORER_APPEARANCE, style: 'stripe' },
    });
    fireEvent.change(select('Estilo'), { target: { value: 'gradient' } });
    fireEvent.change(select('Intensidade'), { target: { value: 'subtle' } });
    fireEvent.change(select('Onde aplicar'), { target: { value: 'inherit' } });
    const rainbow = screen.getByRole('switch', { name: 'Arco-íris nas pastas do topo' });
    expect(screen.getByText('Desligado')).toBeDefined();
    fireEvent.click(rainbow);
    expect(vi.mocked(props.onExplorerChange).mock.calls).toEqual([
      [{ style: 'gradient' }],
      [{ intensity: 'subtle' }],
      [{ scope: 'inherit' }],
      [{ auto: 'rainbow' }],
    ]);
    view.rerender(<SettingsDialog {...props} explorer={{ ...props.explorer, auto: 'rainbow' }} />);
    expect(screen.getByText('Ligado')).toBeDefined();
    fireEvent.click(rainbow);
    expect(vi.mocked(props.onExplorerChange)).toHaveBeenLastCalledWith({ auto: 'off' });
  });

  test('Esc fecha sem desfazer: só onClose, nenhuma mudança a mais', () => {
    const { props } = setup();
    fireEvent.change(select('Estilo'), { target: { value: 'card' } });
    fireEvent.keyDown(select('Estilo'), { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(vi.mocked(props.onExplorerChange).mock.calls).toEqual([[{ style: 'card' }]]);
  });
});
