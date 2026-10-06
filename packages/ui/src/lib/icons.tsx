import type { ReactNode } from 'react';

/** Ícones monolinha de 16 px (DESIGN §2): só em botões da barra, glifos de estado e avisos. */
const PATHS = {
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  warn: (
    <>
      <path d="M12 3.5 21.5 20h-19z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  conflict: <path d="M7 20V4M4 7l3-3 3 3M17 4v16M14 17l3 3 3-3" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 10.5 21.4 10.7 21.4 13.3 19 13.5 18.1 15.9 19.6 17.7 17.7 19.6 15.9 18.1 13.5 19 13.3 21.4 10.7 21.4 10.5 19 8.1 18.1 6.3 19.6 4.4 17.7 5.9 15.9 5 13.5 2.6 13.3 2.6 10.7 5 10.5 5.9 8.1 4.4 6.3 6.3 4.4 8.1 5.9 10.5 5 10.7 2.6 13.3 2.6 13.5 5 15.9 5.9 17.7 4.4 19.6 6.3 18.1 8.1z" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`smd-icon ${className ?? ''}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
