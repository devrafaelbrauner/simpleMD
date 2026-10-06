import type { ThemeFile } from './schema';

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value !== 'object' || value === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort())
    sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
  return sorted;
}

/**
 * Serialização determinística de um `theme.json` (R-5.3, arch-backend §1.7.3): chaves ordenadas em
 * todos os níveis, indentação de 2 espaços, LF e `\n` final. É o formato dos temas gravados,
 * importados (reserializados) e dos embutidos exportados.
 */
export function serializeTheme(theme: ThemeFile): string {
  const file: Record<string, unknown> = {
    name: theme.name,
    base: theme.base,
    tokens: theme.tokens,
  };
  if (theme.css !== undefined) file.css = theme.css;
  return `${JSON.stringify(sortKeysDeep(file), null, 2)}\n`;
}
