import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { useOutsidePointerRule } from './outside-pointer';

/**
 * Diálogo de alerta (shadcn "alert-dialog" sobre Radix, reestilizado com D-1; DESIGN §8.7). Modal:
 * prende o foco e deixa o resto da página inerte. O foco inicial vai para `initialFocus`; a
 * restauração do foco ao fechar fica com quem abriu (arch-ux §5.3).
 */
export interface AlertDialogProps {
  open: boolean;
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
  footer: ReactNode;
  initialFocus: RefObject<HTMLElement | null>;
  /** Esc: `undefined` = não faz nada (L1); senão, a ação de Esc (L4 = Voltar). */
  onEscape?: () => void;
  className?: string;
  /** O corpo só vira parada de Tab enquanto rola (L6, DESIGN §8.15). */
  focusableOverflow?: boolean;
  'data-testid'?: string;
}

export function AlertDialog({
  open,
  title,
  description,
  children,
  footer,
  initialFocus,
  onEscape,
  className,
  focusableOverflow = false,
  'data-testid': testId,
}: AlertDialogProps) {
  const content = useRef<HTMLDivElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  // L1/L4/L6 não fecham por clique fora; o clique não atravessa e o foco fica no diálogo (N-1,
  // UX-R2-D27).
  useOutsidePointerRule(open, content);
  useLayoutEffect(() => {
    const element = body.current;
    if (!open || !focusableOverflow || !element) return;
    const update = () => {
      if (element.scrollHeight > element.clientHeight) element.tabIndex = 0;
      else element.removeAttribute('tabindex');
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [open, focusableOverflow]);
  return (
    <AlertDialogPrimitive.Root open={open}>
      <AlertDialogPrimitive.Portal>
        {/* Camada própria acima de L2/L3 (DESIGN §7: L1/L4 escurecem o diálogo de baixo; UIF F-04). */}
        <AlertDialogPrimitive.Overlay className="smd-overlay smd-overlay-alert" />
        <AlertDialogPrimitive.Content
          ref={content}
          className={`smd-dialog smd-dialog-alert${className ? ` ${className}` : ''}`}
          data-testid={testId}
          aria-modal="true"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            initialFocus.current?.focus();
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            onEscape?.();
          }}
        >
          <div className="smd-dialog-head">
            <AlertDialogPrimitive.Title className="smd-dialog-title">
              {title}
            </AlertDialogPrimitive.Title>
          </div>
          <div ref={body} className="smd-dialog-body">
            <AlertDialogPrimitive.Description asChild>
              <div>{description}</div>
            </AlertDialogPrimitive.Description>
            {children}
          </div>
          <div className="smd-dialog-foot">{footer}</div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
