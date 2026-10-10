import type { ConfigFileRead } from '@simplemd/plugin-api/internal/host';
import { validateUserSnippet, type RejectReason } from './catalog';
import type { Snippet } from './engine/snippets';
import { FILE_REGEX_COST_LIMIT } from './regex-cost';

/** Arquivo da lista fechada do backend para este plugin (≤ 256 KiB, só leitura; D-R7-B18). */
export const USER_SNIPPETS_FILE = '.simplemd/latex-snippets.json';

/** Resultado da leitura dos snippets desta pasta (R-I6.7). */
export interface UserSnippets {
  readonly snippets: readonly Snippet[];
  /** Entradas puladas (aviso "N snippets ignorados"). */
  readonly ignored: number;
  readonly reasons: readonly RejectReason[];
  /** Arquivo ausente (sem aviso). */
  readonly missing: boolean;
  /** O arquivo inteiro não pôde ser usado (aviso próprio). */
  readonly problem: 'json' | 'not-array' | 'too-large' | 'read' | null;
}

const EMPTY: UserSnippets = { snippets: [], ignored: 0, reasons: [], missing: true, problem: null };

/**
 * Valida o texto do arquivo: uma lista JSON; cada entrada inválida é pulada e contada. Orçamento
 * total do arquivo: a soma dos custos estáticos das regex aceitas fica em `FILE_REGEX_COST_LIMIT`;
 * a regex que passaria dele é ignorada (`regex-budget`). Nada mede tempo nem executa regex.
 */
export function parseUserSnippets(text: string): UserSnippets {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ...EMPTY, missing: false, problem: 'json' };
  }
  if (!Array.isArray(data)) return { ...EMPTY, missing: false, problem: 'not-array' };
  const snippets: Snippet[] = [];
  const reasons: RejectReason[] = [];
  let cost = 0;
  for (const entry of data) {
    const result = validateUserSnippet(entry);
    if ('reason' in result) reasons.push(result.reason);
    else if (cost + result.cost > FILE_REGEX_COST_LIMIT) reasons.push('regex-budget');
    else {
      cost += result.cost;
      snippets.push(result.snippet);
    }
  }
  return { snippets, ignored: reasons.length, reasons, missing: false, problem: null };
}

/** Resultado do leitor da lista fechada → snippets do usuário. */
export function userSnippetsFrom(read: ConfigFileRead | null): UserSnippets {
  if (read === null || 'error' in read) {
    if (read === null || read.error === 'missing') return EMPTY;
    return { ...EMPTY, missing: false, problem: read.error };
  }
  return parseUserSnippets(read.text);
}

/** Aviso (warn) das entradas puladas — STR-173. */
export function ignoredNotice(count: number): string {
  return count === 1
    ? `1 snippet ignorado em ${USER_SNIPPETS_FILE}.`
    : `${count} snippets ignorados em ${USER_SNIPPETS_FILE}.`;
}

/** Aviso (warn) quando o arquivo inteiro não serve. */
export function problemNotice(problem: NonNullable<UserSnippets['problem']>): string {
  if (problem === 'too-large') return `${USER_SNIPPETS_FILE} passa de 256 KB e foi ignorado.`;
  if (problem === 'read') return `Não foi possível ler ${USER_SNIPPETS_FILE}.`;
  return `${USER_SNIPPETS_FILE} não é uma lista JSON de snippets e foi ignorado.`;
}

/** Texto "Snippets desta pasta" das opções do plugin (arch-ux §4: info). */
export function userSnippetsInfo(result: UserSnippets): string {
  if (result.missing) return `Nenhum arquivo ${USER_SNIPPETS_FILE}`;
  if (result.problem) return problemNotice(result.problem);
  const n = result.snippets.length;
  const base = `${n} ${n === 1 ? 'snippet' : 'snippets'} de ${USER_SNIPPETS_FILE}`;
  return result.ignored > 0
    ? `${base} · ${result.ignored} ${result.ignored === 1 ? 'ignorado' : 'ignorados'}`
    : base;
}
