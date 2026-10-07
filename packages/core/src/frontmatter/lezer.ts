import { Parser, TreeFragment, type Input, type PartialParse } from '@lezer/common';
import type { BlockContext, Line, MarkdownConfig } from '@lezer/markdown';
import { detectFrontMatter, FRONT_MATTER_SEARCH_LIMIT } from './detect';

const OPENER = /^---[ \t]*$/;
/** Primeira leitura do início do documento; dobra até o teto de busca se o fechamento não couber. */
const FIRST_CHUNK = 16_384;

/**
 * Acesso ÚNICO e protegido ao `input` interno do `BlockContext` (arch-frontend r2 §3.4, C-R2-4): o
 * `@lezer/markdown@1.7.2` (versão fixada) não expõe leitura à frente. Sem a forma esperada devolve
 * `null`, o parser recusa e o teste de VT do front matter falha alto.
 */
export function readInput(cx: BlockContext): Input | null {
  if (!('input' in cx)) return null;
  const input = cx.input;
  if (typeof input !== 'object' || input === null) return null;
  if (!('read' in input) || typeof input.read !== 'function') return null;
  if (!('length' in input) || typeof input.length !== 'number') return null;
  // A forma conferida acima é a do `Input` do @lezer/common (read + length).
  const checked: Input = input as Input;
  return checked;
}

/** Fim do front matter que começa no offset 0 do documento, ou `null`. */
function frontMatterEnd(input: Input): number | null {
  const limit = Math.min(input.length, FRONT_MATTER_SEARCH_LIMIT + 1);
  for (let size = Math.min(FIRST_CHUNK, limit); ; size = Math.min(size * 2, limit)) {
    const found = detectFrontMatter(input.read(0, size));
    if (found) return found.to;
    if (size >= limit) return null;
  }
}

/**
 * Nó de bloco `FrontMatter` (R-9.1, FR-7): só no offset 0 e só com fechamento. Fica no topo da
 * árvore, visível a todo plugin pelo módulo do host `@codemirror/language` (contrato v1, Q-R2-1).
 * O texto do editor não tem BOM nem CRLF (fronteira do codec do r1), então offsets do editor são os
 * do detector.
 */
export const frontMatterSyntax: MarkdownConfig = {
  defineNodes: [{ name: 'FrontMatter', block: true }],
  parseBlock: [
    {
      name: 'FrontMatter',
      before: 'HorizontalRule',
      parse(cx: BlockContext, line: Line): boolean {
        if (cx.lineStart !== 0 || !OPENER.test(line.text)) return false;
        const input = readInput(cx);
        const to = input && frontMatterEnd(input);
        if (to === null || to === undefined) return false;
        while (cx.lineStart + line.text.length < to && cx.nextLine()) {
          // consome as linhas do bloco até a de fechamento
        }
        cx.nextLine();
        cx.addElement(cx.elt('FrontMatter', 0, to));
        return true;
      },
    },
  ],
};

/**
 * O nó do offset 0 depende do que vem MUITO depois dele (a linha de fechamento). O reuso
 * incremental do Lezer reaproveitaria o `---` do início como regra horizontal mesmo depois de o
 * usuário digitar o fechamento. Para documentos que começam com `---`, o fragmento reaproveitável
 * passa a começar em 1: o primeiro bloco é sempre reanalisado; o resto continua reaproveitado.
 */
export class FrontMatterAwareParser extends Parser {
  constructor(readonly inner: Parser) {
    super();
  }

  createParse(
    input: Input,
    fragments: readonly TreeFragment[],
    ranges: readonly { from: number; to: number }[],
  ): PartialParse {
    if (fragments.length > 0 && input.length >= 3 && input.read(0, 3) === '---') {
      fragments = fragments.flatMap((fragment) =>
        fragment.from > 0
          ? [fragment]
          : fragment.to > 1
            ? [
                new TreeFragment(
                  1,
                  fragment.to,
                  fragment.tree,
                  fragment.offset,
                  true,
                  fragment.openEnd,
                ),
              ]
            : [],
      );
    }
    return this.inner.createParse(input, fragments, ranges);
  }
}
