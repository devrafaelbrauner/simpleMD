/**
 * Espelho TS do validador do comando nativo `open_url` (`src-tauri/src/opener.rs`, arch-backend
 * r7 §1.2; R-X7.6, D-25). Mesma ordem de regras e mesmos códigos; a paridade é provada pela tabela
 * única `packages/core/test/fixtures/open-url-cases.json`, lida pelo Rust e pelo Vitest. O TS
 * decide o aviso "Link não suportado: …" sem chamar o Rust; o Rust revalida (defesa em profundidade).
 */

/** Códigos de recusa (os do Rust). */
export type UrlRefusal =
  | 'URL_TOO_LONG'
  | 'URL_CONTROL_CHAR'
  | 'URL_INVALID'
  | 'URL_SCHEME_NOT_ALLOWED'
  | 'URL_CREDENTIALS'
  | 'URL_MAILTO_PARAM';

export type UrlCheck =
  { readonly ok: true; readonly url: URL } | { readonly ok: false; readonly code: UrlRefusal };

/** Entrada crua, em code points. */
export const URL_MAX_CHARS = 2048;
/** Bytes UTF-8 da forma serializada. */
export const URL_MAX_SERIALIZED = 8192;

const SCHEMES: Readonly<Record<string, true>> = { 'http:': true, 'https:': true, 'mailto:': true };
const MAILTO_KEYS: Readonly<Record<string, true>> = {
  to: true,
  cc: true,
  bcc: true,
  subject: true,
  body: true,
  'in-reply-to': true,
};

/**
 * Controle (`Cc`) ou formatação invisível: a mesma lista explícita do Rust (`is_format_char`,
 * categoria `Cf` do Unicode 15.1), não `\p{Cf}`, para não divergir com a versão do Unicode do motor.
 */
const CONTROL_OR_FORMAT =
  /[\p{Cc}\u00AD\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\u{110BD}\u{110CD}\u{13430}-\u{1343F}\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0001}\u{E0020}-\u{E007F}]/u;

/** `char::is_whitespace` do Rust (propriedade `White_Space`). */
const EDGE_SPACE = /^\p{White_Space}|\p{White_Space}$/u;

/** Só caracteres de URI (RFC 3986) e `%` apenas como `%HH` (SN-SEC-01). */
const URI_SAFE = /^(?:[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]|%[0-9A-Fa-f]{2})*$/;

const encoder = new TextEncoder();

/** Valida como o Rust: a URL normalizada (`URL.href`) ou o código da primeira regra que falha. */
export function validateUrl(input: string): UrlCheck {
  // Code points (scalar values do Rust), não unidades UTF-16; barato antes de olhar o resto.
  if (input.length > URL_MAX_CHARS && Array.from(input).length > URL_MAX_CHARS)
    return { ok: false, code: 'URL_TOO_LONG' };
  if (CONTROL_OR_FORMAT.test(input)) return { ok: false, code: 'URL_CONTROL_CHAR' };
  if (EDGE_SPACE.test(input)) return { ok: false, code: 'URL_INVALID' };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, code: 'URL_INVALID' };
  }
  if (!SCHEMES[url.protocol]) return { ok: false, code: 'URL_SCHEME_NOT_ALLOWED' };
  if (url.protocol === 'mailto:') {
    const keys = [...url.searchParams.keys()].map((key) => key.toLowerCase());
    if (url.pathname === '' && !keys.includes('to')) return { ok: false, code: 'URL_INVALID' };
    // RFC 6068 só separa campos por `&`; fragmento, `;` na consulta e `;`/`=` nos endereços
    // contrabandeariam `attach` (SN-SEC-07). `url.hash` não distingue `#` vazio de ausente.
    const smuggled =
      url.href.includes('#') ||
      url.search.includes(';') ||
      url.pathname.includes(';') ||
      url.pathname.includes('=');
    if (smuggled || keys.some((key) => !MAILTO_KEYS[key]))
      return { ok: false, code: 'URL_MAILTO_PARAM' };
  } else if (url.username !== '' || url.password !== '') {
    return { ok: false, code: 'URL_CREDENTIALS' };
  }
  if (!URI_SAFE.test(url.href)) return { ok: false, code: 'URL_INVALID' };
  if (encoder.encode(url.href).length > URL_MAX_SERIALIZED)
    return { ok: false, code: 'URL_TOO_LONG' };
  return { ok: true, url };
}

/** O código de recusa, ou `null` se a URL passa (forma do `validate` do falso do harness, F-11). */
export function urlRefusal(input: string): UrlRefusal | null {
  const check = validateUrl(input);
  return check.ok ? null : check.code;
}
