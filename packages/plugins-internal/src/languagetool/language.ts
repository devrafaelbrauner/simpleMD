import type { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

/**
 * Língua do pedido ao LanguageTool (R-I8.3, AC-I8.3): o `lang` do front matter (mapeado para o
 * código do LT) vence; sem ele, a opção "Idioma padrão" (padrão `pt-BR`); "Automático" → `auto`
 * com `preferredVariants=pt-BR,en-US` (o servidor sem fastText usa o próprio detector).
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

/** Mesma forma que o Rust aceita (`policy::is_language_code`): `xx[-Yy…]`, ≤ 35 bytes. */
const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/;

/**
 * Normaliza um `lang` escrito à mão (`pt_br`, `PT-BR`, `"en-US"`) para a forma do LT
 * (`pt-BR`): primário minúsculo, região de 2 letras maiúscula, o resto como veio. `null` se não
 * tem a forma de um código.
 */
export function normalizeLanguage(raw: string): string | null {
  const parts = raw.trim().replace(/_/g, '-').split('-');
  const [primary = '', ...rest] = parts;
  const normalized = [
    primary.toLowerCase(),
    ...rest.map((part, i) => (i === 0 && /^[a-z]{2}$/i.test(part) ? part.toUpperCase() : part)),
  ].join('-');
  return normalized.length <= 35 && LANGUAGE_CODE.test(normalized) ? normalized : null;
}

/**
 * `lang:` do front matter (só a linha de topo `lang: valor`, aspas opcionais). `null` sem front
 * matter, sem `lang` ou com valor que não é código de língua.
 */
export function frontMatterLang(state: EditorState): string | null {
  const node = syntaxTree(state).topNode.firstChild;
  if (node?.name !== 'FrontMatter') return null;
  const text = state.doc.sliceString(node.from, node.to);
  const match = /^lang[ \t]*:[ \t]*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s#]+))[ \t]*(?:#.*)?$/m.exec(text);
  if (!match) return null;
  return normalizeLanguage(match[1] ?? match[2] ?? match[3] ?? '');
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
