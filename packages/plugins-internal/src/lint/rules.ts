/**
 * Regras do markdownlint 0.41.1 (arch-ux r7 §8.1, STR-164): descrição curta em pt-BR de cada regra
 * e a URL da documentação ("Saiba mais"). Os detalhes em inglês do upstream (`errorDetail`,
 * `errorContext`, `ruleDescription`) nunca aparecem (R-X7.12, OQ-R7-U4).
 */
export const MARKDOWNLINT_VERSION = '0.41.1';

export const RULE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  MD001: 'Os níveis de título devem subir de um em um.',
  MD003: 'Estilo de título inconsistente.',
  MD004: 'Estilo de marcador de lista inconsistente.',
  MD005: 'Indentação diferente entre itens do mesmo nível.',
  MD007: 'Indentação de lista não ordenada fora do padrão.',
  MD009: 'Espaços no fim da linha.',
  MD010: 'Caractere de tabulação no texto.',
  MD011: 'Link com a sintaxe invertida: (texto)[url].',
  MD012: 'Várias linhas em branco seguidas.',
  MD013: 'Linha longa demais.',
  MD014: 'Cifrão antes de comandos sem mostrar a saída.',
  MD018: 'Falta espaço depois do # do título.',
  MD019: 'Espaços demais depois do # do título.',
  MD020: 'Falta espaço dentro dos # do título fechado.',
  MD021: 'Espaços demais dentro dos # do título fechado.',
  MD022: 'Títulos devem ter uma linha em branco antes e depois.',
  MD023: 'O título deve começar no início da linha.',
  MD024: 'Vários títulos com o mesmo texto.',
  MD025: 'Mais de um título de primeiro nível na nota.',
  MD026: 'Pontuação no fim do título.',
  MD027: 'Espaços demais depois do > da citação.',
  MD028: 'Linha em branco dentro de uma citação.',
  MD029: 'Numeração de lista ordenada fora do padrão.',
  MD030: 'Espaçamento depois do marcador de lista fora do padrão.',
  MD031: 'Blocos de código cercados devem ter uma linha em branco antes e depois.',
  MD032: 'Listas devem ter uma linha em branco antes e depois.',
  MD033: 'HTML no meio do Markdown.',
  MD034: 'URL solta, sem < > nem link.',
  MD035: 'Estilo de linha horizontal inconsistente.',
  MD036: 'Ênfase usada no lugar de um título.',
  MD037: 'Espaços dentro dos marcadores de ênfase.',
  MD038: 'Espaços dentro do código em linha.',
  MD039: 'Espaços dentro do texto do link.',
  MD040: 'Bloco de código cercado sem a linguagem indicada.',
  MD041: 'A primeira linha deve ser um título de primeiro nível.',
  MD042: 'Link vazio.',
  MD043: 'Estrutura de títulos diferente da exigida.',
  MD044: 'Nome próprio com maiúsculas e minúsculas erradas.',
  MD045: 'Imagem sem texto alternativo.',
  MD046: 'Estilo de bloco de código inconsistente.',
  MD047: 'A nota deve terminar com uma única quebra de linha.',
  MD048: 'Estilo de cerca de código inconsistente.',
  MD049: 'Estilo de itálico inconsistente.',
  MD050: 'Estilo de negrito inconsistente.',
  MD051: 'Âncora de link (#…) que não existe na nota.',
  MD052: 'Link ou imagem de referência com rótulo não definido.',
  MD053: 'Definição de referência que nenhum link usa.',
  MD054: 'Estilo de link ou imagem não permitido.',
  MD055: 'Barras | no começo e no fim das linhas da tabela inconsistentes.',
  MD056: 'Número de células diferente do número de colunas.',
  MD058: 'Tabelas devem ter uma linha em branco antes e depois.',
  MD059: 'Texto de link pouco descritivo (ex.: “clique aqui”).',
  MD060: 'Alinhamento das colunas da tabela inconsistente.',
};

/** "Saiba mais": documentação da regra na versão fixada (formato do schema 0.41.1). */
export function ruleDocUrl(rule: string): string {
  return `https://github.com/DavidAnson/markdownlint/blob/v${MARKDOWNLINT_VERSION}/doc/${rule.toLowerCase()}.md`;
}

/**
 * Padrão do app (D-30 = JEV D-R7-P08): o padrão do markdownlint (todas ligadas) com MD013, MD033 e
 * MD041 desligadas. Um `.markdownlint.json(c)` da pasta SUBSTITUI este objeto.
 */
export const DEFAULT_LINT_CONFIG: Readonly<Record<string, unknown>> = {
  default: true,
  MD013: false,
  MD033: false,
  MD041: false,
};
