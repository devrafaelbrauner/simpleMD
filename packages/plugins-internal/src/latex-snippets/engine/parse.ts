// Portado de artisticat1/obsidian-latex-suite@5db51cf36abccdbbfa51184bb5fe86be8157cc2f (MIT), © 2022 artisticat1. Modificado para o simpleMD.
// Origem: src/snippets/parse.ts (`parseSnippet`, `insertSnippetVariables`, `getExcludedEnvironments`).
// Mudanças: entradas SÓ DADOS (R-I6.7; sem `import()` de `data:` nem valibot): o gatilho regex é
// texto + opção `r` (e `flags` opcionais), nunca um `RegExp` vindo de código; a substituição é
// sempre texto; `${NOME}` é trocado em todas as ocorrências (o upstream trocava só a primeira); a
// flag `m` não é aceita (o `$` do fim tem de ser o fim da janela, CR-S6-07).
import { EXCLUSIONS, type Environment } from './environment';
import { Options } from './options';
import {
  RegexSnippet,
  StringSnippet,
  VISUAL_SNIPPET_MAGIC_SELECTION_PLACEHOLDER,
  VisualSnippet,
  type Snippet,
} from './snippets';

/** Uma entrada já validada: gatilho, substituição (texto), opções, flags, prioridade e descrição. */
export interface RawSnippet {
  readonly trigger: string;
  readonly replacement: string;
  readonly options: string;
  readonly flags?: string;
  readonly priority?: number;
  readonly description?: string;
}

export type SnippetVariables = Readonly<Record<string, string>>;

/**
 * Flags de regex aceitas: as do upstream sem `v` (o WebKit do macOS 13 não tem) e sem `m` (com ela
 * o `$` casaria no fim de uma linha anterior e a expansão apagaria texto além do gatilho).
 */
export const REGEX_FLAGS = 'isu';

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
 * no fim (`$`) e compilada aqui, uma vez (só compila: nada executa a regex); `${VISUAL}` na
 * substituição torna o snippet visual.
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
    // Regex do usuário é o requisito (R-I6.2 `r`, R-I6.7). Só compila; antes do 1º `exec`, o
    // `validateUserSnippet` recusa o source expandido longo demais ou de custo estático alto
    // (`regex-cost.ts`: altura de estrela > 1 e caminhos de backtracking) e a regex só roda contra
    // os 100 caracteres antes do cursor (ReDoS mitigado; AC-I6.5).
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    return new RegexSnippet({ ...common, trigger: new RegExp(`${trigger}$`, flags) });
  }
  if (raw.replacement.includes(VISUAL_SNIPPET_MAGIC_SELECTION_PLACEHOLDER)) {
    options.visual = true;
    return new VisualSnippet({ ...common, trigger });
  }
  if (options.visual) return new VisualSnippet({ ...common, trigger });
  return new StringSnippet({ ...common, trigger });
}
