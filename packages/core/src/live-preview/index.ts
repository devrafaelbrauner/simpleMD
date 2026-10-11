import type { EditorState, Extension } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { linkKeymap } from '../links/command';
import { linkGesture } from '../links/gesture';
import { taskKeymap } from '../tasks/semantics';
import { createBlockDriver, type BlockContributor } from './block';
import { blockquote } from './blockquote';
import { codeBandLayer } from './code-band';
import { codeBlock } from './code-block';
import type { InlineContributor, VisibleRange } from './context';
import { emphasis } from './emphasis';
import { editorFocus } from './focus';
import { frontMatter } from './front-matter';
import { headings } from './headings';
import { htmlBlock, htmlInline, htmlInteract, htmlSanitizerLoader } from './html';
import { blockImages, inlineImages } from './images/element';
import { createInlineDriver } from './inline';
import { inlineCode } from './inline-code';
import { interactKeymap } from './interact';
import { links } from './links';
import { lists } from './lists';
import { linkReferencesField } from './references';
import { strikethrough } from './strikethrough';
import { tableBlock, tableClickHandler, tableSource } from './table';
import { taskClickHandler, tasks } from './tasks';
import { wikilinkIndexWatcher, wikilinks } from './wikilinks';

export { liveCounters } from './counters';
export { editorFocusField, setEditorFocus } from './focus';
export { ImageBlobCache, IMAGE_CACHE_MAX_BYTES, type ImageBytes } from './images/cache';
export {
  imageSourceFacet,
  type ImageError,
  type ImageHandle,
  type ImageSource,
  type ImageState,
} from './images/source';
export { interactWithElement } from './interact';
export type { VisibleRange } from './context';
export { redecorate } from './context';

/**
 * Contribuidores em linha, na ordem do despacho (arch-frontend r7 §5.1). Ponto de registro:
 * S1 → S10 (`html.ts`) → S2 (`wikilinks.ts`), uma linha cada.
 */
const INLINE: readonly InlineContributor[] = [
  headings,
  emphasis,
  lists,
  codeBlock,
  frontMatter,
  tableSource,
  links,
  strikethrough,
  inlineCode,
  blockquote,
  tasks,
  inlineImages,
  htmlInline,
  wikilinks,
];

/** Contribuidores de bloco (filhos diretos do documento): tabela, imagem sozinha no parágrafo, HTML. */
const BLOCK: readonly BlockContributor[] = [tableBlock, blockImages, htmlBlock];

const inline = createInlineDriver(INLINE);
const block = createBlockDriver(BLOCK);

/** Decorações em linha das faixas dadas (função pura; R-3.3). */
export const computeInlineDecorations = inline.compute;
/** Decorações de bloco do estado inteiro (função pura). */
export const computeBlockDecorations = block.compute;

/**
 * Live preview (R-3.1…R-3.5, I-1): decorações em linha só no viewport (`ViewPlugin`), blocos num
 * campo incremental (o CodeMirror proíbe blocos vindos de plugins), gestos e teclas dos links,
 * tarefas e "interagir". Nenhuma decoração altera o texto do documento (regra 1, R-I1.8).
 */
export function livePreview(): Extension {
  return [
    editorFocus(),
    linkReferencesField,
    inline.plugin,
    block.field,
    tableClickHandler,
    taskClickHandler,
    linkGesture(),
    linkKeymap(),
    taskKeymap(),
    interactKeymap(),
    htmlInteract(),
    htmlSanitizerLoader,
    wikilinkIndexWatcher,
    codeBandLayer,
  ];
}

/** Ponto de entrada puro para testes (R-3.3, AC-I1.1): o que o editor desenharia nas faixas dadas. */
export function computeLivePreviewDecorations(
  state: EditorState,
  ranges: readonly VisibleRange[],
): { inline: DecorationSet; block: DecorationSet } {
  return { inline: inline.compute(state, ranges), block: block.compute(state) };
}
