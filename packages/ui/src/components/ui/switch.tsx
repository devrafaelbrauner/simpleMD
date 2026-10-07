import type { Ref } from 'react';

export interface SwitchProps {
  checked: boolean;
  /** Nome acessível (ex.: `Ativar “Hello World”`, STR-67). */
  label: string;
  onChange(next: boolean): void;
  /** Continua focável; o clique não faz nada e o motivo vem por `aria-describedby`. */
  disabled?: boolean;
  describedBy?: string;
  ref?: Ref<HTMLButtonElement>;
  'data-testid'?: string;
}

/**
 * Interruptor `<button role="switch">` (DESIGN §8.14): área de toque 40×24 px com trilho 32×18 px
 * centrado. Espaço e Enter alternam (padrão do botão).
 */
export function Switch({
  checked,
  label,
  onChange,
  disabled = false,
  describedBy,
  ref,
  'data-testid': testId,
}: SwitchProps) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      className="smd-switch-box"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      aria-disabled={disabled || undefined}
      data-testid={testId}
      onClick={disabled ? undefined : () => onChange(!checked)}
    >
      <span className="smd-switch-track" aria-hidden="true" />
    </button>
  );
}
