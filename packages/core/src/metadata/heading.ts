/**
 * Títulos ATX e setext do Lezer (nós `ATXHeading1-6`, `SetextHeading1-2`): nível e texto visível.
 * Usado pelo sumário (editor) e pela regra de título do índice, com a mesma árvore do editor.
 */
const ATX = /^ATXHeading([1-6])$/;
const SETEXT = /^SetextHeading([12])$/;

/** Blocos cujo conteúdo nunca tem títulos (código e front matter; R-9.5, R-9.3). */
export const NO_HEADING_BLOCKS: Readonly<Record<string, true>> = {
  FencedCode: true,
  CodeBlock: true,
  FrontMatter: true,
};

/** Nível (1–6) de um nó de título, ou `null` se o nó não é título. */
export function headingLevel(name: string): number | null {
  const match = ATX.exec(name) ?? SETEXT.exec(name);
  return match ? Number(match[1]) : null;
}

/**
 * Texto de um título a partir do trecho do nó: ATX sem os `#` de abertura e de fechamento; setext
 * sem a linha de sublinhado. Espaços internos colapsados.
 */
export function headingText(source: string, name: string): string {
  const text = SETEXT.test(name)
    ? source.slice(0, Math.max(0, source.lastIndexOf('\n')))
    : source.replace(/^ {0,3}#{1,6}(?=\s|$)/, '').replace(/\s#+\s*$/, '');
  return text.replace(/\s+/g, ' ').trim();
}
