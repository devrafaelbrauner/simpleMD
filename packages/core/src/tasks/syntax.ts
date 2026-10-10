// Portado de silverbulletmd/silverbullet@70e58486e5e9d47dbfb13971e8576212896993c8 (MIT), © 2022 Zef Hemel. Modificado para o simpleMD.
// Origem: client/markdown_parser/extended_task.ts (MultiStatusTaskParser), que por sua vez adapta o
// TaskList de @lezer/markdown. Mudanças: um único caractere de estado (não vários), espaço ou tab
// obrigatório depois do `]` (regra do GFM), e os nós do GFM (`Task`, `TaskMarker`) em vez de
// `TaskState`/`TaskMark`, para a exportação, o live preview e o índice lerem a mesma árvore.
import type { BlockContext, LeafBlock, LeafBlockParser, MarkdownConfig } from '@lezer/markdown';

/** `[c]` no início do item seguido de espaço ou tab; `c` = qualquer caractere menos `]` e quebra. */
const TASK = /^\[[^\]\n]\][ \t]/;
/** Tamanho de `[c]`. */
const MARKER = 3;

class ExtendedTaskParser implements LeafBlockParser {
  nextLine(): boolean {
    return false;
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    cx.addLeafElement(
      leaf,
      cx.elt('Task', leaf.start, leaf.start + leaf.content.length, [
        cx.elt('TaskMarker', leaf.start, leaf.start + MARKER),
        ...cx.parser.parseInline(leaf.content.slice(MARKER), leaf.start + MARKER),
      ]),
    );
    return true;
  }
}

/**
 * Tarefas com qualquer estado de um caractere (R-I1.3, R-I9.2; arch-frontend §5.3, D-R7-S1-04):
 * `[ ]`, `[x]`, `[X]`, `[-]`, `[/]`, `[>]`… O `TaskList` do GFM (`@lezer/markdown` 1.7.2) só aceita
 * `[ xX]`; esta configuração o remove e põe no lugar um analisador com o MESMO nome e os mesmos nós.
 * Vale no editor (`markdownLanguageSupport`), na exportação e no índice.
 */
export const extendedTaskList: MarkdownConfig[] = [
  { remove: ['TaskList'] },
  {
    parseBlock: [
      {
        name: 'TaskList',
        leaf: (cx, leaf) =>
          TASK.test(leaf.content) && cx.parentType().name === 'ListItem'
            ? new ExtendedTaskParser()
            : null,
        after: 'SetextHeading',
      },
    ],
  },
];
