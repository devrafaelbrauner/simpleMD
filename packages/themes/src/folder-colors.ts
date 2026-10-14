/**
 * Cores de pasta (r12, D-R12-P4): lista fechada de ids ASCII. Cada id vira o token opcional
 * `--color-folder-<id>` (claro em `tokens.css`, escuro em `builtin/simplemd-dark.json`); fora
 * desses dois arquivos a cor só aparece como `var(--color-folder-<id>)`, nunca como valor.
 */
export const FOLDER_COLOR_IDS = [
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
] as const;

export type FolderColorId = (typeof FOLDER_COLOR_IDS)[number];

export function isFolderColorId(value: unknown): value is FolderColorId {
  return typeof value === 'string' && (FOLDER_COLOR_IDS as readonly string[]).includes(value);
}
