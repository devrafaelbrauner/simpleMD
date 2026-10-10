import type { ConfigFileRead } from '@simplemd/plugin-api/internal/host';
import { loadLintConfig, rulesInUseText, type LintConfigFile } from './config';

/**
 * Superfície leve do lint para o app e o harness (padrão `./*\/render`, sem o markdownlint):
 * o contador de passadas (`lintRuns` do `renderCounts()` do harness, C-R7-F07) e o texto da opção
 * "Regras em uso", carregado sob demanda pelo descritor.
 */
export const lintCounters = {
  /** Passadas do markdownlint de fato executadas (no worker ou no plano C). */
  runs: 0,
};

/** "Regras em uso" a partir da leitura da lista fechada do vault (`null` sem pasta aberta). */
export async function rulesInUse(
  readFile: (name: string) => Promise<ConfigFileRead | { readonly error: string } | null>,
): Promise<string> {
  const { origin } = await loadLintConfig(async (name: LintConfigFile) => {
    const file = await readFile(name);
    if (!file) return null;
    return 'text' in file ? file : { error: file.error === 'missing' ? 'missing' : 'read' };
  });
  return rulesInUseText(origin);
}
