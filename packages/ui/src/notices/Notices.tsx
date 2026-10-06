import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/ui/button';
import { Icon } from '../lib/icons';

export interface NoticeView {
  readonly id: string;
  readonly kind: 'info' | 'error';
  /** Id semântico (`external-reload`, `save-failed`, …) exposto em `data-notice`. */
  readonly notice: string;
  readonly text: string;
  readonly detail?: string;
  readonly action?: { readonly label: string; run(): void };
}

export interface NoticesProps {
  items: readonly NoticeView[];
  onDismiss(id: string): void;
}

/** UX-D18: avisos informativos ficam ≥ 8 s, com o tempo pausado sob o mouse ou o foco. */
const INFO_MS = 8000;

/**
 * N1 AVISOS (DESIGN §8.6): dois contêineres vivos sempre presentes, `role=alert` (erros) acima de
 * `role=status` (informação). Avisos nunca movem o foco; erros ficam até serem fechados.
 */
export function Notices({ items, onDismiss }: NoticesProps) {
  return (
    <div className="smd-notices" data-testid="notices">
      <div role="alert">
        {items
          .filter((item) => item.kind === 'error')
          .map((item) => (
            <Notice key={item.id} item={item} onDismiss={onDismiss} />
          ))}
      </div>
      <div role="status">
        {items
          .filter((item) => item.kind === 'info')
          .map((item) => (
            <Notice key={item.id} item={item} onDismiss={onDismiss} />
          ))}
      </div>
    </div>
  );
}

function Notice({ item, onDismiss }: { item: NoticeView; onDismiss(id: string): void }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(INFO_MS);

  useEffect(() => {
    if (item.kind !== 'info' || paused) return;
    const started = Date.now();
    const timer = setTimeout(() => onDismiss(item.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [item.id, item.kind, paused, onDismiss]);

  return (
    <div
      className="smd-notice"
      data-testid="notice"
      data-kind={item.kind}
      data-notice={item.notice}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);
      }}
    >
      <Icon
        name={item.kind === 'error' ? 'warn' : 'info'}
        className={item.kind === 'error' ? 'smd-danger' : 'smd-muted'}
      />
      <div>
        <p className="smd-notice-title">{item.text}</p>
        {item.detail && <p className="smd-notice-detail">{item.detail}</p>}
        {item.action && (
          <div className="smd-notice-actions">
            <Button variant="ghost" onClick={item.action.run}>
              {item.action.label}
            </Button>
          </div>
        )}
      </div>
      <Button variant="icon" aria-label="Fechar aviso" onClick={() => onDismiss(item.id)}>
        <Icon name="close" />
      </Button>
    </div>
  );
}
