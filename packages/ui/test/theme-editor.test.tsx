import {
  BUILTIN_THEMES,
  REQUIRED_TOKENS,
  darkOverrides,
  resolveTokens,
  simplemdDark,
  simplemdLight,
  type ThemeDraft,
} from '@simplemd/themes';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ThemeEditorDialog, type ThemeEditorDialogProps } from '../src';
import { pickerValue, withAlpha } from '../src/theme-editor/draft';

afterEach(cleanup);

// Cores digitadas nos testes: nenhuma é valor congelado de token (design-ack §5.4 T-4).
const NEW_BG = '#102030';
const NEW_BG_ALPHA = '#10203080';

function setup(overrides: Partial<ThemeEditorDialogProps> = {}) {
  const props: ThemeEditorDialogProps = {
    open: true,
    onClose: vi.fn(),
    themes: BUILTIN_THEMES,
    initialThemeId: simplemdLight.id,
    previewDoc: '# Título\n\nTexto **forte**.\n',
    canSave: true,
    onSave: vi.fn(async () => true),
    ...overrides,
  };
  render(<ThemeEditorDialog {...props} />);
  const preview = screen.getByTestId('theme-preview');
  return { props, preview };
}

function savedDraft(props: ThemeEditorDialogProps): ThemeDraft {
  const draft = vi.mocked(props.onSave).mock.calls[0]?.[0];
  if (!draft) throw new Error('onSave não foi chamado');
  return draft;
}

const hex = (label: string) => screen.getByLabelText<HTMLInputElement>(`${label} (hex)`);

describe('<ThemeEditorDialog> (L3, R-5.1, AC-5.1)', () => {
  test('11 controles de token rotulados + Nome + Base; preenchido pelo tema de partida', () => {
    setup();
    const dialog = screen.getByRole('dialog', { name: 'Editor de temas' });
    const rows = within(dialog).getAllByTestId('token-row');
    expect(rows.map((r) => r.dataset.token)).toEqual([...REQUIRED_TOKENS]);
    expect(document.activeElement).toBe(screen.getByLabelText('Começar de'));
    expect(screen.getByLabelText<HTMLInputElement>('Nome').value).toBe('simpleMD Claro (cópia)');
    expect(screen.getByRole('radio', { name: 'Claro' })).toHaveProperty('checked', true);
    const tokens = resolveTokens(simplemdLight);
    expect(hex('Fundo').value).toBe(tokens['--color-bg']);
    expect(screen.getByLabelText<HTMLInputElement>('Fundo (seletor)').value).toBe(
      pickerValue(tokens['--color-bg'] ?? ''),
    );
    expect(screen.getByLabelText<HTMLSelectElement>('Fonte do editor').value).toBe(
      tokens['--fontFamily-mono'],
    );
    expect(
      screen.getByLabelText<HTMLSelectElement>('Fonte da interface').selectedOptions[0]
        ?.textContent,
    ).toBe('Interface do sistema');
    expect(`${screen.getByLabelText<HTMLInputElement>('Tamanho da fonte (px)').value}px`).toBe(
      tokens['--dimension-font-size'],
    );
    for (const label of [
      'Texto',
      'Texto secundário',
      'Destaque',
      'Bordas',
      'Seleção',
      'Fundo da barra lateral',
      'Fundo de código',
    ])
      expect(screen.getByLabelText(`${label} (seletor)`)).toBeDefined();
  });

  test('"Começar de" escuro preenche de novo com os valores do escuro', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Começar de'), { target: { value: simplemdDark.id } });
    expect(hex('Fundo').value).toBe(simplemdDark.tokens['--color-bg']);
    expect(screen.getByLabelText<HTMLInputElement>('Nome').value).toBe('simpleMD Escuro (cópia)');
    expect(screen.getByRole('radio', { name: 'Escuro' })).toHaveProperty('checked', true);
  });
});

describe('prévia restrita ao contêiner (R-5.2, AC-5.2)', () => {
  test('hex válido muda só o contêiner; a raiz não muda', () => {
    const { preview } = setup();
    const rootBefore = document.documentElement.style.getPropertyValue('--color-bg');
    fireEvent.change(hex('Fundo'), { target: { value: NEW_BG } });
    expect(preview.style.getPropertyValue('--color-bg')).toBe(NEW_BG);
    expect(document.documentElement.style.getPropertyValue('--color-bg')).toBe(rootBefore);
    expect(preview.getAttribute('role')).toBe('region');
    expect(preview.getAttribute('aria-label')).toBe('Pré-visualização do tema');
    expect(within(preview).getByRole('textbox', { name: 'Exemplo de documento' })).toBeDefined();
  });

  test('base escura: tokens fora do formulário vêm do escuro', () => {
    const { preview } = setup();
    fireEvent.click(screen.getByRole('radio', { name: 'Escuro' }));
    expect(preview.style.getPropertyValue('--color-hover')).toBe(darkOverrides['--color-hover']);
    expect(preview.dataset.themeBase).toBe('dark');
  });

  test('o seletor grava #rrggbb e mantém o alfa do valor atual', () => {
    const { preview } = setup();
    fireEvent.change(hex('Fundo'), { target: { value: NEW_BG_ALPHA } });
    fireEvent.input(screen.getByLabelText('Fundo (seletor)'), { target: { value: '#abcdef' } });
    expect(hex('Fundo').value).toBe('#abcdef80');
    expect(preview.style.getPropertyValue('--color-bg')).toBe('#abcdef80');
    expect(withAlpha('#abcdef', '#1234')).toBe('#abcdef44');
    expect(pickerValue('#abc')).toBe('#aabbcc');
  });
});

describe('validação (TED-INVALID, STR-36)', () => {
  test('hex inválido: erro ao sair do campo, aria-invalid, prévia mantém o último válido', () => {
    const { preview } = setup();
    fireEvent.change(hex('Fundo'), { target: { value: NEW_BG } });
    fireEvent.change(hex('Fundo'), { target: { value: '#ggg' } });
    expect(hex('Fundo').getAttribute('aria-invalid')).toBeNull();
    fireEvent.blur(hex('Fundo'));
    expect(hex('Fundo').getAttribute('aria-invalid')).toBe('true');
    const describedBy = hex('Fundo').getAttribute('aria-describedby') ?? '';
    expect(describedBy.split(' ').map((id) => document.getElementById(id)?.textContent)).toContain(
      'Use uma cor hexadecimal: #rgb, #rgba, #rrggbb ou #rrggbbaa.',
    );
    expect(preview.style.getPropertyValue('--color-bg')).toBe(NEW_BG);
    // Depois do primeiro erro, valida a cada tecla.
    fireEvent.change(hex('Fundo'), { target: { value: NEW_BG } });
    expect(hex('Fundo').getAttribute('aria-invalid')).toBeNull();
  });

  test('salvar com erro: resumo, foco no primeiro campo inválido, 0 chamadas a onSave', async () => {
    const { props } = setup();
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: '!!!' } });
    fireEvent.change(hex('Destaque'), { target: { value: 'red' } });
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Salvar como novo tema' })),
    );
    expect(screen.getByTestId('te-error-summary').textContent).toBe(
      'Corrija os campos destacados antes de salvar.',
    );
    expect(document.activeElement).toBe(screen.getByLabelText('Nome'));
    expect(screen.getByLabelText('Nome').getAttribute('aria-invalid')).toBe('true');
    expect(hex('Destaque').getAttribute('aria-invalid')).toBe('true');
    expect(props.onSave).not.toHaveBeenCalled();
  });

  test('tamanho: 9 → 10 e 33 → 32 ao confirmar; salvo como <n>px', async () => {
    const { props } = setup();
    const size = screen.getByLabelText<HTMLInputElement>('Tamanho da fonte (px)');
    fireEvent.change(size, { target: { value: '9' } });
    fireEvent.blur(size);
    expect(size.value).toBe('10');
    fireEvent.change(size, { target: { value: '33' } });
    fireEvent.keyDown(size, { key: 'Enter' });
    expect(size.value).toBe('32');
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Salvar como novo tema' })),
    );
    const draft = savedDraft(props);
    expect(draft.tokens['--dimension-font-size']).toBe(`${32}px`);
  });
});

describe('salvar (R-5.4, AC-5.11)', () => {
  test('rascunho com nome aparado, base e os 11 tokens; sem css', async () => {
    const { props } = setup({ initialThemeId: simplemdDark.id });
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: '  Meu Tema  ' } });
    fireEvent.change(hex('Fundo'), { target: { value: NEW_BG } });
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Salvar como novo tema' })),
    );
    expect(props.onSave).toHaveBeenCalledOnce();
    const draft = savedDraft(props);
    expect(draft.name).toBe('Meu Tema');
    expect(draft.base).toBe('dark');
    expect(Object.keys(draft.tokens).sort()).toEqual([...REQUIRED_TOKENS].sort());
    expect(draft.tokens['--color-bg']).toBe(NEW_BG);
    expect(draft).not.toHaveProperty('css');
  });

  test('falha ao salvar: alerta STR-38 e o diálogo continua', async () => {
    setup({ onSave: vi.fn(async () => false) });
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Salvar como novo tema' })),
    );
    expect(screen.getByTestId('te-save-error').textContent).toBe(
      'Não foi possível salvar o tema. Nenhum tema foi ativado.',
    );
    expect(screen.getByRole('dialog', { name: 'Editor de temas' })).toBeDefined();
  });

  test('sem pasta: "Salvar como novo tema" aria-disabled com STR-39; Esc fecha', async () => {
    const { props } = setup({ canSave: false });
    const save = screen.getByRole('button', { name: 'Salvar como novo tema' });
    expect(save.getAttribute('aria-disabled')).toBe('true');
    const reasons = (save.getAttribute('aria-describedby') ?? '').split(' ');
    expect(reasons.map((id) => document.getElementById(id)?.textContent)).toContain(
      'Abra uma pasta para salvar ou importar temas.',
    );
    await act(async () => fireEvent.click(save));
    expect(props.onSave).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});

describe('correções da QA (fase 4)', () => {
  /** A faixa fixa entre o corpo rolável e o rodapé (DESIGN §8.7; UIF F-01). */
  const statusStrip = () => {
    const strip = screen
      .getByRole('dialog', { name: 'Editor de temas' })
      .querySelector('.smd-dialog-status');
    if (!strip) throw new Error('faixa de status ausente');
    return strip;
  };

  test('UIF F-01: falha ao salvar fica na faixa acima do rodapé (fora do corpo rolável) e recebe o foco', async () => {
    setup({ onSave: vi.fn(async () => false) });
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Salvar como novo tema' })),
    );
    const alert = screen.getByTestId('te-save-error');
    expect(alert.textContent).toBe('Não foi possível salvar o tema. Nenhum tema foi ativado.');
    expect(statusStrip().contains(alert)).toBe(true);
    expect(alert.closest('.smd-dialog-body')).toBeNull();
    expect(statusStrip().nextElementSibling?.classList.contains('smd-dialog-foot')).toBe(true);
    expect(document.activeElement).toBe(alert);
  });

  test('UIF F-01: resumo de erros e motivo "sem pasta" também ficam na faixa', async () => {
    setup({ canSave: false });
    expect(
      statusStrip().contains(screen.getByText('Abra uma pasta para salvar ou importar temas.')),
    ).toBe(true);
    cleanup();
    setup();
    fireEvent.change(hex('Fundo'), { target: { value: 'nada' } });
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Salvar como novo tema' })),
    );
    const summary = screen.getByTestId('te-error-summary');
    expect(summary.textContent).toBe('Corrija os campos destacados antes de salvar.');
    expect(statusStrip().contains(summary)).toBe(true);
    expect(document.activeElement).toBe(hex('Fundo'));
  });

  test('a11y F-3 / EC F-2: L3 é modal (aria-modal)', () => {
    setup();
    expect(screen.getByRole('dialog', { name: 'Editor de temas' }).getAttribute('aria-modal')).toBe(
      'true',
    );
  });

  test('EC F-8 / a11y F-5: a prévia é uma única parada de Tab (o editor dela tem tabindex -1)', () => {
    const { preview } = setup();
    expect(preview.getAttribute('tabindex')).toBe('0');
    const content = within(preview).getByRole('textbox', { name: 'Exemplo de documento' });
    expect(content.getAttribute('tabindex')).toBe('-1');
  });
});
