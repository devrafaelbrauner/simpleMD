import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useRef, type ReactNode, type RefObject } from 'react';

/**
 * Diálogo modal (shadcn "dialog" sobre Radix, reestilizado com D-1; DESIGN §7, §8.7) para L2 e L3.
 * Prende o foco, deixa o resto inerte e fecha com Esc. O foco inicial vai para `initialFocus`; ao
 * fechar, volta ao elemento que tinha o foco quando o diálogo abriu (arch-ux §5.3 regra 3).
 * `nested` (L3 sobre L2) não desenha um segundo fundo escurecido (DESIGN §7: um por pilha).
 */
export interface DialogProps {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  children: ReactNode;
  footer: ReactNode;
  initialFocus?: RefObject<HTMLElement | null>;
  nested?: boolean;
  /** Clique fora não fecha (L3: o rascunho só é descartado por Esc ou "Fechar"). */
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
  initialFocus,
  nested = false,
  keepOnOutsideClick = false,
  className,
  'data-testid': testId,
}: DialogProps) {
  const returnFocus = useRef<HTMLElement | null>(null);
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
          className={className ? `smd-dialog ${className}` : 'smd-dialog'}
          data-testid={testId}
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
            if (returnFocus.current?.isConnected) returnFocus.current.focus();
          }}
          onPointerDownOutside={(event) => {
            if (keepOnOutsideClick) event.preventDefault();
          }}
        >
          <div className="smd-dialog-head">
            <DialogPrimitive.Title className="smd-dialog-title">{title}</DialogPrimitive.Title>
          </div>
          <div className="smd-dialog-body">{children}</div>
          <div className="smd-dialog-foot">{footer}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
