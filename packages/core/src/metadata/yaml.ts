import { isMap, isNode, isScalar, parseDocument } from 'yaml';

/**
 * Leitura e validação do YAML do front matter (R-9.2; arch-backend r2 §1.5, D-B4). `yaml` 1.2 com o
 * schema core: `2026-10-07` continua texto (sem `Date` nem fuso), nenhum construtor de tag próprio
 * (`!!js/function` vira um valor comum com aviso do parser) e no máximo 100 expansões de alias.
 */

/** Mensagens STR-98 (avisos por campo). */
export const FRONT_MATTER_WARNINGS = {
  title: 'Aviso: title deve ser texto.',
  tags: 'Aviso: tags deve ser texto ou lista de textos.',
  date: 'Aviso: date deve ser uma data (AAAA-MM-DD ou ISO 8601).',
} as const;

export type FrontMatterField = keyof typeof FRONT_MATTER_WARNINGS;

/** Uma chave do front matter, na ordem do arquivo. */
export interface FrontMatterProperty {
  readonly key: string;
  readonly value: unknown;
  /** Offset do início da chave dentro do conteúdo YAML (para levar o cursor à linha). */
  readonly offset: number;
  /** STR-98 quando o campo conhecido tem tipo errado. */
  readonly warning?: string;
}

export interface FrontMatterData {
  readonly ok: true;
  readonly properties: readonly FrontMatterProperty[];
  /** `title` em texto (aparado, não vazio), senão `null`. */
  readonly title: string | null;
  /** Tags normalizadas (R-9.2). */
  readonly tags: readonly string[];
  /** `date` válida como escrita (ou ISO, se veio de um `Date`), senão `null`. */
  readonly date: string | null;
}

export interface FrontMatterError {
  readonly ok: false;
  /** Linha no ARQUIVO (1 = a linha `---` de abertura), como o editor numera. */
  readonly line: number;
  readonly message: string;
}

export type FrontMatterResult = FrontMatterData | FrontMatterError;

/** R-9.2: no máximo 100 expansões de alias; acima disso o front matter é inválido. */
export const MAX_ALIAS_COUNT = 100;

/** Mensagens pt-BR por código de erro do `yaml` (o texto em inglês da biblioteca não aparece). */
const ERROR_MESSAGES: Record<string, string> = {
  BAD_INDENT: 'indentação inválida',
  TAB_AS_INDENT: 'tabulação usada como indentação',
  BLOCK_AS_IMPLICIT_KEY: 'mapa aninhado numa chave em linha',
  MULTILINE_IMPLICIT_KEY: 'uma chave precisa ficar numa linha só',
  MISSING_CHAR: 'falta um caractere (aspas, colchete ou dois-pontos)',
  DUPLICATE_KEY: 'chave repetida',
  UNEXPECTED_TOKEN: 'símbolo inesperado',
  BAD_SCALAR_START: 'valor começa com um caractere reservado',
  BAD_DIRECTIVE: 'diretiva inválida',
  MULTIPLE_DOCS: 'mais de um documento YAML',
  MULTIPLE_ANCHORS: 'âncora repetida no mesmo valor',
  BAD_ALIAS: 'alias inválido',
  IMPOSSIBLE: 'estrutura impossível',
};

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;

/** `YYYY-MM-DD` ou data-hora ISO 8601, com mês, dia e hora possíveis no calendário. */
export function isValidDateText(text: string): boolean {
  const match = DATE_ONLY.exec(text) ?? DATE_TIME.exec(text);
  if (!match) return false;
  const [, y, m, d, hh = '0', mm = '0', ss = '0'] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days &&
    Number(hh) <= 23 &&
    Number(mm) <= 59 &&
    Number(ss) <= 59
  );
}

/**
 * Normaliza `tags` (R-9.2): texto → separado por vírgula; cada tag aparada e sem `#` inicial;
 * vazias saem; repetidas saem sem diferenciar maiúsculas (vale a primeira grafia); `/` é permitido.
 */
export function normalizeTags(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const piece of raw) {
    const tag = piece.trim().replace(/^#+/, '').trim();
    const key = tag.toLocaleLowerCase('pt-BR');
    if (tag === '' || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

interface Validated {
  readonly title: string | null;
  readonly tags: readonly string[];
  readonly date: string | null;
  readonly warnings: Partial<Record<FrontMatterField, string>>;
}

/** Valida os campos conhecidos (só avisos; R-9.2). Chaves desconhecidas não são tocadas. */
export function validateFrontMatter(data: Readonly<Record<string, unknown>>): Validated {
  const warnings: Partial<Record<FrontMatterField, string>> = {};
  let title: string | null = null;
  if ('title' in data) {
    if (typeof data.title === 'string') title = data.title.trim() || null;
    else warnings.title = FRONT_MATTER_WARNINGS.title;
  }
  let tags: string[] = [];
  if ('tags' in data) {
    const raw = data.tags;
    if (typeof raw === 'string') tags = normalizeTags(raw.split(','));
    else if (Array.isArray(raw) && raw.every((item) => typeof item === 'string'))
      tags = normalizeTags(raw);
    else if (raw !== null) warnings.tags = FRONT_MATTER_WARNINGS.tags;
  }
  let date: string | null = null;
  if ('date' in data) {
    const raw = data.date;
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) date = raw.toISOString();
    else if (typeof raw === 'string' && isValidDateText(raw.trim())) date = raw.trim();
    else if (raw !== null) warnings.date = FRONT_MATTER_WARNINGS.date;
  }
  return { title, tags, date, warnings };
}

/**
 * Lê o conteúdo YAML entre as linhas `---` (sem elas). Erro de sintaxe → linha do arquivo e a
 * mensagem; raiz que não é mapa → erro STR-97 da linha 1; vazio = mapa vazio.
 */
export function parseFrontMatterYaml(content: string): FrontMatterResult {
  const doc = parseDocument(content, {
    version: '1.2',
    schema: 'core',
    prettyErrors: true,
    uniqueKeys: true,
    customTags: [],
    merge: false,
  });
  const first = doc.errors[0];
  if (first) {
    const yamlLine = first.linePos?.[0].line ?? 1;
    return {
      ok: false,
      line: yamlLine + 1,
      message: ERROR_MESSAGES[first.code] ?? 'sintaxe YAML inválida',
    };
  }
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch {
    // ReferenceError do `yaml`: expansão de aliases acima do teto (ataque de "bilhão de risadas").
    return { ok: false, line: 2, message: 'aliases demais' };
  }
  if (data === null || data === undefined) {
    return { ok: true, properties: [], title: null, tags: [], date: null };
  }
  if (!isMap(doc.contents) || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, line: 1, message: 'o bloco precisa ser um mapa de chaves.' };
  }
  const record = data as Record<string, unknown>;
  const { title, tags, date, warnings } = validateFrontMatter(record);
  const properties: FrontMatterProperty[] = [];
  for (const pair of doc.contents.items) {
    const keyNode = pair.key;
    const key = isScalar(keyNode) ? String(keyNode.value) : String(keyNode);
    const warning = warnings[key as FrontMatterField];
    properties.push({
      key,
      value: record[key],
      offset: isNode(keyNode) ? (keyNode.range?.[0] ?? 0) : 0,
      ...(warning === undefined ? {} : { warning }),
    });
  }
  return { ok: true, properties, title, tags, date };
}
