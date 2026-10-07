import { useEffect, useRef } from 'react';
import { Button } from '../components/ui/button';
import { Icon } from '../lib/icons';

export interface ResultCardView {
  readonly id: number;
  /** "<comando> · <provedor> (<modelo>)". */
  readonly title: string;
  readonly text: string;
  readonly status: 'streaming' | 'done' | 'error';
  readonly error: string | null;
  readonly truncated: boolean;
}

export interface ResultCardProps {
  card: ResultCardView | null;
  /** Motivo de cada ação desabilitada (STR-133); `'error'` = descrita pelo alerta; `null` = livre. */
  blocks: { replace: string | null; insert: string | null; copy: string | null };
  announcement: string;
  onReplace(): void;
  onInsertBelow(): void;
  onCopy(): void;
  onDiscard(): void;
}

/**
 * C5 CARTÃO DE RESULTADO (R-11.8; DESIGN §8.22; UX-R2-D16/D17): região "Resultado da IA" no pé do
 * `<main>`, foco no contêiner quando um resultado novo abre; ações sempre presentes (desabilitadas
 * com motivo); Esc = Descartar. O documento só muda pelos botões (regra 1).
 */
export function ResultCard({ card, blocks, announcement, ...actions }: ResultCardProps) {
  const region = useRef<HTMLElement>(null);
  const id = card?.id;
  useEffect(() => {
    // No quadro seguinte: a paleta devolve o foco ao editor antes de rodar o comando (DA-16).
    if (id === undefined) return;
    const frame = requestAnimationFrame(() => region.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [id]);
  if (!card) return null;
  const reasons: string[] = [];
  const describe = (reason: string | null) => {
    if (reason === null) return undefined;
    if (reason === 'error') return 'ai-card-error';
    let index = reasons.indexOf(reason);
    if (index === -1) index = reasons.push(reason) - 1;
    return `ai-card-why-${index}`;
  };
  const action = (
    key: keyof ResultCardProps['blocks'],
    testId: string,
    label: string,
    run: () => void,
  ) => {
    const reason = blocks[key];
    return (
      <Button
        data-testid={testId}
        aria-disabled={reason !== null || undefined}
        aria-describedby={describe(reason)}
        onClick={run}
      >
        {label}
      </Button>
    );
  };
  const streaming = card.status === 'streaming';
  return (
    <section
      ref={region}
      className="smd-ai-card"
      role="region"
      aria-label="Resultado da IA"
      aria-describedby="ai-card-title"
      aria-busy={streaming || undefined}
      tabIndex={-1}
      data-testid="ai-result-card"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          actions.onDiscard();
        }
      }}
    >
      <div className="smd-ai-card-head">
        <span id="ai-card-title" className="smd-ai-card-title">
          {card.title}
        </span>
        <span className="smd-ai-card-status" data-testid="ai-card-status">
          {streaming ? 'Gerando…' : card.status === 'done' ? 'Pronto.' : ''}
        </span>
        <div className="smd-ai-card-acts">
          {action('replace', 'ai-result-card-replace', 'Substituir seleção', actions.onReplace)}
          {action('insert', 'ai-result-card-insert-below', 'Inserir abaixo', actions.onInsertBelow)}
          {action('copy', 'ai-result-card-copy', 'Copiar', actions.onCopy)}
          <Button data-testid="ai-result-card-discard" onClick={actions.onDiscard}>
            Descartar
          </Button>
        </div>
        {reasons.map((reason, index) => (
          <p key={reason} id={`ai-card-why-${index}`} className="smd-ai-card-reason">
            {reason}
          </p>
        ))}
      </div>
      {card.error !== null && (
        <div className="smd-ialert smd-ai-card-alert" role="alert" id="ai-card-error">
          <Icon name="warn" />
          <p>{card.error}</p>
        </div>
      )}
      <div className="smd-ai-card-body" tabIndex={0}>
        {card.text}
        {card.truncated && '\n\nResposta cortada em 200.000 caracteres.'}
      </div>
      <p className="sr-only" role="status">
        {announcement}
      </p>
    </section>
  );
}
