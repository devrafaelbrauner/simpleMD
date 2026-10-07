import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AiSettings, ChatPanel, ResultCard, type AiSettingsProps } from '../src';

afterEach(cleanup);

const CANARY = 'sk-test-CANARY-ui0001';

function settingsProps(over: Partial<AiSettingsProps> = {}): AiSettingsProps {
  return {
    provider: null,
    model: '',
    models: { state: 'idle', list: [], message: '' },
    keys: { openai: 'none', anthropic: 'saved' },
    keyErrors: {},
    ollamaUrl: 'http://127.0.0.1:11434',
    language: 'en',
    onProviderChange: vi.fn(),
    onModelChange: vi.fn(),
    onRefreshModels: vi.fn(),
    onSaveKey: vi.fn(),
    onRemoveKey: vi.fn(),
    onOllamaUrlChange: vi.fn(() => true),
    onLanguageChange: vi.fn(),
    ...over,
  };
}

describe('Configurações → IA (AC-11.10)', () => {
  test('3 provedores; campo password esvaziado ao salvar; status sem caractere da chave', () => {
    const props = settingsProps();
    const { container } = render(<AiSettings {...props} />);
    const provider = screen.getByLabelText('Provedor');
    expect([...provider.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'Escolha um provedor',
      'OpenAI',
      'Anthropic',
      'Ollama (local)',
    ]);
    const field = screen.getByLabelText('Chave da OpenAI') as HTMLInputElement;
    expect(field.type).toBe('password');
    fireEvent.change(field, { target: { value: CANARY } });
    fireEvent.click(
      container.querySelector('[data-testid="set-ai-key-save"][data-provider="openai"]')!,
    );
    expect(field.value).toBe('');
    expect(props.onSaveKey).toHaveBeenCalledWith('openai', CANARY);
    expect(container.innerHTML).not.toContain('CANARY');
    const statuses = [...container.querySelectorAll('[data-testid="set-ai-key-status"]')];
    expect(statuses.map((s) => s.textContent)).toEqual(['Sem chave', 'Chave salva']);
    // "Atualizar lista" sem provedor: aria-disabled com P-STR-3; nenhum listModels.
    const refresh = screen.getByRole('button', { name: 'Atualizar lista' });
    expect(refresh.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(refresh);
    expect(props.onRefreshModels).not.toHaveBeenCalled();
    expect(screen.getByText('Escolha um provedor primeiro.')).toBeTruthy();
    // Idiomas com `lang`.
    const english = screen.getByRole('option', { name: 'English' });
    expect(english.getAttribute('lang')).toBe('en');
  });

  test('endereço fora do loopback → aria-invalid + STR-127', () => {
    render(<AiSettings {...settingsProps({ onOllamaUrlChange: () => false })} />);
    const url = screen.getByLabelText('Endereço do Ollama');
    fireEvent.change(url, { target: { value: 'http://192.168.0.2:11434' } });
    fireEvent.keyDown(url, { key: 'Enter' });
    expect(url.getAttribute('aria-invalid')).toBe('true');
    expect(
      screen.getByText('Use um endereço local com http: 127.0.0.1, localhost ou [::1], com porta.'),
    ).toBeTruthy();
  });
});

describe('Chat IA e cartão', () => {
  test('Enter envia, Shift+Enter não; log sem role=log; resposta em andamento aria-busy', () => {
    const onSend = vi.fn();
    render(
      <ChatPanel
        banner={null}
        emptyText="Pergunte algo."
        messages={[
          {
            id: 1,
            role: 'user',
            text: 'oi',
            heading: 'Você',
            status: 'done',
            waiting: false,
            slow: false,
            truncated: false,
            error: null,
          },
          {
            id: 2,
            role: 'assistant',
            text: 'ol',
            heading: 'IA (Ollama · m)',
            status: 'streaming',
            waiting: false,
            slow: false,
            truncated: false,
            error: null,
          },
        ]}
        streaming={false}
        status=""
        announcement=""
        canInsert
        onOpenSettings={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
        onClear={vi.fn()}
        onInsert={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
    const log = screen.getByRole('region', { name: 'Conversa' });
    expect(log.getAttribute('role')).toBeNull();
    expect(log.querySelector('[data-role="assistant"]')!.getAttribute('aria-busy')).toBe('true');
    const input = screen.getByLabelText('Mensagem para a IA');
    fireEvent.change(input, { target: { value: 'linha' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('linha');
  });

  test('cartão: ações desabilitadas com motivo enquanto gera; Esc descarta', () => {
    const onDiscard = vi.fn();
    render(
      <ResultCard
        card={{
          id: 1,
          title: 'IA: Resumir seleção · Ollama (m)',
          text: 'abc',
          status: 'streaming',
          error: null,
          truncated: false,
        }}
        blocks={{
          replace: 'Aguarde a resposta terminar.',
          insert: 'Aguarde a resposta terminar.',
          copy: 'Aguarde a resposta terminar.',
        }}
        announcement=""
        onReplace={vi.fn()}
        onInsertBelow={vi.fn()}
        onCopy={vi.fn()}
        onDiscard={onDiscard}
      />,
    );
    const card = screen.getByRole('region', { name: 'Resultado da IA' });
    expect(card.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('Gerando…')).toBeTruthy();
    const replace = screen.getByRole('button', { name: 'Substituir seleção' });
    expect(replace.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getAllByText('Aguarde a resposta terminar.')).toHaveLength(1);
    fireEvent.keyDown(card, { key: 'Escape' });
    expect(onDiscard).toHaveBeenCalled();
  });
});
