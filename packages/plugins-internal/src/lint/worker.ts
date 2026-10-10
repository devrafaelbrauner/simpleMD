import { lint } from 'markdownlint/sync';

/**
 * Motor do lint (D-R7-F05, arch-frontend r7 §10.2 `worker.ts`): o markdownlint roda num Web Worker
 * de módulo (plano B: worker clássico; plano C: este mesmo `lintMarkdown` na thread principal em
 * tempo ocioso — Q-R7-F04, D-R7-S5-02). Mensagem `{ seq, text, config }` →
 * `{ seq, results }` ou `{ seq, error }`. Só diagnóstico: o resultado nunca carrega correções
 * (`fixInfo` não sai daqui; R-I5.4). `customRules` nunca é passado; o front matter fica com a
 * opção padrão do markdownlint.
 */
export interface LintFinding {
  /** `MD009`. */
  readonly rule: string;
  /** `no-trailing-spaces`. */
  readonly alias: string;
  /** Linha (1-based). */
  readonly line: number;
  /** `[coluna 1-based, comprimento]`, ou `null` = a linha inteira. */
  readonly range: readonly [number, number] | null;
}

export interface LintRequest {
  readonly seq: number;
  readonly text: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export type LintReply =
  | { readonly type: 'ready' }
  | { readonly type: 'result'; readonly seq: number; readonly results: readonly LintFinding[] }
  | { readonly type: 'error'; readonly seq: number; readonly error: string };

/** Uma passada do markdownlint sobre o texto da nota (função pura). */
export function lintMarkdown(text: string, config: Readonly<Record<string, unknown>>): LintFinding[] {
  // A configuração já foi validada em `config.ts` (topo objeto; valores booleano/severidade/objeto).
  const markdownlintConfig = config as Record<string, never>;
  const results = lint({ strings: { note: text }, config: markdownlintConfig });
  return (results.note ?? []).map((error) => {
    const [column, length] = error.errorRange ?? [];
    return {
      rule: error.ruleNames[0] ?? '',
      alias: error.ruleNames[1] ?? error.ruleNames[0] ?? '',
      line: error.lineNumber,
      range: column !== undefined && length !== undefined ? [column, length] : null,
    };
  });
}

interface WorkerScope {
  postMessage(message: LintReply): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<LintRequest>) => void): void;
}

/** Só dentro de um worker (o mesmo arquivo também serve o plano C na thread principal). */
const scope = globalThis as unknown as WorkerScope & { WorkerGlobalScope?: abstract new () => unknown };
if (typeof scope.WorkerGlobalScope === 'function' && scope instanceof scope.WorkerGlobalScope) {
  scope.addEventListener('message', ({ data }) => {
    try {
      scope.postMessage({ type: 'result', seq: data.seq, results: lintMarkdown(data.text, data.config) });
    } catch (error) {
      scope.postMessage({ type: 'error', seq: data.seq, error: String(error) });
    }
  });
  scope.postMessage({ type: 'ready' });
}
