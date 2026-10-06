import type { ButtonHTMLAttributes, Ref } from 'react';

/**
 * Botão (shadcn "button" reescrito à mão com as classes D-1; DESIGN §8.1). `aria-disabled` mantém o
 * botão focável (o motivo fica descobrível) e bloqueia o clique.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  ref?: Ref<HTMLButtonElement>;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'smd-btn smd-btn-primary',
  secondary: 'smd-btn smd-btn-secondary',
  ghost: 'smd-btn smd-btn-ghost',
  icon: 'smd-btn smd-btn-ghost smd-btn-icon',
};

export function Button({ variant = 'secondary', className, onClick, ...props }: ButtonProps) {
  const disabled = props['aria-disabled'] === true || props['aria-disabled'] === 'true';
  return (
    <button
      type="button"
      {...props}
      className={className ? `${VARIANT_CLASS[variant]} ${className}` : VARIANT_CLASS[variant]}
      onClick={disabled ? undefined : onClick}
    />
  );
}
