import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useRef, type ReactNode, type RefObject } from 'react';
import { useOutsidePointerRule } from './outside-pointer';

/**
 * Diálogo modal (shadcn "dialog" sobre Radix, reestilizado com D-1; DESIGN §7, §8.7) para L2 e L3.
 * Prende o foco, deixa o resto inerte e fecha com Esc. O foco inicial vai para `initialFocus`; ao
 * fechar, volta ao elemento que tinha o foco quando o diálogo abriu (arch-ux §5.3 regra 3), salvo
 * se a ação que o fechou já levou o foco para fora dele (L8: o editor da nota nova; A11Y-R2-02).
 * `nested` (L3 sobre L2) não desenha um segundo fundo escurecido (DESIGN §7: um por pilha).
 * `status` fica numa faixa que não rola, logo acima do rodapé (DESIGN §8.7: alertas e motivos de
 * L3 sempre visíveis, sem rolar o corpo; UIF F-01).
 */
export interface DialogProps {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  children: ReactNode;
  footer: ReactNode;
  status?: ReactNode;
  initialFocus?: RefObject<HTMLElement | null>;
  nested?: boolean;
  /**
   * Clique fora não fecha (L3: o rascunho só é descartado por Esc ou "Fechar"). Nos dois casos o
   * clique não chega ao que está embaixo e o foco fica onde estava (UX-R2-D27).
   */
  keepOnOutsideClick?: boolean;
  className?: string;
  'data-testid'?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  status,
  initialFocus,
  nested = false,
  keepOnOutsideClick = false,
  className,
  'data-testid': testId,
}: DialogProps) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  // Clique fora (UX-R2-D27): dispensável fecha como no Esc (foco volta ao invocador por
  // `onCloseAutoFocus`); L3 não fecha. Nos dois casos o clique não atravessa (EC F-11/N-1).
  useOutsidePointerRule(open, content, keepOnOutsideClick ? undefined : onClose);
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        {!nested && <DialogPrimitive.Overlay className="smd-overlay" />}
        <DialogPrimitive.Content
          ref={content}
          className={className ? `smd-dialog ${className}` : 'smd-dialog'}
          data-testid={testId}
          aria-modal="true"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            const active = document.activeElement;
            returnFocus.current = active instanceof HTMLElement ? active : null;
            if (!initialFocus) return;
            event.preventDefault();
            initialFocus.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // O Radix devolve o foco depois de desmontar: não tira o foco de onde a ação o levou.
            const now = document.activeElement;
            const moved =
              now instanceof HTMLElement &&
              now !== document.body &&
              !content.current?.contains(now);
            if (!moved && returnFocus.current?.isConnected) returnFocus.current.focus();
          }}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <div className="smd-dialog-head">
            <DialogPrimitive.Title className="smd-dialog-title">{title}</DialogPrimitive.Title>
          </div>
          <div className="smd-dialog-body">{children}</div>
          {status !== undefined && <div className="smd-dialog-status">{status}</div>}
          <div className="smd-dialog-foot">{footer}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
