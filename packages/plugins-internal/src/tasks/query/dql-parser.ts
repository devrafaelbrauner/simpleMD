/**
 * Parser do subconjunto DQL do bloco ```` ```dataview ```` (R-I9.5, AC-I9.4; `docs/consultas.md`).
 * Descida recursiva própria, inspirada na gramática de `src/query/parse.ts` e
 * `src/expression/parse.ts` do obsidian-dataview 0.5.70 (MIT; nenhum código copiado).
 *
 * `LIST [expr]` | `TABLE expr [AS "rótulo"], …` | `TASK`, depois `FROM`, `WHERE`, `SORT`,
 * `GROUP BY`, `LIMIT`. Fora do subconjunto (FLATTEN, CALENDAR, `WITHOUT ID`, campos inline
 * `chave::`, outras funções, aritmética, `file.*` desconhecido) → "Não suportado nas consultas do
 * simpleMD: <construção> (linha N)."; texto que não forma a gramática → "Instrução não reconhecida
 * na linha N: <linha>". JavaScript (```` ```dataviewjs ````, `$=`) nunca é executado.
 */
import { isIsoDate } from './dates';
import { QUERY_LIMIT_MAX, unrecognized, type DateRef, type QueryError } from './tasks-parser';

export const JS_REFUSED = 'Consultas em JavaScript não são suportadas';

export const jsRefused = (): QueryError => ({ kind: 'error', message: JS_REFUSED, line: 0 });

/** Campos `file.*` do subconjunto. */
export const FILE_FIELDS = ['name', 'path', 'folder', 'mtime', 'size', 'tags'] as const;

export type CompareOp = '=' | '!=' | '<' | '<=' | '>' | '>=';

export type DqlExpr =
  | { readonly kind: 'literal'; readonly value: string | number | boolean | null }
  | { readonly kind: 'date'; readonly date: DateRef }
  | { readonly kind: 'field'; readonly path: readonly string[] }
  | { readonly kind: 'compare'; readonly op: CompareOp; readonly left: DqlExpr; readonly right: DqlExpr }
  | { readonly kind: 'and' | 'or'; readonly left: DqlExpr; readonly right: DqlExpr }
  | { readonly kind: 'not'; readonly operand: DqlExpr }
  | { readonly kind: 'contains'; readonly haystack: DqlExpr; readonly needle: DqlExpr };

export type DqlSource =
  | { readonly kind: 'tag'; readonly tag: string }
  | { readonly kind: 'folder'; readonly path: string }
  | { readonly kind: 'link'; readonly target: string }
  | { readonly kind: 'and' | 'or'; readonly left: DqlSource; readonly right: DqlSource }
  | { readonly kind: 'not'; readonly operand: DqlSource };

export interface DqlColumn {
  readonly expr: DqlExpr;
  readonly label: string;
}

export interface DqlQuery {
  readonly kind: 'dataview';
  readonly type: 'LIST' | 'TABLE' | 'TASK';
  /** `LIST expr`: valor mostrado ao lado do link da nota. */
  readonly listExpr: DqlColumn | null;
  readonly columns: readonly DqlColumn[];
  readonly from: DqlSource | null;
  readonly where: readonly DqlExpr[];
  readonly sort: readonly { readonly expr: DqlExpr; readonly desc: boolean }[];
  readonly groupBy: DqlColumn | null;
  readonly limit: number | null;
}

type TokenKind = 'word' | 'string' | 'number' | 'op' | 'tag' | 'link' | 'end';

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  /** Valor sem aspas/colchetes (`string`, `link`). */
  readonly value: string;
  readonly line: number;
  readonly from: number;
  readonly to: number;
}

class Refusal extends Error {
  constructor(readonly error: QueryError) {
    super(error.message);
  }
}

const unsupported = (construct: string, line: number): Refusal =>
  new Refusal({
    kind: 'error',
    message: `Não suportado nas consultas do simpleMD: ${construct} (linha ${line}).`,
    line,
  });

const WORD = /[\p{L}\p{N}_-]/u;
const WORD_START = /[\p{L}_]/u;

function tokenize(source: string, lineText: (line: number) => string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let i = 0;
  const push = (kind: TokenKind, from: number, to: number, value = source.slice(from, to)) =>
    tokens.push({ kind, text: source.slice(from, to), value, line, from, to });

  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\n') {
      line++;
      i++;
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
    } else if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"' && source[j] !== '\n') {
        if (source[j] === '\\' && j + 1 < source.length) j++;
        value += source[j];
        j++;
      }
      if (source[j] !== '"') throw new Refusal(unrecognized(line, lineText(line)));
      push('string', i, j + 1, value);
      i = j + 1;
    } else if (ch === '[' && source[i + 1] === '[') {
      const end = source.indexOf(']]', i + 2);
      if (end === -1 || source.slice(i + 2, end).includes('\n'))
        throw new Refusal(unrecognized(line, lineText(line)));
      push('link', i, end + 2, source.slice(i + 2, end).split('|')[0]!.trim());
      i = end + 2;
    } else if (ch === '#' && i + 1 < source.length && /[^\s#()"',]/.test(source[i + 1]!)) {
      let j = i + 1;
      while (j < source.length && /[^\s#()"',]/.test(source[j]!)) j++;
      push('tag', i, j);
      i = j;
    } else if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j]!)) j++;
      // `2026-10-12` dentro de date(…): uma data inteira vira um token só.
      const date = /^\d{4}-\d{2}-\d{2}/.exec(source.slice(i));
      if (date) j = i + date[0].length;
      push(date ? 'word' : 'number', i, j);
      i = j;
    } else if (WORD_START.test(ch)) {
      let j = i + 1;
      while (j < source.length && WORD.test(source[j]!)) j++;
      if (source.startsWith('::', j)) throw unsupported(`${source.slice(i, j)}::`, line);
      push('word', i, j);
      i = j;
    } else {
      const two = source.slice(i, i + 2);
      if (two === '::') throw unsupported('::', line);
      if (two === '$=') throw new Refusal(jsRefused());
      if (two === '!=' || two === '<=' || two === '>=') {
        push('op', i, i + 2);
        i += 2;
      } else if ('=<>!(),.-'.includes(ch)) {
        push('op', i, i + 1);
        i++;
      } else if ('+*/%'.includes(ch)) {
        throw unsupported(`operador ${ch}`, line);
      } else {
        throw new Refusal(unrecognized(line, lineText(line)));
      }
    }
  }
  tokens.push({ kind: 'end', text: '', value: '', line, from: source.length, to: source.length });
  return tokens;
}

const CLAUSES = new Set(['FROM', 'WHERE', 'SORT', 'GROUP', 'LIMIT']);
/** Construções do DQL completo recusadas pelo nome (R-I9.5). */
const REFUSED_CLAUSES = new Set(['FLATTEN', 'CALENDAR']);

/** Analisa o texto de um bloco ```` ```dataview ````. */
export function parseDataviewQuery(source: string): DqlQuery | QueryError {
  const lines = source.split('\n');
  const lineText = (line: number) => (lines[line - 1] ?? '').trim();
  if (source.trimStart().startsWith('$=')) return jsRefused();
  try {
    return new DqlParser(source, tokenize(source, lineText), lineText).query();
  } catch (error) {
    if (error instanceof Refusal) return error.error;
    throw error;
  }
}

class DqlParser {
  private pos = 0;

  constructor(
    private readonly source: string,
    private readonly tokens: readonly Token[],
    private readonly lineText: (line: number) => string,
  ) {}

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const token = this.peek();
    if (token.kind !== 'end') this.pos++;
    return token;
  }

  private isWord(word: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.kind === 'word' && token.text.toUpperCase() === word;
  }

  private isOp(op: string): boolean {
    const token = this.peek();
    return token.kind === 'op' && token.text === op;
  }

  private fail(token = this.peek()): Refusal {
    const line = token.kind === 'end' ? this.tokens[Math.max(0, this.pos - 1)]!.line : token.line;
    return new Refusal(unrecognized(line, this.lineText(line)));
  }

  private expectOp(op: string): void {
    if (!this.isOp(op)) throw this.fail();
    this.next();
  }

  /** Palavra no lugar de uma cláusula: recusada pelo nome ou não reconhecida. */
  private refuseWord(token: Token): Refusal {
    const word = token.text.toUpperCase();
    if (REFUSED_CLAUSES.has(word)) return unsupported(word, token.line);
    if (word === 'WITHOUT' && this.isWord('ID', 1)) return unsupported('WITHOUT ID', token.line);
    return this.fail(token);
  }

  query(): DqlQuery {
    const head = this.next();
    if (head.kind !== 'word') throw this.fail(head);
    const type = head.text.toUpperCase();
    if (type !== 'LIST' && type !== 'TABLE' && type !== 'TASK') {
      if (REFUSED_CLAUSES.has(type) || type === 'FLATTEN') throw unsupported(type, head.line);
      throw this.fail(head);
    }
    if (this.isWord('WITHOUT')) throw this.refuseWord(this.peek());

    let listExpr: DqlColumn | null = null;
    const columns: DqlColumn[] = [];
    if (type === 'LIST' && !this.atClause()) listExpr = this.column(false);
    if (type === 'TABLE' && !this.atClause()) {
      columns.push(this.column(true));
      while (this.isOp(',')) {
        this.next();
        columns.push(this.column(true));
      }
    }

    let from: DqlSource | null = null;
    const where: DqlExpr[] = [];
    const sort: { expr: DqlExpr; desc: boolean }[] = [];
    let groupBy: DqlColumn | null = null;
    let limit: number | null = null;

    if (this.isWord('FROM')) {
      this.next();
      from = this.sourceOr();
    }
    while (this.peek().kind !== 'end') {
      const token = this.next();
      const word = token.kind === 'word' ? token.text.toUpperCase() : '';
      if (word === 'WHERE') {
        where.push(this.expr());
      } else if (word === 'SORT') {
        do {
          if (sort.length > 0 || this.isOp(',')) this.expectOp(',');
          const expr = this.expr();
          let desc = false;
          if (this.isWord('ASC') || this.isWord('ASCENDING')) this.next();
          else if (this.isWord('DESC') || this.isWord('DESCENDING')) {
            this.next();
            desc = true;
          }
          sort.push({ expr, desc });
        } while (this.isOp(','));
      } else if (word === 'GROUP' && this.isWord('BY')) {
        this.next();
        if (groupBy) throw this.fail(token);
        groupBy = this.column(false);
      } else if (word === 'LIMIT') {
        const value = this.next();
        if (value.kind !== 'number' || !/^\d+$/.test(value.text)) throw this.fail(value);
        const n = Number(value.text);
        if (n > QUERY_LIMIT_MAX) throw this.fail(value);
        limit = n;
      } else if (word === 'FROM') {
        throw this.fail(token);
      } else if (token.kind === 'word') {
        throw this.refuseWord(token);
      } else {
        throw this.fail(token);
      }
    }
    return {
      kind: 'dataview',
      type,
      listExpr,
      columns,
      from,
      where,
      sort,
      groupBy,
      limit,
    };
  }

  private atClause(): boolean {
    const token = this.peek();
    return (
      token.kind === 'end' ||
      (token.kind === 'word' &&
        (CLAUSES.has(token.text.toUpperCase()) || REFUSED_CLAUSES.has(token.text.toUpperCase())))
    );
  }

  private column(allowLabel: boolean): DqlColumn {
    const start = this.peek().from;
    const expr = this.expr();
    const end = this.tokens[this.pos - 1]!.to;
    let label = this.source.slice(start, end).replace(/\s+/g, ' ').trim();
    if (allowLabel && this.isWord('AS')) {
      this.next();
      const name = this.next();
      if (name.kind !== 'string' && name.kind !== 'word') throw this.fail(name);
      label = name.value;
    }
    return { expr, label };
  }

  // FROM: `#tag`, `"pasta"`, `[[nota]]`, `and`/`or`, `-`/`!`/`not`, parênteses.
  private sourceOr(): DqlSource {
    let left = this.sourceAnd();
    while (this.isWord('OR')) {
      this.next();
      left = { kind: 'or', left, right: this.sourceAnd() };
    }
    return left;
  }

  private sourceAnd(): DqlSource {
    let left = this.sourceUnary();
    while (this.isWord('AND')) {
      this.next();
      left = { kind: 'and', left, right: this.sourceUnary() };
    }
    return left;
  }

  private sourceUnary(): DqlSource {
    if (this.isOp('-') || this.isOp('!') || this.isWord('NOT')) {
      this.next();
      return { kind: 'not', operand: this.sourceUnary() };
    }
    const token = this.next();
    if (token.kind === 'tag') return { kind: 'tag', tag: token.text };
    if (token.kind === 'string') return { kind: 'folder', path: token.value };
    if (token.kind === 'link') return { kind: 'link', target: token.value };
    if (token.kind === 'op' && token.text === '(') {
      const inner = this.sourceOr();
      this.expectOp(')');
      return inner;
    }
    if (token.kind === 'word' && REFUSED_CLAUSES.has(token.text.toUpperCase()))
      throw unsupported(token.text.toUpperCase(), token.line);
    if (token.kind === 'word' && this.isOp('('))
      throw unsupported(`${token.text}()`, token.line);
    throw this.fail(token);
  }

  // Expressões: `or` < `and` < `!` < comparação < primário.
  private expr(): DqlExpr {
    let left = this.andExpr();
    while (this.isWord('OR')) {
      this.next();
      left = { kind: 'or', left, right: this.andExpr() };
    }
    return left;
  }

  private andExpr(): DqlExpr {
    let left = this.notExpr();
    while (this.isWord('AND')) {
      this.next();
      left = { kind: 'and', left, right: this.notExpr() };
    }
    return left;
  }

  private notExpr(): DqlExpr {
    if (this.isOp('!')) {
      this.next();
      return { kind: 'not', operand: this.notExpr() };
    }
    return this.compare();
  }

  private compare(): DqlExpr {
    const left = this.primary();
    const token = this.peek();
    if (token.kind === 'op' && ['=', '!=', '<', '<=', '>', '>='].includes(token.text)) {
      this.next();
      return { kind: 'compare', op: token.text as CompareOp, left, right: this.primary() };
    }
    if (token.kind === 'op' && token.text === '-') throw unsupported('operador -', token.line);
    return left;
  }

  private primary(): DqlExpr {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'literal', value: token.value };
    if (token.kind === 'number') {
      if (!/^\d+(\.\d+)?$/.test(token.text)) throw this.fail(token);
      return { kind: 'literal', value: Number(token.text) };
    }
    if (token.kind === 'op' && token.text === '(') {
      const inner = this.expr();
      this.expectOp(')');
      return inner;
    }
    if (token.kind === 'link') throw unsupported(`[[${token.value}]] fora do FROM`, token.line);
    if (token.kind === 'tag') throw unsupported(`${token.text} fora do FROM`, token.line);
    if (token.kind !== 'word') throw this.fail(token);

    const lower = token.text.toLowerCase();
    if (this.isOp('(')) return this.call(token);
    if (lower === 'true' || lower === 'false') return { kind: 'literal', value: lower === 'true' };
    if (lower === 'null') return { kind: 'literal', value: null };
    if (CLAUSES.has(token.text.toUpperCase()) || REFUSED_CLAUSES.has(token.text.toUpperCase()))
      throw this.refuseWord(token);

    const path = [token.text];
    while (this.isOp('.')) {
      this.next();
      const part = this.next();
      if (part.kind !== 'word') throw this.fail(part);
      path.push(part.text);
    }
    if (path.length > 1 && path[0]!.toLowerCase() === 'file') {
      const field = path[1]!.toLowerCase();
      if (path.length > 2 || !(FILE_FIELDS as readonly string[]).includes(field))
        throw unsupported(path.join('.'), token.line);
      return { kind: 'field', path: ['file', field] };
    }
    if (path.length > 1) throw unsupported(path.join('.'), token.line);
    return { kind: 'field', path };
  }

  private call(name: Token): DqlExpr {
    const fn = name.text.toLowerCase();
    if (fn !== 'contains' && fn !== 'date') throw unsupported(`${name.text}()`, name.line);
    this.expectOp('(');
    if (fn === 'date') {
      const arg = this.next();
      const text = arg.kind === 'string' ? arg.value : arg.text;
      const lower = text.toLowerCase();
      let date: DateRef;
      if (lower === 'today') date = { offset: 0 };
      else if (lower === 'tomorrow') date = { offset: 1 };
      else if (lower === 'yesterday') date = { offset: -1 };
      else if (isIsoDate(text)) date = { date: text };
      else throw this.fail(arg);
      this.expectOp(')');
      return { kind: 'date', date };
    }
    const haystack = this.expr();
    this.expectOp(',');
    const needle = this.expr();
    this.expectOp(')');
    return { kind: 'contains', haystack, needle };
  }
}
