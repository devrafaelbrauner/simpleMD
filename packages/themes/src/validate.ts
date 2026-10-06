import { tokenGroup, type ThemeBase, type ThemeFile, type TokenGroup } from './schema';

/**
 * Validador de `theme.json` v1 (arch-backend §1.7.2; R-5.6). Nunca lança: entrada inválida é um
 * caminho esperado (importação). As verificações seguem uma ordem fixa e a PRIMEIRA falha é
 * relatada com o campo que falhou (`arquivo`, `name`, `tokens.--color-bg`…; STR-32).
 */
export interface ThemeValidationError {
  /** Caminho do campo: `arquivo` para problemas do arquivo inteiro (CF-8). */
  readonly field: string;
  readonly message: string;
}

export type ThemeValidation =
  | { readonly ok: true; readonly theme: ThemeFile }
  | { readonly ok: false; readonly error: ThemeValidationError };

/** Teto de tamanho de um `theme.json` (NFR-15): 256 KB. */
export const THEME_MAX_BYTES = 262_144;
const NAME_MAX = 64;
const TOKENS_MAX = 256;
const VALUE_MAX = 256;
const CSS_MAX = 1024;
const KNOWN_KEYS: Record<string, true> = { name: true, base: true, tokens: true, css: true };

// eslint-disable-next-line no-control-regex -- detectar caracteres de controle é o objetivo
const CONTROL = /[\x00-\x1f\x7f]/;
/**
 * Lista negra global dos valores (sem diferenciar maiúsculas): fechamento de declaração/bloco,
 * HTML, escapes CSS (que contrabandeiam `url(` como `u\72l(`), comentários, `url(`, `@import` e
 * `expression(`. Caracteres de controle são checados à parte.
 */
const DENYLIST = /[;{}<>\\]|\/\*|\*\/|url\s*\(|@import|expression\s*\(/i;

const GROUP_RULES: Record<TokenGroup, { test(value: string): boolean; message: string }> = {
  color: {
    test: (v) => /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v),
    message: 'cor deve ser hexadecimal (#rgb, #rgba, #rrggbb ou #rrggbbaa)',
  },
  dimension: {
    test: (v) => /^-?(?:\d+|\d*\.\d+)(?:px|rem|em|%|vh|vw)$/.test(v),
    message: 'dimensão precisa de número e unidade (px, rem, em, %, vh ou vw)',
  },
  fontFamily: {
    test: isFontFamilyList,
    message: 'lista de fontes inválida',
  },
  fontWeight: {
    test: (v) => /^(?:[1-9]00|normal|bold)$/.test(v),
    message: 'peso deve ser 100…900, normal ou bold',
  },
  duration: {
    test: (v) => /^(?:\d+|\d*\.\d+)(?:ms|s)$/.test(v),
    message: 'duração precisa de número e unidade (ms ou s)',
  },
  shadow: {
    test: (v) =>
      /^[A-Za-z0-9#.,%()\s-]+$/.test(v) &&
      [...v.matchAll(/([A-Za-z-]*)\(/g)].every(([, fn]) =>
        ['rgb', 'rgba', 'hsl', 'hsla'].includes((fn ?? '').toLowerCase()),
      ),
    message: 'sombra inválida',
  },
};

/** Itens separados por vírgula: nome sem aspas ou nome inteiro entre aspas (balanceadas). */
function isFontFamilyList(value: string): boolean {
  if (!/^[A-Za-z0-9 ,'"_-]+$/.test(value)) return false;
  return value
    .split(',')
    .map((item) => item.trim())
    .every((item) => /^"[^"']+"$|^'[^"']+'$|^[A-Za-z0-9_-][A-Za-z0-9 _-]*$/.test(item));
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

const fail = (field: string, message: string): ThemeValidation => ({
  ok: false,
  error: { field, message },
});

const utf8 = new TextDecoder('utf-8', { fatal: true });

export function validateTheme(input: Uint8Array | string | unknown): ThemeValidation {
  let data: unknown = input;
  if (input instanceof Uint8Array || typeof input === 'string') {
    // 1–2. Tamanho e JSON.
    const size = typeof input === 'string' ? new TextEncoder().encode(input).length : input.length;
    if (size > THEME_MAX_BYTES) return fail('arquivo', 'maior que 256 KB');
    try {
      data = JSON.parse(typeof input === 'string' ? input : utf8.decode(input));
    } catch {
      return fail('arquivo', 'JSON malformado');
    }
  }
  // 3. Raiz é um objeto simples.
  if (!isPlainObject(data)) return fail('arquivo', 'o conteúdo não é um objeto JSON');
  // 4. Chaves desconhecidas no topo (a primeira em ordem alfabética).
  const unknown = Object.keys(data)
    .filter((key) => !Object.hasOwn(KNOWN_KEYS, key))
    .sort()[0];
  if (unknown !== undefined) return fail(unknown, 'campo desconhecido no esquema v1');
  // 5. Nome e base.
  const { name, base, tokens, css } = data;
  if (typeof name !== 'string' || CONTROL.test(name)) return fail('name', 'nome inválido');
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX)
    return fail('name', `o nome precisa ter de 1 a ${NAME_MAX} caracteres`);
  if (base !== 'light' && base !== 'dark') return fail('base', 'deve ser "light" ou "dark"');
  // 6. Tokens: objeto com 1..256 entradas; cada uma em ordem lexicográfica.
  if (!isPlainObject(tokens)) return fail('tokens', 'deve ser um objeto');
  const names = Object.keys(tokens).sort();
  if (names.length === 0 || names.length > TOKENS_MAX)
    return fail('tokens', `precisa ter de 1 a ${TOKENS_MAX} tokens`);
  const checked: Record<string, string> = {};
  for (const key of names) {
    const field = `tokens.${key}`;
    const group = tokenGroup(key);
    if (group === null) return fail(field, 'nome de token fora do padrão --<grupo>-<nome> (D-1)');
    const value = tokens[key];
    if (typeof value !== 'string') return fail(field, 'o valor deve ser texto');
    if (value.length === 0 || value.length > VALUE_MAX || CONTROL.test(value))
      return fail(
        field,
        `o valor precisa ter de 1 a ${VALUE_MAX} caracteres, sem quebras de linha`,
      );
    if (DENYLIST.test(value)) return fail(field, 'o valor contém caracteres ou funções proibidos');
    const rule = GROUP_RULES[group];
    if (!rule.test(value)) return fail(field, rule.message);
    checked[key] = value;
  }
  // 7. `css`: só tipo e tamanho (preservado, nunca carregado; D-5).
  if (css !== undefined && (typeof css !== 'string' || css.length > CSS_MAX || CONTROL.test(css)))
    return fail('css', `deve ser texto de até ${CSS_MAX} caracteres`);
  const theme: ThemeFile = {
    name: trimmed,
    base: base satisfies ThemeBase,
    tokens: checked,
    ...(css === undefined ? {} : { css }),
  };
  return { ok: true, theme };
}
