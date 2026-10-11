import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
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
  /**
   * Chamado quando o conteúdo sai do DOM, já sem a armadilha de foco do alerta, no mesmo tique
   * (antes de pintar): é onde quem abriu devolve o foco sem um quadro no `<body>` (r7 B1).
   */
  onClosed?: () => void;
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
  onClosed,
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
  // Esc é do alerta desde o commit que o abre (r7 B1). O Radix só passa o ouvinte de Esc para a
  // camada mais alta dois efeitos passivos depois de montar; até lá o do L2 de baixo continua
  // registrado, e um Esc logo após o aviso aparecer fechava os dois. A captura na `window` roda
  // antes da do `document` (Radix): `preventDefault` impede o L2 de fechar.
  useLayoutEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onEscape?.();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, onEscape]);
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
          onEscapeKeyDown={(event) => event.preventDefault()}
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
          {onClosed && <ClosedSignal onClosed={onClosed} />}
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}

/**
 * Na remoção do conteúdo, o React desfaz os efeitos passivos de cima para baixo: o `FocusScope` do
 * Radix (que envolve este nó) solta a armadilha de foco antes desta limpeza. O `FocusScope` do
 * diálogo de baixo só volta a valer num `setTimeout` depois; até lá ele não puxa o foco.
 */
function ClosedSignal({ onClosed }: { onClosed: () => void }) {
  const latest = useRef(onClosed);
  useLayoutEffect(() => {
    latest.current = onClosed;
  }, [onClosed]);
  useEffect(() => () => latest.current(), []);
  return null;
}
