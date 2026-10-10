import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { Language, LanguageSupport, syntaxHighlighting } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightSpecialChars, keymap } from '@codemirror/view';
import { markdownKeymap } from './commands';
import { FrontMatterAwareParser, frontMatterSyntax } from './frontmatter/lezer';
import { contextChainKeymap, coreContextActions } from './keys';
import { livePreview } from './live-preview';
import { markdownEditorTheme, markdownHighlightStyle } from './theme';

export interface MarkdownExtensionsOptions {
  /** Live preview (etapa 3). Ligado por padrão; `false` deixa só o modo fonte. */
  livePreview?: boolean;
  /** Editor somente leitura (prévia do editor de temas). */
  readOnly?: boolean;
  /** Nome acessível do `.cm-content` (`role="textbox"`); o axe exige um nome. */
  ariaLabel?: string;
  /**
   * O conteúdo é uma parada da tecla Tab (padrão). `false` só para a prévia do editor de temas, cuja
   * região já é a parada de Tab (arch-ux §5.2); o editor ainda recebe foco por clique.
   */
  tabStop?: boolean;
}

const DEFAULT_ARIA_LABEL = 'Editor de markdown';

/**
 * Markdown com GFM: `markdownLanguage` já inclui tabelas, tachado e listas de tarefas, então os
 * nós `Table*` existem para o live preview. Sem `codeLanguages`: blocos cercados ficam como
 * `CodeText` simples (parse barato e nenhuma ênfase dentro de código). O nó de bloco `FrontMatter`
 * (etapa 7, FR-7) entra pela configuração do parser; o parser é embrulhado para o reuso incremental
 * nunca reaproveitar o primeiro bloco de um documento que começa com `---` (arch-frontend r2 §3.4).
 */
export function markdownLanguageSupport(): Extension {
  const support = markdown({ base: markdownLanguage, extensions: [frontMatterSyntax] });
  const language = new Language(
    support.language.data,
    new FrontMatterAwareParser(support.language.parser),
    [],
    'markdown',
  );
  return new LanguageSupport(language, support.support);
}

/**
 * Pilha de extensões do editor (arch-frontend §2.2). A ordem importa para a precedência:
 * `markdownKeymap` tem `Prec.high` e por isso vence o `Mod-i` (`selectParentSyntax`) do
 * `defaultKeymap`. `indentWithTab` não é ligado: Tab sai do editor (sem armadilha de teclado); a
 * Tab pela cadeia só existe no compartimento `#hostKeys` do `EditorHost` com a chave ligada. A
 * Classe B da cadeia (`Mod-]`/`Mod-[`, `Mod-Alt-→/←`; r7 arch-ux §6.4) vale sempre.
 */
export function createMarkdownExtensions(opts: MarkdownExtensionsOptions = {}): Extension[] {
  const extensions: Extension[] = [
    markdownLanguageSupport(),
    history(),
    drawSelection(),
    EditorView.lineWrapping,
    highlightSpecialChars(),
    contextChainKeymap,
    coreContextActions,
    markdownKeymap,
    keymap.of([...defaultKeymap, ...historyKeymap]),
    // `tabindex` explícito: o `.cm-scroller` (tabindex -1 do CodeMirror) passa a ter um descendente
    // focável no modelo do axe (`scrollable-region-focusable`, A-7). O `contenteditable` já era
    // alcançado por Tab, então nenhuma parada nova aparece (a11y F-1).
    EditorView.contentAttributes.of({
      'aria-label': opts.ariaLabel ?? DEFAULT_ARIA_LABEL,
      tabindex: opts.tabStop === false ? '-1' : '0',
    }),
    // Nome pt-BR da lista de sugestões do CodeMirror (axe `aria-input-field-name`; STR-90).
    EditorState.phrases.of({ Completions: 'Sugestões' }),
  ];
  if (opts.readOnly) extensions.push(EditorState.readOnly.of(true));
  if (opts.livePreview ?? true) extensions.push(livePreview());
  extensions.push(markdownEditorTheme, syntaxHighlighting(markdownHighlightStyle));
  return extensions;
}

export function createMarkdownState(doc: string, opts?: MarkdownExtensionsOptions): EditorState {
  return EditorState.create({ doc, extensions: createMarkdownExtensions(opts) });
}
