import { useEffect, useRef, type RefObject } from 'react';

/**
 * Regra de clique fora dos diálogos (UX-R2-D27, arch-ux r2 §2.2; EC F-11/N-1). Enquanto o diálogo
 * está aberto e é o do topo, um gesto de ponteiro que começa fora dele nunca chega ao que está
 * embaixo: o `mousedown` (cujo padrão move o foco e, no CodeMirror, o cursor) e o `click` desse
 * gesto são cancelados e param na captura do `document`. Assim:
 * - `onOutside` presente (L2, diálogos dispensáveis): o diálogo fecha e o foco volta ao invocador;
 * - `onOutside` ausente (L1, L3, L4): nada muda e o foco fica dentro do diálogo.
 * O tratamento do Radix (que só dispensa no `click`, depois de o foco já ter saído) não é usado.
 */
export function useOutsidePointerRule(
  open: boolean,
  contentRef: RefObject<HTMLElement | null>,
  onOutside?: () => void,
): void {
  const onOutsideRef = useRef(onOutside);
  useEffect(() => {
    onOutsideRef.current = onOutside;
  }, [onOutside]);
  useEffect(() => {
    if (!open) return;
    const swallow = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    let pending: number | undefined;
    const release = () => {
      document.removeEventListener('mousedown', swallow, true);
      document.removeEventListener('click', swallow, true);
      document.removeEventListener('pointerup', endGesture, true);
      clearTimeout(pending);
      pending = undefined;
    };
    // O `click` sai logo depois do `pointerup` do mesmo gesto; no tique seguinte nada é engolido.
    const endGesture = () => setTimeout(release, 0);
    const onPointerDown = (event: PointerEvent) => {
      release(); // um gesto novo nunca herda o anterior
      const content = contentRef.current;
      const target = event.target;
      if (!content || !(target instanceof Node) || content.contains(target)) return;
      // Só o diálogo do topo (o último aberto no DOM) aplica a regra.
      const dialogs = document.querySelectorAll('.smd-dialog');
      if (dialogs[dialogs.length - 1] !== content) return;
      document.addEventListener('mousedown', swallow, true);
      document.addEventListener('click', swallow, true);
      document.addEventListener('pointerup', endGesture, true);
      pending = window.setTimeout(release, 1000);
      onOutsideRef.current?.();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      // Se o diálogo fechou neste gesto, o resto dele ainda é engolido (até o `pointerup`).
      if (pending === undefined) release();
    };
  }, [open, contentRef]);
}
