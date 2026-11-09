import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  AiSettings,
  ChatPanel,
  ResultCard,
  type AiSettingsProps,
  type ChatMessageView,
  type ResultCardView,
} from '../src';

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

describe('aviso de resposta cortada pelo limite do modelo (r29, AC-R29-1)', () => {
  const NOTICE = 'Resposta cortada pelo limite do modelo.';
  const FREE = { replace: null, insert: null, copy: null };

  function card(truncated: ResultCardView['truncated'], announcement = '') {
    return render(
      <ResultCard
        card={{
          id: 1,
          title: 'IA: Reescrever seleção · Anthropic (m)',
          text: 'Olá! Um, dois',
          status: 'done',
          error: null,
          truncated,
        }}
        blocks={FREE}
        announcement={announcement}
        onReplace={vi.fn()}
        onInsertBelow={vi.fn()}
        onCopy={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
  }

  function chat(truncated: ChatMessageView['truncated'], announcement = '') {
    return render(
      <ChatPanel
        banner={null}
        emptyText=""
        messages={[
          {
            id: 2,
            role: 'assistant',
            text: 'Olá! Um,',
            heading: 'IA (OpenAI · m)',
            status: 'done',
            waiting: false,
            slow: false,
            truncated,
            error: null,
          },
        ]}
        streaming={false}
        status=""
        announcement={announcement}
        canInsert
        onOpenSettings={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onClear={vi.fn()}
        onInsert={vi.fn()}
        onCopy={vi.fn()}
      />,
    );
  }

  test('cartão: aviso junto das ações, ligado a Substituir e Inserir abaixo, que ficam livres', () => {
    card('limit', `Resultado da IA: Olá! Um, dois ${NOTICE}`);
    const notice = screen.getByTestId('ai-card-limit');
    expect(notice.textContent).toBe(NOTICE);
    expect(notice.getAttribute('role')).toBeNull();
    for (const name of ['Substituir seleção', 'Inserir abaixo']) {
      const button = screen.getByRole('button', { name });
      expect(button.getAttribute('aria-disabled')).toBeNull();
      expect(button.getAttribute('aria-describedby')).toBe('ai-card-limit');
    }
    expect(
      screen.getByRole('button', { name: 'Copiar' }).getAttribute('aria-describedby'),
    ).toBeNull();
    // Anúncio pela região viva que já existe no cartão (aria-live implícito de role=status).
    expect(screen.getByRole('status').textContent).toBe(`Resultado da IA: Olá! Um, dois ${NOTICE}`);
  });

  test('cartão: o motivo de uma ação bloqueada e o aviso vão juntos no aria-describedby', () => {
    render(
      <ResultCard
        card={{ id: 1, title: 't', text: 'a', status: 'done', error: null, truncated: 'limit' }}
        blocks={{ replace: 'Volte para a aba “a.md” para aplicar.', insert: null, copy: null }}
        announcement=""
        onReplace={vi.fn()}
        onInsertBelow={vi.fn()}
        onCopy={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    const replace = screen.getByRole('button', { name: 'Substituir seleção' });
    expect(replace.getAttribute('aria-describedby')).toBe('ai-card-why-0 ai-card-limit');
  });

  test('cartão sem corte → nenhum aviso; corte de 200.000 → só o texto de sempre', () => {
    card(false);
    expect(screen.queryByTestId('ai-card-limit')).toBeNull();
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Substituir seleção' }).getAttribute('aria-describedby'),
    ).toBeNull();
    cleanup();
    card('chars');
    expect(screen.queryByTestId('ai-card-limit')).toBeNull();
    expect(document.querySelector('.smd-ai-card-body')!.textContent).toBe(
      'Olá! Um, dois\n\nResposta cortada em 200.000 caracteres.',
    );
  });

  test('chat: aviso visível na resposta e no anunciador; sem corte → nada', () => {
    chat('limit', `Resposta da IA: Olá! Um, ${NOTICE}`);
    const article = screen.getByTestId('ai-msg');
    expect(article.querySelector('[data-testid="ai-msg-limit"]')!.textContent).toBe(NOTICE);
    expect(screen.getByTestId('ai-final-status').textContent).toBe(
      `Resposta da IA: Olá! Um, ${NOTICE}`,
    );
    expect(screen.getByTestId('ai-final-status').getAttribute('role')).toBe('status');
    // As ações da resposta continuam (Inserir no cursor / Copiar).
    expect(screen.getByTestId('ai-insert')).toBeTruthy();
    cleanup();
    chat(false);
    expect(screen.queryByTestId('ai-msg-limit')).toBeNull();
    expect(screen.queryByText(NOTICE)).toBeNull();
    cleanup();
    chat('chars');
    expect(screen.queryByTestId('ai-msg-limit')).toBeNull();
    expect(screen.getByText('Resposta cortada em 200.000 caracteres.')).toBeTruthy();
  });
});
