/**
 * Mensagens do `@replit/codemirror-vim-core` 0.1.0 em pt-BR (STR-161, UX-R7-D22, R-X7.12). As
 * conhecidas são traduzidas; as demais ficam no original, marcadas como inglês (`lang="en"`,
 * WCAG 3.1.2), para o leitor de tela pronunciar certo.
 */
export type VimMessage =
  | { readonly lang: 'pt-BR'; readonly text: string }
  | { readonly lang: 'en'; readonly text: string };

/** Sufixo que a busca acrescenta ao "nada encontrado" com a opção `pcre` ligada. */
const PCRE_HINT = / \(set nopcre to use vim regexps\)$/i;

/** A busca relata a consulta como `RegExp` (`/zzz/im`): o usuário digitou só `zzz`. */
const REGEX_LITERAL = /^\/([\s\S]*)\/[a-z]*$/;

const RULES: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
  [/^Invalid regex: ([\s\S]*)$/, (m) => `Expressão regular inválida: ${m[1]}`],
  [/^No word under cursor$/, () => 'Nenhuma palavra sob o cursor.'],
  [
    /^No match(?:es for| found) ([\s\S]*)$/,
    (m) => `Nada encontrado: ${m[1]!.replace(REGEX_LITERAL, '$1')}`,
  ],
  [
    /^(\d+) lines yanked(?: into "(.))?$/,
    (m) => `${m[1]} linhas copiadas${m[2] === undefined ? '' : ` para o registrador ${m[2]}`}.`,
  ],
  [/^Not an editor command ":([\s\S]*)"$/, (m) => `Comando não reconhecido: “:${m[1]}”`],
  [/^Invalid mapping: ([\s\S]*)$/, (m) => `Mapeamento inválido: ${m[1]}`],
  [/^No such mapping: ([\s\S]*)$/, (m) => `Mapeamento inexistente: ${m[1]}`],
  [/^Argument (?:is )?required\.?$/, () => 'Falta um argumento.'],
  [/^Regular Expression missing from global$/, () => 'Falta a expressão regular em :global.'],
  [/^Substitutions should be of the form /, () => 'Use a forma :s/padrão/troca/.'],
  [/^No previous substitute regular expression$/, () => 'Nenhuma substituição anterior.'],
  [/^Invalid argument: ([\s\S]*)$/, (m) => `Argumento inválido: ${m[1]}`],
];

/** Texto de uma mensagem do Vim → pt-BR (STR-161) ou o original marcado como inglês. */
export function translateVimMessage(original: string): VimMessage {
  const text = original.replace(PCRE_HINT, '');
  for (const [pattern, render] of RULES) {
    const match = pattern.exec(text);
    if (match) return { lang: 'pt-BR', text: render(match) };
  }
  return { lang: 'en', text: original };
}
