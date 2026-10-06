import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightSpecialChars, keymap } from '@codemirror/view';
import { markdownKeymap } from './commands';
import { livePreview } from './live-preview';
import { markdownEditorTheme, markdownHighlightStyle } from './theme';

export interface MarkdownExtensionsOptions {
  /** Live preview (etapa 3). Ligado por padrão; `false` deixa só o modo fonte. */
  livePreview?: boolean;
  /** Editor somente leitura (prévia do editor de temas). */
  readOnly?: boolean;
  /** Nome acessível do `.cm-content` (`role="textbox"`); o axe exige um nome. */
  ariaLabel?: string;
}

const DEFAULT_ARIA_LABEL = 'Editor de markdown';

/**
 * Markdown com GFM: `markdownLanguage` já inclui tabelas, tachado e listas de tarefas, então os
 * nós `Table*` existem para o live preview. Sem `codeLanguages`: blocos cercados ficam como
 * `CodeText` simples (parse barato e nenhuma ênfase dentro de código).
 */
export function markdownLanguageSupport(): Extension {
  return markdown({ base: markdownLanguage });
}

/**
 * Pilha de extensões do editor (arch-frontend §2.2). A ordem importa para a precedência:
 * `markdownKeymap` tem `Prec.high` e por isso vence o `Mod-i` (`selectParentSyntax`) do
 * `defaultKeymap`. `indentWithTab` não é ligado: Tab sai do editor (sem armadilha de teclado).
 */
export function createMarkdownExtensions(opts: MarkdownExtensionsOptions = {}): Extension[] {
  const extensions: Extension[] = [
    markdownLanguageSupport(),
    history(),
    drawSelection(),
    EditorView.lineWrapping,
    highlightSpecialChars(),
    markdownKeymap,
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.contentAttributes.of({ 'aria-label': opts.ariaLabel ?? DEFAULT_ARIA_LABEL }),
  ];
  if (opts.readOnly) extensions.push(EditorState.readOnly.of(true));
  if (opts.livePreview ?? true) extensions.push(livePreview());
  extensions.push(markdownEditorTheme, syntaxHighlighting(markdownHighlightStyle));
  return extensions;
}

export function createMarkdownState(doc: string, opts?: MarkdownExtensionsOptions): EditorState {
  return EditorState.create({ doc, extensions: createMarkdownExtensions(opts) });
}
