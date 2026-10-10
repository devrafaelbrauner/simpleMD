import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  EditorSection,
  PluginManager,
  SettingsDialog,
  StatusBar,
  type PluginRow,
  type SettingsDialogProps,
} from '../src';

/** r7 ST — C6 barra de status, L2 Editor, 5 seções e opções genéricas de plugin. */
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('<StatusBar> (DESIGN §R7.6.9)', () => {
  const base = { tabToggleKey: 'Ctrl-m', ltCheckKey: 'Mod-Shift-o', onLtAction: vi.fn() };

  test('grupo "Barra de status" só com os itens ativos, na ordem Vim → Tab → LT', () => {
    render(<StatusBar {...base} vim="visual-line" tab="focus" lt={{ state: 'not-found' }} />);
    const bar = screen.getByRole('group', { name: 'Barra de status' });
    expect(bar.querySelector('[data-testid="status-vim"]')?.textContent).toBe('VISUAL LINHA');
    expect(screen.getByTestId('status-tab').textContent).toBe('Tab: move o focoCtrl+M');
    expect(screen.getByTestId('status-tab').getAttribute('data-mode')).toBe('focus');
    const lt = screen.getByRole('button', {
      name: 'LanguageTool: servidor não encontrado em localhost:8081',
    });
    expect(lt.getAttribute('aria-haspopup')).toBe('menu');
    expect(lt.getAttribute('data-state')).toBe('not-found');
    const order = [...bar.querySelectorAll('[data-testid^="status-"]')].map((e) =>
      e.getAttribute('data-testid'),
    );
    expect(order).toEqual(['status-vim', 'status-tab', 'status-lt', 'status-live']);
  });

  test('anúncios do LT: falha na entrada, "voltou" na recuperação, contagem só após 2 s', () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <StatusBar {...base} vim={null} tab={null} lt={{ state: 'checking' }} />,
    );
    const live = screen.getByTestId('status-live');
    expect(live.textContent).toBe('');
    rerender(<StatusBar {...base} vim={null} tab={null} lt={{ state: 'timeout' }} />);
    expect(live.textContent).toBe('LanguageTool: sem resposta (tempo esgotado)');
    rerender(<StatusBar {...base} vim={null} tab={null} lt={{ state: 'issues', count: 3 }} />);
    expect(live.textContent).toBe('LanguageTool voltou: 3 problemas.');
    rerender(<StatusBar {...base} vim={null} tab={null} lt={{ state: 'issues', count: 1 }} />);
    expect(live.textContent).toBe('LanguageTool voltou: 3 problemas.');
    act(() => vi.advanceTimersByTime(2000));
    expect(live.textContent).toBe('LanguageTool: 1 problema');
  });
});

describe('<EditorSection> (DESIGN §R7.6.7, STR-157)', () => {
  test('interruptor "Tecla Tab no editor" descrito pela ajuda; aviso de valor inválido', () => {
    const onChange = vi.fn();
    render(<EditorSection captureTab={false} onCaptureTabChange={onChange} invalid />);
    const toggle = screen.getByRole('switch', { name: 'Tecla Tab no editor' });
    expect(toggle.getAttribute('data-testid')).toBe('set-capture-tab');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    const help = document.getElementById(toggle.getAttribute('aria-describedby') ?? '');
    expect(help?.textContent).toContain(
      'Desligada: Tab sai do editor e vai para o próximo controle.',
    );
    expect(help?.textContent).toContain(
      'Esc e depois Tab, ou Ctrl+M para Tab voltar a mover o foco.',
    );
    expect(screen.getByTestId('set-capture-tab-invalid').textContent).toBe(
      'Valor inválido em editor.captureTab; usando “Desligado”.',
    );
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  test('L2: 5 seções com "Editor" em segundo; foco inicial no interruptor', () => {
    const switchRef = { current: null as HTMLButtonElement | null };
    const props = {
      open: true,
      onClose: vi.fn(),
      themes: [{ id: 't', name: 'T' }],
      themeId: 't',
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
      section: 'editor',
      onSectionChange: vi.fn(),
      plugins: null,
      liveMessage: '',
      editorInitialFocus: switchRef,
      editor: (
        <EditorSection
          captureTab
          onCaptureTabChange={vi.fn()}
          invalid={false}
          switchRef={switchRef}
        />
      ),
    } satisfies SettingsDialogProps;
    render(<SettingsDialog {...props} />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Aparência',
      'Editor',
      'Autocompletar',
      'IA',
      'Plugins',
    ]);
    expect(document.activeElement).toBe(screen.getByTestId('set-capture-tab'));
  });
});

describe('<PluginManager> opções genéricas (DA-R7-12)', () => {
  const row: PluginRow = {
    key: 'simplemd.lt',
    name: 'Ortografia',
    version: '0.1.0',
    id: 'simplemd.lt',
    folder: 'simplemd.lt',
    description: null,
    status: 'Desativado',
    reason: '',
    checked: false,
    toggleable: true,
    busy: false,
    source: 'internal',
    hasOptions: true,
  };

  test('"Opções" expande o grupo; select com lang; mudança vai para onOptionChange', async () => {
    const onOptionChange = vi.fn(async () => ({ ok: true as const }));
    render(
      <PluginManager
        vaultOpen
        scan="idle"
        internal={[row]}
        external={[]}
        onReload={vi.fn()}
        onToggle={vi.fn()}
        onOptionChange={onOptionChange}
        optionsOf={() => ({
          fields: [
            {
              key: 'lang',
              kind: 'select',
              label: 'Idioma padrão',
              choices: [
                { value: 'pt-BR', label: 'Português (Brasil)', lang: 'pt-BR' },
                { value: 'en-US', label: 'English (US)', lang: 'en-US' },
              ],
            },
            { key: 'dict', kind: 'info', label: 'Dicionário pessoal' },
          ],
          values: { lang: 'pt-BR' },
          info: async () => '3 palavras',
        })}
      />,
    );
    const toggle = screen.getByRole('button', { name: 'Opções de “Ortografia”' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const group = screen.getByRole('group', { name: 'Opções de “Ortografia”' });
    expect(group.id).toBe(toggle.getAttribute('aria-controls'));
    const select = screen.getByLabelText('Idioma padrão');
    expect(select.querySelector('option[value="en-US"]')?.getAttribute('lang')).toBe('en-US');
    fireEvent.change(select, { target: { value: 'en-US' } });
    expect(onOptionChange).toHaveBeenCalledWith('simplemd.lt', 'lang', 'en-US');
    expect(await screen.findByText('3 palavras')).toBeTruthy();
  });

  test('carga de interno: "Carregando…" depois de 150 ms e interruptor aria-disabled', () => {
    vi.useFakeTimers();
    render(
      <PluginManager
        vaultOpen
        scan="idle"
        internal={[{ ...row, hasOptions: false, busy: true }]}
        external={[]}
        onReload={vi.fn()}
        onToggle={vi.fn()}
      />,
    );
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByTestId('plugin-status').textContent).toBe('Carregando…');
    expect(screen.getByRole('switch').getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByTestId('plugin-options-toggle')).toBeNull();
  });
});
