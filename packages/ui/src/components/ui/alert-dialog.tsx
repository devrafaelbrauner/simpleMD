import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import type { ReactNode, RefObject } from 'react';

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
  'data-testid': testId,
}: AlertDialogProps) {
  return (
    <AlertDialogPrimitive.Root open={open}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="smd-overlay" />
        <AlertDialogPrimitive.Content
          className="smd-dialog"
          data-testid={testId}
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
          <div className="smd-dialog-body">
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
