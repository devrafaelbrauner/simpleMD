import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '../components/ui/button';
import { Icon } from '../lib/icons';
import { LIMIT_NOTICE_TEXT, type ResultCut } from './ResultCard';

export const CHAT_MAX_CHARS = 32_000;

interface ChatMessageFields {
  readonly id: number;
  readonly text: string;
  readonly heading: string;
  readonly status: 'waiting' | 'streaming' | 'done' | 'stopped' | 'error';
  readonly waiting: boolean;
  readonly slow: boolean;
  readonly truncated: ResultCut;
  readonly error: string | null;
}

/**
 * `historyDropped` (r30): mensagens antigas fora deste envio pelo teto do histórico (> 0 mostra o
 * aviso). Só a mensagem do usuário corta o histórico; numa resposta o tipo exige 0 (R30-CR-NITS).
 */
export type ChatMessageView =
  | (ChatMessageFields & { readonly role: 'user'; readonly historyDropped: number })
  | (ChatMessageFields & { readonly role: 'assistant'; readonly historyDropped: 0 });

/** r30: aviso na mensagem do usuário quando o teto do histórico deixou as mais antigas de fora. */
const HISTORY_DROPPED_TEXT = 'Mensagens antigas não foram enviadas.';

export interface ChatPanelProps {
  /** Estado de configuração (STR-131): banner + motivo de "Enviar" desabilitado. */
  banner: string | null;
  /** Texto do estado vazio com o provedor pronto (STR-131). */
  emptyText: string;
  messages: readonly ChatMessageView[];
  streaming: boolean;
  /** Linha visível `role=status` ("Resposta inserida em …", "Resultado copiado."). */
  status: string;
  /** Anunciador polido: muda uma vez por resposta terminada (AC-11.18). */
  announcement: string;
  /** Há uma aba aberta ("Inserir no cursor"). */
  canInsert: boolean;
  /** Painel montado (o app consulta o estado das chaves; só `has_key`, 0 pedidos de rede). */
  onMount?(): void;
  onOpenSettings(): void;
  onSend(text: string): void;
  onStop(): void;
  onClear(): void;
  onInsert(id: number): void;
  onCopy(id: number): void;
  /**
   * r30: "Cancelar" no diálogo de consentimento devolve a mensagem ao campo; um objeto novo (outro
   * `id`) repõe o rascunho uma vez.
   */
  restore?: { readonly id: number; readonly text: string } | null;
}

const fmt = (n: number) => n.toLocaleString('pt-BR');

/**
 * C4.4 CHAT IA (R-11.7; DESIGN §8.21; arch-frontend r2 §11.3): banner de configuração, log
 * `<section aria-label="Conversa">` (sem `role=log`, D-R2-3), mensagens em `<article>`, rodapé com
 * a área de texto, contador e botões. Enter envia; Shift+Enter quebra a linha; nunca durante a
 * composição (IME). Respostas são texto puro (`pre-wrap`), nunca HTML.
 */
export function ChatPanel(props: ChatPanelProps) {
  const { banner, messages, streaming } = props;
  const [draft, setDraft] = useState('');
  // Ajuste durante a renderização (não num efeito): o mesmo `restore` não repõe o rascunho de novo
  // quando o painel volta a ser montado.
  const restore = props.restore ?? null;
  const [restored, setRestored] = useState(restore);
  if (restore !== restored) {
    setRestored(restore);
    if (restore) setDraft(restore.text);
  }
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLElement>(null);
  const over = draft.length > CHAT_MAX_CHARS;
  const sendReason =
    banner ??
    (streaming
      ? 'Aguarde a resposta ou clique em Parar.'
      : over
        ? 'A mensagem passa de 32.000 caracteres.'
        : null);
  const { onMount } = props;
  useEffect(() => {
    onMount?.();
    // Só na montagem: o painel é desmontado quando outra aba lateral é mostrada.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages]);

  const send = () => {
    if (sendReason !== null || draft.trim() === '') return;
    props.onSend(draft);
    setDraft('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  return (
    <div className="smd-chat" data-testid="ai-chat">
      {banner !== null && (
        <div className="smd-chat-banner">
          <p>
            <Icon name="info" className="smd-muted" />
            <span>{banner}</span>
          </p>
          <Button onClick={props.onOpenSettings}>Abrir configurações de IA</Button>
        </div>
      )}
      <section
        ref={log}
        className="smd-chat-log"
        aria-label="Conversa"
        tabIndex={0}
        data-testid="ai-chat-log"
      >
        {messages.length === 0 && banner === null && (
          <p className="smd-chat-empty">{props.emptyText}</p>
        )}
        {messages.map((message) => (
          <article
            key={message.id}
            className="smd-chat-msg"
            data-testid="ai-msg"
            data-role={message.role}
            aria-labelledby={`ai-msg-h-${message.id}`}
            aria-busy={
              message.role === 'assistant' &&
              (message.status === 'waiting' || message.status === 'streaming')
                ? true
                : undefined
            }
          >
            <p id={`ai-msg-h-${message.id}`} className="smd-chat-heading">
              {message.heading}
            </p>
            <div className={message.role === 'user' ? 'smd-chat-user' : 'smd-chat-answer'}>
              {message.text}
            </div>
            {message.historyDropped > 0 && (
              <p className="smd-chat-note" data-testid="ai-history-dropped">
                {HISTORY_DROPPED_TEXT}
              </p>
            )}
            {message.waiting && <p className="smd-chat-note">Aguardando resposta…</p>}
            {message.slow && (
              <p className="smd-chat-note">Isto está demorando mais que o esperado.</p>
            )}
            {message.status === 'stopped' && (
              <p className="smd-chat-note">Resposta interrompida.</p>
            )}
            {message.truncated === 'chars' && (
              <p className="smd-chat-note">Resposta cortada em 200.000 caracteres.</p>
            )}
            {message.truncated === 'limit' && (
              <div
                id={`ai-msg-limit-${message.id}`}
                className="smd-ialert"
                data-testid="ai-msg-limit"
              >
                <Icon name="warn" />
                <p>{LIMIT_NOTICE_TEXT}</p>
              </div>
            )}
            {message.error !== null && (
              <div className="smd-ialert" role="alert">
                <Icon name="warn" />
                <p>{message.error}</p>
              </div>
            )}
            {message.role === 'assistant' && message.status === 'done' && message.text !== '' && (
              <div className="smd-chat-acts">
                <Button
                  variant="ghost"
                  data-testid="ai-insert"
                  aria-disabled={!props.canInsert || undefined}
                  // NB-4 (r29): a ação também aplica texto cortado; o aviso descreve o botão.
                  aria-describedby={
                    [
                      props.canInsert ? '' : `ai-insert-why-${message.id}`,
                      message.truncated === 'limit' ? `ai-msg-limit-${message.id}` : '',
                    ]
                      .filter(Boolean)
                      .join(' ') || undefined
                  }
                  onClick={() => props.onInsert(message.id)}
                >
                  Inserir no cursor
                </Button>
                <Button
                  variant="ghost"
                  data-testid="ai-copy"
                  onClick={() => props.onCopy(message.id)}
                >
                  Copiar
                </Button>
                {!props.canInsert && (
                  <span id={`ai-insert-why-${message.id}`} className="smd-hint">
                    Abra uma nota para inserir.
                  </span>
                )}
              </div>
            )}
          </article>
        ))}
      </section>
      <p className="sr-only" role="status" data-testid="ai-final-status">
        {props.announcement}
      </p>
      <div className="smd-chat-foot">
        <label htmlFor="ai-input" className="sr-only">
          Mensagem para a IA
        </label>
        <textarea
          ref={input}
          id="ai-input"
          className="smd-chat-input"
          rows={3}
          placeholder="Escreva e tecle Enter (Shift+Enter quebra a linha)"
          aria-describedby="ai-counter ai-why"
          aria-disabled={banner !== null || undefined}
          readOnly={banner !== null}
          data-testid="ai-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <p id="ai-counter" className="smd-chat-counter" data-over={over || undefined}>
          {over && <Icon name="warn" />}
          <span>
            {fmt(draft.length)} / {fmt(CHAT_MAX_CHARS)}
          </span>
        </p>
        <div className="smd-chat-btns">
          <Button
            data-testid="ai-send"
            aria-disabled={sendReason !== null || undefined}
            aria-describedby="ai-why"
            onClick={send}
          >
            Enviar
          </Button>
          <Button
            data-testid="ai-stop"
            aria-disabled={!streaming || undefined}
            onClick={() => {
              props.onStop();
              input.current?.focus();
            }}
          >
            Parar
          </Button>
          <Button
            variant="ghost"
            className="smd-chat-end"
            data-testid="ai-clear"
            aria-disabled={messages.length === 0 || undefined}
            onClick={() => {
              props.onClear();
              input.current?.focus();
            }}
          >
            Limpar conversa
          </Button>
        </div>
        <p id="ai-why" className="smd-chat-why">
          {sendReason ?? ''}
        </p>
        <p className="smd-chat-why" role="status" data-testid="ai-chat-status">
          {props.status}
        </p>
      </div>
    </div>
  );
}
