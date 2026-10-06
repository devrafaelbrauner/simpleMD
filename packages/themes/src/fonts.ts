import fontsJson from './fonts.json';

/**
 * Famílias do seletor "Família" (R-4.4, STR-27), na ordem exigida por AC-4.5. As pilhas ficam em
 * `fonts.json` (não em TS), e a da JetBrains Mono é igual ao valor de `--fontFamily-mono` em
 * tokens.css (handoff §3 item 6; um teste confere).
 */
export interface FontOption {
  /** Valor gravado em `config.json` (`editor.fontFamily`) e rótulo da opção. */
  readonly label: FontFamilyName;
  /** Primeira família da pilha (o nome do `@font-face` nas fontes embutidas). */
  readonly family: string;
  /** Embutida em woff2 (as três primeiras) ou do sistema. */
  readonly bundled: boolean;
  /** Valor CSS de `font-family` gravado em `--fontFamily-mono`. */
  readonly stack: string;
}

export const FONT_FAMILY_NAMES = [
  'JetBrains Mono',
  'Fira Code',
  'Cascadia Code',
  'Monospace do sistema',
] as const;
export type FontFamilyName = (typeof FONT_FAMILY_NAMES)[number];

export const isFontFamilyName = (value: unknown): value is FontFamilyName =>
  FONT_FAMILY_NAMES.includes(value as FontFamilyName);

export const FONT_OPTIONS: readonly FontOption[] = FONT_FAMILY_NAMES.map((label) => {
  const entry = fontsJson.find((font) => font.label === label);
  if (!entry) throw new Error(`fonts.json sem a família "${label}"`);
  return Object.freeze({ ...entry, label });
});

export function fontOption(label: FontFamilyName): FontOption {
  // FONT_OPTIONS tem exatamente uma entrada por nome (conferido acima).
  return FONT_OPTIONS.find((font) => font.label === label) as FontOption;
}
