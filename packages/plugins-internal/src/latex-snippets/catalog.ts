import defaultSnippetData from './data/default-snippets.json';
import defaultVariableData from './data/default-snippet-variables.json';
import { OPTION_LETTERS } from './engine/options';
import {
  compileSnippet,
  REGEX_FLAGS,
  type RawSnippet,
  type SnippetVariables,
} from './engine/parse';
import type { Snippet } from './engine/snippets';
import { sortSnippets } from './engine/sort';
import { regexCost, REGEX_COST_LIMIT } from './regex-cost';

/**
 * Catálogo de snippets (r7 I-6): entradas SÓ DADOS (R-I6.7) — gatilho, substituição (sempre
 * texto, nunca função), opções, prioridade e descrição —, compiladas uma vez pelo porte de
 * `parseSnippet` (`engine/parse.ts`), ordenadas como no upstream e indexadas pelo último caractere
 * do gatilho (NFR-56: casamento ≤ 2 ms por tecla com 500 snippets do usuário). Nada aqui avalia
 * código: 0 `eval`/`Function` (AC-I6.5).
 */

/** O gatilho é testado só contra os 100 caracteres antes do cursor (R-I6.7). */
export const SNIPPET_WINDOW = 100;
/** Gatilho do usuário (texto ou regex) com no máximo 200 caracteres (R-I6.7). */
export const MAX_TRIGGER_LENGTH = 200;
/** Regex do usuário depois das variáveis (`${GREEK}`… crescem o source): no máximo 1024. */
export const MAX_REGEX_SOURCE_LENGTH = 1024;

export const DEFAULT_VARIABLES: SnippetVariables = defaultVariableData;

/** Caracteres especiais da regex no fim do padrão (sem caractere literal garantido). */
const REGEX_SPECIAL = '^$.|?*+()[]{}\\';

/**
 * O caractere com que todo texto casado termina, ou `null` (vale para qualquer tecla): o literal
 * do fim do gatilho; para regex, o último átomo se ele for um literal (`a`, `\.`) e o padrão não
 * tiver alternância nem `i`.
 */
export function triggerTail(snippet: Snippet): string | null {
  if (typeof snippet.trigger === 'string') return snippet.trigger.slice(-1) || null;
  const { source, flags } = snippet.trigger;
  const body = source.slice(0, -1); // sem o `$` acrescentado
  if (flags.includes('i') || body.includes('|') || body.length === 0) return null;
  const last = body.slice(-1);
  let slashes = 0;
  for (let i = body.length - 2; i >= 0 && body.charAt(i) === '\\'; i--) slashes++;
  if (slashes % 2 === 1) return /[A-Za-z0-9]/.test(last) ? null : last;
  return REGEX_SPECIAL.includes(last) ? null : last;
}

/** Snippets ordenados + índice pelo último caractere (candidatos na ordem de prioridade). */
export class SnippetCatalog {
  readonly all: readonly Snippet[];
  readonly #byTail = new Map<string, Snippet[]>();
  readonly #anyTail: Snippet[] = [];
  readonly #rank = new Map<Snippet, number>();
  readonly #merged = new Map<string, readonly Snippet[]>();

  constructor(snippets: readonly Snippet[]) {
    this.all = sortSnippets(snippets);
    this.all.forEach((snippet, rank) => {
      this.#rank.set(snippet, rank);
      const tail = triggerTail(snippet);
      if (tail === null) this.#anyTail.push(snippet);
      else {
        const list = this.#byTail.get(tail) ?? [];
        list.push(snippet);
        this.#byTail.set(tail, list);
      }
    });
  }

  /** Snippets que podem casar com um texto terminado em `last`, na ordem do catálogo. */
  candidates(last: string): readonly Snippet[] {
    const cached = this.#merged.get(last);
    if (cached) return cached;
    const own = this.#byTail.get(last) ?? [];
    const merged = [...own, ...this.#anyTail].sort(
      (a, b) => (this.#rank.get(a) ?? 0) - (this.#rank.get(b) ?? 0),
    );
    this.#merged.set(last, merged);
    return merged;
  }
}

let defaults: readonly Snippet[] | null = null;

/**
 * Conjunto padrão = `default_snippets.js` do latex-suite 1.9.8 convertido para dados
 * (`data/default-snippets.json`; `iden(\d)` → `iden1`…`iden6`, Q-R7-F07), compilado uma vez.
 */
export function defaultSnippets(): readonly Snippet[] {
  defaults ??= (defaultSnippetData as RawSnippet[]).map((raw) =>
    compileSnippet(raw, DEFAULT_VARIABLES),
  );
  return defaults;
}

/** Por que uma entrada do usuário foi recusada (só para os testes e a documentação). */
export type RejectReason =
  'shape' | 'trigger' | 'options' | 'flags' | 'regex-length' | 'regex-invalid' | 'regex-budget';

/** Entrada aceita (com o custo estático da regex, 0 para texto) ou o motivo da recusa. */
export type UserSnippetResult =
  { readonly snippet: Snippet; readonly cost: number } | { readonly reason: RejectReason };

/**
 * Valida uma entrada do `.simplemd/latex-snippets.json` (R-I6.7): só dados; `options` só com as
 * letras `A r m t M n v w` (`c` e letras desconhecidas recusadas, JEV D-R7-S6-04); flags só
 * `i s u`; regex com até 200 caracteres, compilada SEMPRE com `u` (sem os escapes do Anexo B, que
 * o custo estático não modela: `\u{1,}`, `\k<…>` viram `regex-invalid`, CR-S6-10) e, DEPOIS das
 * variáveis, com até 1024 caracteres e custo estático dentro de `REGEX_COST_LIMIT`
 * (`regex-cost.ts`, com as flags compiladas). Nada executa a regex nem mede tempo: a recusa vem
 * antes de qualquer `exec`.
 */
export function validateUserSnippet(
  entry: unknown,
  variables: SnippetVariables = DEFAULT_VARIABLES,
): UserSnippetResult {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
    return { reason: 'shape' };
  const e = entry as Record<string, unknown>;
  if (
    typeof e.replacement !== 'string' ||
    typeof e.options !== 'string' ||
    (e.priority !== undefined &&
      (typeof e.priority !== 'number' || !Number.isFinite(e.priority))) ||
    (e.description !== undefined && typeof e.description !== 'string')
  )
    return { reason: 'shape' };
  if (typeof e.trigger !== 'string' || e.trigger.length === 0) return { reason: 'trigger' };
  if ([...e.options].some((letter) => !OPTION_LETTERS.includes(letter)))
    return { reason: 'options' };
  if (
    e.flags !== undefined &&
    (typeof e.flags !== 'string' || [...e.flags].some((f) => !REGEX_FLAGS.includes(f)))
  )
    return { reason: 'flags' };
  const regex = e.options.includes('r');
  if (e.trigger.length > MAX_TRIGGER_LENGTH) return { reason: regex ? 'regex-length' : 'trigger' };
  const raw: RawSnippet = {
    trigger: e.trigger,
    replacement: e.replacement,
    options: e.options,
    ...(regex ? { flags: `${typeof e.flags === 'string' ? e.flags : ''}u` } : {}),
    ...(typeof e.priority === 'number' ? { priority: e.priority } : {}),
    ...(typeof e.description === 'string' ? { description: e.description } : {}),
  };
  if (!regex) return { snippet: compileSnippet(raw, variables), cost: 0 };
  let snippet: Snippet;
  try {
    snippet = compileSnippet(raw, variables);
  } catch {
    return { reason: 'regex-invalid' };
  }
  // O source compilado = o gatilho já com as variáveis, mais o `$` do fim (CR-S6-05).
  const { source: compiled, flags } = snippet.trigger as RegExp;
  const source = compiled.slice(0, -1);
  if (source.length > MAX_REGEX_SOURCE_LENGTH) return { reason: 'regex-length' };
  const cost = regexCost(source, flags);
  return cost <= REGEX_COST_LIMIT ? { snippet, cost } : { reason: 'regex-budget' };
}
