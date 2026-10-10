/**
 * Validação das respostas do LanguageTool (R-I8.9, AC-I8.8; NFR-59 ramos ≥ 90 %). Tudo o que vem
 * do servidor é dado não confiável: o corpo inteiro é descartado por JSON inválido, campo faltando
 * ou de tipo errado, `offset`/`length` fora do texto enviado, id de regra fora da forma que o Rust
 * aceita de volta em `disabledRules`, ou corpo > 2 MiB. Limites de exibição (JEV D-R7-S8-04 A):
 * mensagem ≤ 500 caracteres (cortada com "…"), ≤ 5 substituições de ≤ 200 caracteres (as mais
 * longas saem). Nada aqui vira HTML: o cartão usa `textContent`.
 */

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_MESSAGE_CHARS = 500;
export const MAX_REPLACEMENTS = 5;
export const MAX_REPLACEMENT_CHARS = 200;

/** Mesma forma de `policy::is_rule_id` (o id volta ao Rust em `disabledRules`). */
export const RULE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface LtMatch {
  readonly offset: number;
  readonly length: number;
  readonly message: string;
  readonly replacements: readonly string[];
  readonly ruleId: string;
  readonly categoryId: string;
  readonly issueType: string | null;
}

/** Motivo do descarte → código do indicador ("erro <código>", STR-166). */
export type ResponseError = 'resposta inválida' | 'resposta grande demais';

export type CheckResult =
  | { readonly ok: true; readonly matches: readonly LtMatch[] }
  | { readonly ok: false; readonly error: ResponseError };

const INVALID = { ok: false, error: 'resposta inválida' } as const;

/** Bytes UTF-8 de um texto, parando assim que passa de `limit`. */
export function utf8BytesOver(text: string, limit: number): boolean {
  if (text.length > limit) return true;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
    if (bytes > limit) return true;
  }
  return false;
}

/** Forma crua de uma correspondência do LT: todo campo é conferido por `typeof` antes do uso. */
interface RawMatch {
  readonly offset?: unknown;
  readonly length?: unknown;
  readonly message?: unknown;
  readonly replacements?: unknown;
  readonly rule?: {
    readonly id?: unknown;
    readonly issueType?: unknown;
    readonly category?: { readonly id?: unknown } | null;
  } | null;
}

/** `typeof x === 'object'` sem `null`: o resto da forma é conferido campo a campo. */
const asObject = <T>(value: unknown): Partial<T> | null =>
  typeof value === 'object' && value !== null ? (value as Partial<T>) : null;

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

function readMatch(value: unknown, sentLength: number): LtMatch | null {
  const raw = asObject<RawMatch>(value);
  if (!raw) return null;
  const { offset, length, message, replacements } = raw;
  if (!isCount(offset) || !isCount(length) || offset + length > sentLength) return null;
  if (typeof message !== 'string' || !Array.isArray(replacements)) return null;
  const rule = asObject<NonNullable<RawMatch['rule']>>(raw.rule);
  const categoryId = asObject<{ id: unknown }>(rule?.category)?.id;
  const id = rule?.id;
  const issueType = rule?.issueType;
  if (typeof id !== 'string' || !RULE_ID.test(id) || typeof categoryId !== 'string') return null;
  if (issueType !== undefined && typeof issueType !== 'string') return null;
  const values: string[] = [];
  for (const replacement of replacements as unknown[]) {
    const text = asObject<{ value: unknown }>(replacement)?.value;
    if (typeof text !== 'string') return null;
    if (values.length < MAX_REPLACEMENTS && text.length <= MAX_REPLACEMENT_CHARS) values.push(text);
  }
  return {
    offset,
    length,
    message:
      message.length <= MAX_MESSAGE_CHARS ? message : `${message.slice(0, MAX_MESSAGE_CHARS - 1)}…`,
    replacements: values,
    ruleId: id,
    categoryId,
    issueType: issueType ?? null,
  };
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Corpo de `POST /v2/check` → correspondências, ou o motivo do descarte. `sentLength` = unidades
 * UTF-16 do pedido (texto + markup): todo intervalo precisa caber nele.
 */
export function parseCheckResponse(body: string, sentLength: number): CheckResult {
  if (utf8BytesOver(body, MAX_RESPONSE_BYTES))
    return { ok: false, error: 'resposta grande demais' };
  const matchesRaw = asObject<{ matches: unknown }>(parseJson(body))?.matches;
  if (!Array.isArray(matchesRaw)) return INVALID;
  const matches: LtMatch[] = [];
  for (const raw of matchesRaw as unknown[]) {
    const match = readMatch(raw, sentLength);
    if (!match) return INVALID;
    matches.push(match);
  }
  return { ok: true, matches };
}

/** Corpo de `GET /v2/languages` → línguas (`code`, `longCode`), ou `null` se fora do esquema. */
export function parseLanguages(
  body: string,
): { readonly code: string; readonly longCode: string }[] | null {
  const json = parseJson(body);
  if (!Array.isArray(json)) return null;
  const out: { code: string; longCode: string }[] = [];
  for (const value of json as unknown[]) {
    const item = asObject<{ code: unknown; longCode: unknown }>(value);
    if (typeof item?.code !== 'string' || typeof item.longCode !== 'string') return null;
    out.push({ code: item.code, longCode: item.longCode });
  }
  return out;
}

/** Ortografia (sublinhado ondulado `danger`) × gramática/estilo (tracejado `fg`), R-I8.5. */
export function isSpelling(match: Pick<LtMatch, 'categoryId' | 'ruleId' | 'issueType'>): boolean {
  return (
    match.categoryId === 'TYPOS' ||
    match.ruleId.startsWith('MORFOLOGIK_') ||
    match.issueType === 'misspelling'
  );
}

/** Título do cartão (STR-168) pela categoria do LT. */
export function categoryLabel(match: Pick<LtMatch, 'categoryId' | 'ruleId' | 'issueType'>): string {
  if (isSpelling(match)) return 'Ortografia';
  switch (match.categoryId) {
    case 'GRAMMAR':
      return 'Gramática';
    case 'PUNCTUATION':
      return 'Pontuação';
    case 'STYLE':
    case 'REDUNDANCY':
      return 'Estilo';
    default:
      return 'Revisão';
  }
}
