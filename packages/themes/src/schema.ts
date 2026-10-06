/**
 * Esquema de tema v1 (PLANO §4.2 com os nomes da decisão D-1; arch-backend §1.7.1). Os nomes dos
 * tokens são as mesmas propriedades CSS que `tokens.css` declara: `--<grupo>-<nome>`, com o grupo
 * em camelCase exato (`--fontFamily-mono`).
 */
export type ThemeBase = 'light' | 'dark';

export const TOKEN_GROUPS = [
  'color',
  'dimension',
  'fontFamily',
  'fontWeight',
  'duration',
  'shadow',
] as const;
export type TokenGroup = (typeof TOKEN_GROUPS)[number];

/** D-1: `^--(color|dimension|fontFamily|fontWeight|duration|shadow)-[a-z0-9]+(-[a-z0-9]+)*$`. */
export const TOKEN_NAME_RE =
  /^--(color|dimension|fontFamily|fontWeight|duration|shadow)-[a-z0-9]+(-[a-z0-9]+)*$/;

/** Conjunto obrigatório v1 (11 tokens, D-1), na ordem do formulário do editor de temas. */
export const REQUIRED_TOKENS = [
  '--color-bg',
  '--color-fg',
  '--color-muted',
  '--color-accent',
  '--color-border',
  '--color-selection',
  '--color-sidebar-bg',
  '--color-code-bg',
  '--fontFamily-ui',
  '--fontFamily-mono',
  '--dimension-font-size',
] as const;
export type RequiredToken = (typeof REQUIRED_TOKENS)[number];

export type Tokens = Readonly<Record<string, string>>;

/** O conteúdo de um `theme.json` (esquema v1). `css` é preservado, nunca aplicado (D-5). */
export interface ThemeFile {
  readonly name: string;
  readonly base: ThemeBase;
  readonly tokens: Tokens;
  readonly css?: string;
}

/** Tema disponível no app: embutido (`simplemd-light`, `simplemd-dark`) ou do vault (slug). */
export interface Theme extends ThemeFile {
  readonly id: string;
  readonly builtin: boolean;
}

/** Ids de tema (embutidos e pastas em `.simplemd/themes/<id>/`): slug ASCII em kebab-case. */
export const THEME_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const THEME_ID_MAX = 64;

export const isThemeId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= THEME_ID_MAX && THEME_ID_RE.test(value);

/** Grupo do token (`--fontFamily-mono` → `fontFamily`); `null` se o nome não segue D-1. */
export function tokenGroup(name: string): TokenGroup | null {
  const match = TOKEN_NAME_RE.exec(name);
  return match ? (match[1] as TokenGroup) : null;
}

/** Tokens obrigatórios ausentes (AC-4.1 avalia os temas embutidos com isto). */
export function missingRequiredTokens(tokens: Tokens): RequiredToken[] {
  return REQUIRED_TOKENS.filter((name) => !(name in tokens));
}
