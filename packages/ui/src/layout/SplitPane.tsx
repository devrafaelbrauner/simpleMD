import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';

/** Largura mínima de cada lado, em px (design-r38 §1, D-R38-06). */
export const SPLIT_MIN_PANE_PX = 320;
/** Largura mínima da área para mostrar os dois lados; abaixo dela só o `start` aparece. */
export const SPLIT_MIN_WIDTH_PX = 900;
/** Faixa gravável da proporção (fração da largura útil que o `start` ocupa; D-R38-06). */
export const SPLIT_RATIO_MIN = 0.1;
export const SPLIT_RATIO_MAX = 0.9;
/**
 * Largura do divisor: o alvo de 24 px do ponteiro (WCAG 2.5.8). Cópia de `--dimension-space-6`,
 * que o `components.css` usa em `.smd-split-*`; mudar o token exige mudar este valor (o arraste
 * mede o divisor real, mas o teclado e os `aria-value*` usam este).
 */
const GUTTER_PX = 24;
/** Setas: 2 %; Shift+seta, PageUp e PageDown: 10 %. */
const STEP = 0.02;
const BIG_STEP = 0.1;
/** Abaixo disto (px), apertar e soltar o divisor é um clique, não um arraste. */
const DRAG_SLOP_PX = 3;

export interface SplitPaneProps {
  /** Lado inicial (o editor): sempre no mesmo nó do DOM, nunca remonta (regra 5). */
  start: ReactNode;
  /** Lado final (a prévia); `null` = só o início, sem divisor. */
  end: ReactNode | null;
  /** `id` do lado inicial (o `aria-controls` do divisor). */
  startId: string;
  /** Fração da largura útil (sem o divisor) que o lado inicial ocupa, 0,1–0,9. */
  ratio: number;
  /**
   * Escolha do usuário, uma por gesto: cada tecla, o fim de um arraste, o duplo clique (50 %).
   * Nunca durante o arraste nem quando nada muda.
   */
  onRatioChange(ratio: number): void;
  /**
   * Largura medida pelo `ResizeObserver` (px inteiros; escondido não conta) e se cabem os dois
   * lados (≥ {@link SPLIT_MIN_WIDTH_PX}). Sem `ResizeObserver`, nunca é chamado: cabe.
   */
  onFitChange?(fits: boolean, width: number): void;
  /** Nome do divisor (ex.: "Redimensionar editor e prévia"). */
  separatorLabel: string;
  /** Nomes dos lados no `aria-valuetext` ("Editor 55%, prévia 45%"). */
  startLabel: string;
  endLabel: string;
}

interface Range {
  readonly min: number;
  readonly max: number;
}

interface Drag {
  readonly pointerId: number;
  /** `clientX` de quando o divisor foi apertado. */
  readonly startX: number;
  /** Largura útil da área (sem o divisor) no início do arraste. */
  readonly avail: number;
  /** Proporção mostrada no início (o arraste a desloca, sem saltar para o ponteiro). */
  readonly from: number;
  moved: boolean;
}

/**
 * Proporções possíveis numa largura útil: 320 px por lado e a faixa gravável. Sem medida, só a
 * faixa; sem espaço para os dois mínimos, o meio.
 */
function rangeFor(avail: number | null): Range {
  if (avail === null || avail <= 0) return { min: SPLIT_RATIO_MIN, max: SPLIT_RATIO_MAX };
  const min = Math.max(SPLIT_RATIO_MIN, SPLIT_MIN_PANE_PX / avail);
  const max = Math.min(SPLIT_RATIO_MAX, (avail - SPLIT_MIN_PANE_PX) / avail);
  return min <= max ? { min, max } : { min: 0.5, max: 0.5 };
}

const clamp = (value: number, range: Range) => Math.min(range.max, Math.max(range.min, value));

/**
 * Proporção a gravar: no limite (ou além), o limite exato, então Home/End batem com
 * `aria-valuemin`/`aria-valuemax`; entre eles, 3 casas (o divisor anda em px; 0,1 % basta).
 */
function settle(value: number, range: Range): number {
  if (value <= range.min) return range.min;
  if (value >= range.max) return range.max;
  return clamp(Math.round(value * 1000) / 1000, range);
}

/**
 * Dois painéis lado a lado com divisor acessível (design-r38 §1; ui/layout). O `start` fica sempre
 * no primeiro filho (o `EditorView` dentro dele nunca é recriado); o `end` entra e sai sem mexer
 * nele. O divisor é um `separator` focável: ←/→ 2 % (Shift 10 %), PageUp/PageDown 10 %, Home/End
 * nos limites; o ponteiro arrasta com captura (Esc cancela) e o duplo clique volta a 50 %.
 */
export function SplitPane({
  start,
  end,
  startId,
  ratio,
  onRatioChange,
  onFitChange,
  separatorLabel,
  startLabel,
  endLabel,
}: SplitPaneProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef(onFitChange);
  const drag = useRef<Drag | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [dragRatio, setDragRatio] = useState<number | null>(null);

  useLayoutEffect(() => {
    fitRef.current = onFitChange;
  });

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    let last = 0;
    const observer = new ResizeObserver((entries) => {
      const measured = Math.round(entries[entries.length - 1]?.contentRect.width ?? 0);
      // Escondido (aba carregando, nenhuma aba): `display: none` mede 0 e não muda nada.
      if (measured <= 0 || measured === last) return;
      last = measured;
      setWidth(measured);
      fitRef.current?.(measured >= SPLIT_MIN_WIDTH_PX, measured);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const split = end !== null && end !== undefined;
  const range = rangeFor(width === null ? null : width - GUTTER_PX);
  const committed = clamp(ratio, range);
  const shown = dragRatio ?? committed;
  const percent = Math.round(shown * 100);

  const commit = (value: number, from: number, limits: Range) => {
    const next = settle(value, limits);
    if (next !== from) onRatioChange(next);
  };

  /** Larga o arraste: com `keep`, grava a posição do ponteiro (só se ele de fato andou). */
  const finish = (target: HTMLDivElement, keep: { clientX: number } | null) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    setDragRatio(null);
    if (target.hasPointerCapture?.(current.pointerId))
      target.releasePointerCapture(current.pointerId);
    if (!keep || !current.moved) return;
    const delta = (keep.clientX - current.startX) / current.avail;
    commit(current.from + delta, current.from, rangeFor(current.avail));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (event.button !== 0 || !event.isPrimary || !root) return;
    const target = event.currentTarget;
    const avail = root.getBoundingClientRect().width - target.getBoundingClientRect().width;
    if (avail <= 0) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      avail,
      from: shown,
      moved: false,
    };
    target.setPointerCapture?.(event.pointerId);
    // Esc cancela pelo divisor focado (foco explícito: nem todo motor foca no clique).
    target.focus({ preventScroll: true });
    setDragRatio(shown);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const delta = event.clientX - current.startX;
    if (!current.moved && Math.abs(delta) < DRAG_SLOP_PX) return;
    current.moved = true;
    setDragRatio(clamp(current.from + delta / current.avail, rangeFor(current.avail)));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (drag.current) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish(event.currentTarget, null);
      return;
    }
    const step = event.shiftKey ? BIG_STEP : STEP;
    const target =
      event.key === 'ArrowLeft'
        ? shown - step
        : event.key === 'ArrowRight'
          ? shown + step
          : event.key === 'PageDown'
            ? shown - BIG_STEP
            : event.key === 'PageUp'
              ? shown + BIG_STEP
              : event.key === 'Home'
                ? range.min
                : event.key === 'End'
                  ? range.max
                  : null;
    if (target === null) return;
    event.preventDefault();
    commit(target, committed, range);
  };

  return (
    <div
      ref={rootRef}
      className="smd-split"
      data-split={split ? 'on' : 'off'}
      data-dragging={dragRatio === null ? undefined : ''}
      style={{ '--smd-split-ratio': String(shown) } as CSSProperties}
    >
      <div id={startId} className="smd-split-pane smd-split-start">
        {start}
      </div>
      {split && (
        <>
          <div
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={separatorLabel}
            aria-controls={startId}
            aria-valuenow={percent}
            aria-valuemin={Math.round(range.min * 100)}
            aria-valuemax={Math.round(range.max * 100)}
            aria-valuetext={`${startLabel} ${percent}%, ${endLabel} ${100 - percent}%`}
            className="smd-split-separator"
            data-testid="split-separator"
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(event) => finish(event.currentTarget, event)}
            onPointerCancel={(event) => finish(event.currentTarget, null)}
            onLostPointerCapture={(event) => finish(event.currentTarget, null)}
            onDoubleClick={() => commit(0.5, committed, range)}
          />
          <div className="smd-split-pane smd-split-end">{end}</div>
        </>
      )}
    </div>
  );
}
