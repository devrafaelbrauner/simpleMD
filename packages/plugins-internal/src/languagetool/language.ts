/**
 * Língua do pedido ao LanguageTool (R-I8.3, AC-I8.3): o `lang` do front matter (`frontMatterLang`,
 * de `shared/prose.ts`, mapeado para o código do LT) vence; sem ele, a opção "Idioma padrão"
 * (padrão `pt-BR`); "Automático" → `auto` com `preferredVariants=pt-BR,en-US` (o servidor sem
 * fastText usa o próprio detector).
 */

/** Valores da opção "Idioma padrão" (arch-ux §3.3.1), na ordem do seletor. */
export const LANGUAGE_CHOICES = [
  { value: 'pt-BR', label: 'Português (Brasil)', lang: 'pt-BR' },
  { value: 'pt-PT', label: 'Português (Portugal)', lang: 'pt-PT' },
  { value: 'en-US', label: 'English (US)', lang: 'en-US' },
  { value: 'en-GB', label: 'English (UK)', lang: 'en-GB' },
  { value: 'es', label: 'Español', lang: 'es' },
  { value: 'fr', label: 'Français', lang: 'fr' },
  { value: 'de', label: 'Deutsch', lang: 'de' },
  { value: 'auto', label: 'Automático' },
] as const;

export const DEFAULT_LANGUAGE = 'pt-BR';
export const AUTO_VARIANTS: readonly string[] = ['pt-BR', 'en-US'];

export interface RequestLanguage {
  readonly language: string;
  readonly preferredVariants?: readonly string[];
}

/** Língua anunciada pelo servidor em `GET /v2/languages`. */
export interface ServerLanguage {
  readonly code: string;
  readonly longCode: string;
}

/**
 * Casa um código com a lista do servidor: `longCode` igual (sem diferença de caixa) vence; senão
 * uma entrada cujo `longCode` é o primário (`de`, `es`). `null` se o servidor não tem a língua.
 */
export function supportedLanguage(
  code: string,
  languages: readonly ServerLanguage[],
): string | null {
  const lower = code.toLowerCase();
  const exact = languages.find((l) => l.longCode.toLowerCase() === lower);
  if (exact) return exact.longCode;
  const primary = lower.split('-')[0];
  return languages.find((l) => l.longCode.toLowerCase() === primary)?.longCode ?? null;
}

/**
 * Língua do pedido: `lang` do front matter (se o servidor a conhece), senão a opção. A opção
 * `auto` vira `auto` + variantes preferidas; uma opção fora da lista volta ao padrão `pt-BR`.
 */
export function requestLanguage(
  option: string,
  fmLang: string | null,
  languages: readonly ServerLanguage[],
): RequestLanguage {
  if (fmLang) {
    const known = supportedLanguage(fmLang, languages);
    if (known) return { language: known };
  }
  if (option === 'auto') return { language: 'auto', preferredVariants: AUTO_VARIANTS };
  return {
    language: LANGUAGE_CHOICES.some((c) => c.value === option) ? option : DEFAULT_LANGUAGE,
  };
}
