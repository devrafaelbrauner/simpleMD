import type { Diagnostic } from '@codemirror/lint';
import type { EditorState, Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { problemDiagnostic } from '../shared/diagnostics-ui';
import type { LintConfig } from './config';
import { MarkdownlintError, type LintEngine } from './engine';
import { isExcluded } from './exclusions';
import { RULE_DESCRIPTIONS, ruleDocUrl } from './rules';
import type { LintFinding } from './worker';

/**
 * Fonte do `linter()` (arch-frontend r7 §10.2 `source.ts`): manda o texto da nota ativa ao motor,
 * converte linha/coluna em posições do documento DA RODADA, descarta o que fica inteiro dentro de
 * matemática/mermaid/calc (R-I5.1) e devolve diagnósticos da UI compartilhada — só "Saiba mais",
 * nunca "Corrigir" (R-I5.4). Memoriza por documento + versão da configuração: uma rodada disparada
 * por outra fonte (o LT) com o mesmo documento não reenvia nada. Resultado de pedido velho nunca
 * vence o mais novo.
 */
export interface LintSourceDeps {
  readonly engine: LintEngine;
  /** Configuração em uso (espera a 1ª leitura do arquivo da pasta). */
  config(): Promise<{ readonly config: LintConfig; readonly version: number }>;
  /** Padrão do app: a contraprova de que a culpa é da configuração da pasta. */
  readonly fallbackConfig: LintConfig;
  /**
   * O markdownlint lançou com esta configuração e passou com o padrão no mesmo texto: a culpa é da
   * configuração (o plugin volta ao padrão e avisa). Queda do worker, descarte, passada substituída
   * ou erro que o padrão repete nunca chegam aqui (CR-S5-03).
   */
  onConfigRejected(config: LintConfig): void;
  /** "Saiba mais" (`host.links.openExternal`). */
  openExternal(url: string): void;
}

/** Achados do markdownlint → diagnósticos no documento `doc` (o da rodada). */
export function toDiagnostics(
  state: EditorState,
  findings: readonly LintFinding[],
  openExternal: (url: string) => void,
): Diagnostic[] {
  const doc: Text = state.doc;
  const out: Diagnostic[] = [];
  /** O markdownlint repete achados iguais (MD022 "acima" e "abaixo"): uma linha só no painel. */
  const seen = new Set<string>();
  for (const finding of findings) {
    if (finding.line < 1 || finding.line > doc.lines) continue;
    const line = doc.line(finding.line);
    const from = finding.range
      ? Math.min(line.from + Math.max(0, finding.range[0] - 1), line.to)
      : line.from;
    const to = finding.range ? Math.min(from + Math.max(0, finding.range[1]), line.to) : line.to;
    if (isExcluded(state, from, to)) continue;
    const { rule, alias } = finding;
    const key = `${rule}:${from}:${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      problemDiagnostic(from, to, {
        source: 'lint',
        kind: 'lint',
        title: `${rule} · ${alias}`,
        label: `${rule} ${alias}`,
        body: RULE_DESCRIPTIONS[rule] ?? rule,
        actions: [
          {
            action: 'learn-more',
            label: 'Saiba mais',
            name: `Saiba mais sobre ${rule} (abre no navegador)`,
            group: 2,
            keepOpen: true,
            run: () => openExternal(ruleDocUrl(rule)),
          },
        ],
      }),
    );
  }
  return out;
}

/** A passada memorizada (documento + versão da configuração). */
interface Memo {
  readonly doc: Text;
  readonly version: number;
  result: Promise<Diagnostic[]>;
  /** Falhou sem culpa do texto nem da configuração (queda, descarte, substituída): repetir. */
  retry: boolean;
}

export function createLintSource(
  deps: LintSourceDeps,
): (view: EditorView) => Promise<Diagnostic[]> {
  let memo: Memo | null = null;

  return async (view) => {
    const state = view.state;
    const { config, version } = await deps.config();
    if (memo && !memo.retry && memo.doc === state.doc && memo.version === version)
      return memo.result;
    const entry: Memo = { doc: state.doc, version, result: Promise.resolve([]), retry: false };
    entry.result = (async () => {
      const text = state.doc.toString();
      try {
        return toDiagnostics(state, await deps.engine.run(text, config), deps.openExternal);
      } catch (error) {
        if (!(error instanceof MarkdownlintError)) {
          entry.retry = true;
          return [];
        }
        if (config === deps.fallbackConfig) return [];
        try {
          const findings = await deps.engine.run(text, deps.fallbackConfig);
          deps.onConfigRejected(config);
          return toDiagnostics(state, findings, deps.openExternal);
        } catch {
          return [];
        }
      }
    })();
    memo = entry;
    const diagnostics = await entry.result;
    // Uma rodada mais nova começou enquanto esta esperava: devolve a dela (nunca a velha).
    return memo === entry ? diagnostics : memo.result;
  };
}
