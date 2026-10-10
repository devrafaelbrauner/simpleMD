import defaultSnippetData from './data/default-snippets.json';
import defaultVariableData from './data/default-snippet-variables.json';
import { EXCLUSIONS, type Environment } from './engine/environment';
import { OPTION_LETTERS, Options } from './engine/options';
import {
  RegexSnippet,
  StringSnippet,
  VISUAL_SNIPPET_MAGIC_SELECTION_PLACEHOLDER,
  VisualSnippet,
  type Snippet,
} from './engine/snippets';
import { sortSnippets } from './engine/sort';

/**
 * Catálogo de snippets (r7 I-6; reescrito do `src/snippets/parse.ts` do latex-suite, que usava
 * `import()` de `data:` + valibot): entradas SÓ DADOS (R-I6.7) — gatilho, substituição (sempre
 * texto, nunca função), opções, prioridade e descrição —, compiladas uma vez, ordenadas como no
 * upstream e indexadas pelo último caractere do gatilho (NFR-56: casamento ≤ 2 ms por tecla com
 * 500 snippets do usuário). Nada aqui avalia código: 0 `eval`/`Function` (AC-I6.5).
 */
export interface RawSnippet {
  readonly trigger: string;
  readonly replacement: string;
  readonly options: string;
  readonly flags?: string;
  readonly priority?: number;
  readonly description?: string;
}

/** O gatilho é testado só contra os 100 caracteres antes do cursor (R-I6.7). */
export const SNIPPET_WINDOW = 100;
/** Gatilho do usuário (texto ou regex) com no máximo 200 caracteres (R-I6.7). */
export const MAX_TRIGGER_LENGTH = 200;
/** Flags de regex aceitas (as do upstream sem `v`, que o WebKit do macOS 13 não tem). */
const REGEX_FLAGS = 'imsu';

export type SnippetVariables = Readonly<Record<string, string>>;

export const DEFAULT_VARIABLES: SnippetVariables = defaultVariableData;

/** Troca `${NOME}` pelo valor (todas as ocorrências; o upstream trocava só a primeira). */
function insertSnippetVariables(trigger: string, variables: SnippetVariables): string {
  let out = trigger;
  for (const [name, value] of Object.entries(variables)) out = out.split(name).join(value);
  return out;
}

function excludedEnvironments(trigger: string): Environment[] {
  const env = Object.hasOwn(EXCLUSIONS, trigger) ? EXCLUSIONS[trigger] : undefined;
  return env ? [env] : [];
}

/**
 * Compila uma entrada já validada (porte de `parseSnippet`): variáveis no gatilho, regex ancorada
 * no fim (`$`) e compilada aqui, uma vez; `${VISUAL}` na substituição torna o snippet visual.
 */
export function compileSnippet(raw: RawSnippet, variables: SnippetVariables): Snippet {
  const options = Options.fromSource(raw.options);
  const trigger = insertSnippetVariables(raw.trigger, variables);
  const common = {
    replacement: raw.replacement,
    options,
    priority: raw.priority,
    description: raw.description,
    excludedEnvironments: excludedEnvironments(trigger),
  };
  if (options.regex) {
    const flags = [...new Set(raw.flags ?? '')].filter((f) => REGEX_FLAGS.includes(f)).join('');
    return new RegexSnippet({ ...common, trigger: new RegExp(`${trigger}$`, flags) });
  }
  if (raw.replacement.includes(VISUAL_SNIPPET_MAGIC_SELECTION_PLACEHOLDER)) {
    options.visual = true;
    return new VisualSnippet({ ...common, trigger });
  }
  if (options.visual) return new VisualSnippet({ ...common, trigger });
  return new StringSnippet({ ...common, trigger });
}

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
  | 'shape'
  | 'trigger'
  | 'options'
  | 'flags'
  | 'regex-length'
  | 'regex-invalid'
  | 'regex-budget';

/**
 * Valida uma entrada do `.simplemd/latex-snippets.json` (R-I6.7): só dados; `options` só com as
 * letras `A r m t M n v w` (`c` e letras desconhecidas recusadas, JEV D-R7-S6-04); regex com até
 * 200 caracteres, compilável e dentro do orçamento de NFR-56 (`regexWithinBudget`).
 */
export function validateUserSnippet(
  entry: unknown,
  variables: SnippetVariables = DEFAULT_VARIABLES,
): { readonly snippet: Snippet } | { readonly reason: RejectReason } {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return { reason: 'shape' };
  const e = entry as Record<string, unknown>;
  if (
    typeof e.replacement !== 'string' ||
    typeof e.options !== 'string' ||
    (e.priority !== undefined && (typeof e.priority !== 'number' || !Number.isFinite(e.priority))) ||
    (e.description !== undefined && typeof e.description !== 'string')
  )
    return { reason: 'shape' };
  if (typeof e.trigger !== 'string' || e.trigger.length === 0) return { reason: 'trigger' };
  if ([...e.options].some((letter) => !OPTION_LETTERS.includes(letter))) return { reason: 'options' };
  if (e.flags !== undefined && (typeof e.flags !== 'string' || [...e.flags].some((f) => !REGEX_FLAGS.includes(f))))
    return { reason: 'flags' };
  const regex = e.options.includes('r');
  if (e.trigger.length > MAX_TRIGGER_LENGTH) return { reason: regex ? 'regex-length' : 'trigger' };
  const raw: RawSnippet = {
    trigger: e.trigger,
    replacement: e.replacement,
    options: e.options,
    ...(typeof e.flags === 'string' ? { flags: e.flags } : {}),
    ...(typeof e.priority === 'number' ? { priority: e.priority } : {}),
    ...(typeof e.description === 'string' ? { description: e.description } : {}),
  };
  if (!regex) return { snippet: compileSnippet(raw, variables) };
  if (hasNestedQuantifier(e.trigger)) return { reason: 'regex-budget' };
  let snippet: Snippet;
  try {
    snippet = compileSnippet(raw, variables);
  } catch {
    return { reason: 'regex-invalid' };
  }
  return regexWithinBudget(snippet.trigger as RegExp) ? { snippet } : { reason: 'regex-budget' };
}

/**
 * Grupo quantificado (`*`, `+`, `{n,}`, `{n,m}` com m > 1) que contém outro quantificador ou uma
 * alternância: a forma clássica de backtracking exponencial (`(a+)+`, `(a|ab)*`). Recusado sem
 * executar (um laço síncrono de regex não pode ser interrompido).
 */
export function hasNestedQuantifier(source: string): boolean {
  const stack: boolean[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source.charAt(i);
    if (ch === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === '(') stack.push(false);
    else if (ch === '|' && stack.length > 0) stack[stack.length - 1] = true;
    else if (ch === '*' || ch === '+' || (ch === '{' && /^\{\d+,\d*\}/.test(source.slice(i)))) {
      if (stack.length > 0) stack[stack.length - 1] = true;
    } else if (ch === ')') {
      const risky = stack.pop() ?? false;
      const next = source.slice(i + 1);
      const repeated = /^(?:[*+]|\{\d*,\d*\}|\{\d*[2-9]\d*\})/.test(next);
      if (risky && repeated) return true;
      // O grupo quantificado conta como quantificador para o grupo de fora.
      if ((risky || repeated) && stack.length > 0) stack[stack.length - 1] = true;
    }
  }
  return false;
}

/** Orçamento por regex do usuário em textos de prova de até 100 caracteres (NFR-56). */
const REGEX_BUDGET_MS = 1;
const PROBE_LENGTHS = [5, 10, 20, 40, 70, SNIPPET_WINDOW];

/**
 * Prova a regex contra textos crescentes (até a janela de 100 caracteres) feitos dos literais do
 * próprio padrão, que casam muito e falham no fim; para no primeiro tamanho que estoura o
 * orçamento, então o custo da prova fica limitado.
 */
export function regexWithinBudget(regex: RegExp): boolean {
  const chars = [...new Set(regex.source.replace(/[\\^$.|?*+()[\]{}]/g, '') + 'a1 \\{')].slice(0, 8);
  const probe = (length: number) => {
    const started = performance.now();
    for (const ch of chars) regex.exec(`${ch.repeat(length)}\u0000`);
    return performance.now() - started;
  };
  probe(1); // compilação da regex (JIT) fora da medida
  for (const length of PROBE_LENGTHS) {
    // Uma medida acima do orçamento é repetida (GC/JIT); só a segunda decide.
    if (probe(length) > REGEX_BUDGET_MS && probe(length) > REGEX_BUDGET_MS) return false;
  }
  return true;
}
