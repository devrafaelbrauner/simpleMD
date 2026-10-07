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
  // r2 (DESIGN §8.10)
  'panel-right': (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </>
  ),
  command: <path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3z" />,
  export: (
    <>
      <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
      <path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
    </>
  ),
  'chevron-down': <path d="M6 9l6 6 6-6" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  ban: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.7 5.7l12.6 12.6" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11A8 8 0 0 0 5.6 6.4L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14.4 4.6L20 16" />
      <path d="M20 20v-4h-4" />
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
