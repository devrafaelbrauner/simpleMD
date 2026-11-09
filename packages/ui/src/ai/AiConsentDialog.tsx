import { PROVIDER_NAMES } from '@simplemd/ai';
import { useRef } from 'react';
import { AlertDialog } from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import type { AiKeyedProvider } from './AiSettings';

/** Pedido de consentimento (r30): o 1º envio de texto de uma pasta a um provedor de nuvem. */
export interface AiConsentView {
  readonly id: number;
  readonly provider: AiKeyedProvider;
  readonly kind: 'chat' | 'command';
  /** "Chat IA" ou o rótulo do comando ("IA: Resumir seleção"). */
  readonly action: string;
  /** O que sai: a mensagem digitada ou a seleção, inteira (D-R30-03). */
  readonly text: string;
  /** Mensagens anteriores da conversa que vão junto (só no chat). */
  readonly previous: number;
}

export interface AiConsentDialogProps {
  /** `null` = fechado. */
  request: AiConsentView | null;
  onConfirm(): void;
  onCancel(): void;
  /** O diálogo saiu do DOM: quem abriu devolve o foco (ver `AlertDialog.onClosed`). */
  onClosed?: () => void;
}

const fmt = (n: number) => n.toLocaleString('pt-BR');

/**
 * "Enviar para {Provedor}?" (r30, AC-R30-1/5): nada sai antes de "Enviar". Mostra o texto inteiro
 * que vai para a nuvem, com rolagem (o corpo vira parada de Tab só quando rola). Foco inicial e
 * Esc = "Cancelar" (D-R30-02). "Enviar" fica registrado no `config.json` da pasta.
 */
export function AiConsentDialog({ request, onConfirm, onCancel, onClosed }: AiConsentDialogProps) {
  const cancel = useRef<HTMLButtonElement>(null);
  const name = request ? PROVIDER_NAMES[request.provider] : '';
  return (
    <AlertDialog
      open={request !== null}
      data-testid="ai-consent-dialog"
      initialFocus={cancel}
      onEscape={onCancel}
      focusableOverflow
      {...(onClosed ? { onClosed } : {})}
      title={`Enviar para ${name}?`}
      description={
        <p>
          Esta pasta ainda não autorizou o envio de texto para {name}. O texto abaixo sai do seu
          computador.
        </p>
      }
      footer={
        <>
          <Button
            ref={cancel}
            variant="secondary"
            data-testid="ai-consent-cancel"
            onClick={onCancel}
          >
            Cancelar
          </Button>
          <Button variant="primary" data-testid="ai-consent-send" onClick={onConfirm}>
            Enviar
          </Button>
        </>
      }
    >
      {request && (
        <>
          <p className="smd-chat-heading" data-testid="ai-consent-label">
            {request.kind === 'chat' ? 'Sua mensagem' : `Seleção para “${request.action}”`} ·{' '}
            {fmt(request.text.length)} caracteres
          </p>
          <p className="smd-chat-user" data-testid="ai-consent-text">
            {request.text}
          </p>
          {request.previous > 0 && (
            <p className="smd-hint" data-testid="ai-consent-previous">
              {request.previous === 1
                ? 'Também vai a mensagem anterior desta conversa.'
                : `Também vão as ${fmt(request.previous)} mensagens anteriores desta conversa.`}
            </p>
          )}
          <p className="smd-hint">
            Ao enviar, a autorização fica registrada em .simplemd/config.json desta pasta e o app
            não pergunta de novo. Para revogar: Configurações → IA.
          </p>
        </>
      )}
    </AlertDialog>
  );
}
