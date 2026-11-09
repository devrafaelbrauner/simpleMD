import {
  Compartment,
  Transaction,
  type EditorState,
  type Extension,
  type StateEffect,
} from '@codemirror/state';
import { EditorView, ViewPlugin, type DecorationSet } from '@codemirror/view';
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

/** Modo do editor de uma aba (r27, D-R27-01): `live` = live preview ligado; `source` = markdown cru. */
export type EditorMode = 'source' | 'live';

/**
 * Atributo de `.cm-editor` com o modo (r27): contrato com os plugins internos, que só importam os
 * módulos do host (`packages/plugins-internal/src/shared/reveal.ts` repete o nome).
 */
export const EDITOR_MODE_ATTRIBUTE = 'data-smd-mode';

/** Textos do r27: comando da paleta e anúncio da alternância. */
export const LIVE_PREVIEW_TEXT = {
  command: 'Editor: alternar live preview',
  announceLive: 'Live preview ligado.',
  announceSource: 'Live preview desligado: modo fonte.',
} as const;

const SOURCE_MODE: Extension = EditorView.editorAttributes.of({
  [EDITOR_MODE_ATTRIBUTE]: 'source',
});
const LIVE_MODE: Extension = EditorView.editorAttributes.of({ [EDITOR_MODE_ATTRIBUTE]: 'live' });

/**
 * Renderização num compartimento do próprio estado (r27, D-R27-01): o modo é da aba, não uma
 * contribuição do `EditorHost` (o `refresh` reaplica as contribuições a toda aba). Aparece uma vez
 * por estado, pela pilha de `createMarkdownExtensions`.
 */
const rendering = new Compartment();

function renderingFor(live: boolean): Extension {
  if (!live) return SOURCE_MODE;
  return [
    editorFocus(),
    inline.plugin,
    block.field,
    tableClickHandler,
    taskClickHandler,
    htmlInteract(),
    htmlSanitizerLoader,
    wikilinkIndexWatcher,
    codeBandLayer,
    LIVE_MODE,
  ];
}

/**
 * Live preview (R-3.1…R-3.5, I-1): decorações em linha só no viewport (`ViewPlugin`), blocos num
 * campo incremental (o CodeMirror proíbe blocos vindos de plugins), gestos e teclas dos links,
 * tarefas e "interagir". Nenhuma decoração altera o texto do documento (regra 1, R-I1.8).
 *
 * r27 (D-R27-04): gestos e teclas (⌘-clique, ⌥↩, ⌘L, ⌘⇧↩) e as definições de link valem nos dois
 * modos; só a renderização fica no compartimento (`on` = estado inicial; `setLivePreview` alterna).
 * Os gestos são `Prec.highest` e as teclas `Prec.high`: com a prévia ligada, a ordem efetiva das
 * extensões é a mesma de antes.
 */
export function livePreview(on = true): Extension {
  return [
    linkReferencesField,
    linkGesture(),
    linkKeymap(),
    taskKeymap(),
    interactKeymap(),
    rendering.of(renderingFor(on)),
  ];
}

/** O live preview está ligado neste estado (sem o compartimento, como num estado de outro host: sim). */
export function isLivePreview(state: EditorState): boolean {
  return rendering.get(state) !== SOURCE_MODE;
}

/**
 * Liga/desliga a renderização do estado (r27): um `reconfigure` do compartimento; 0 `EditorView` ou
 * `EditorState` novos, documento, seleção e histórico de desfazer intactos.
 */
export function setLivePreview(on: boolean): StateEffect<unknown> {
  return rendering.reconfigure(renderingFor(on));
}

/**
 * "Editor: alternar live preview" (r27): alterna o modo do estado mostrado e anuncia o novo pela
 * região viva do editor. Nunca entra no desfazer; devolve o modo novo.
 */
export function toggleLivePreviewAnnounced(view: EditorView): EditorMode {
  const live = !isLivePreview(view.state);
  view.dispatch({
    effects: [
      setLivePreview(live),
      EditorView.announce.of(
        live ? LIVE_PREVIEW_TEXT.announceLive : LIVE_PREVIEW_TEXT.announceSource,
      ),
    ],
    annotations: Transaction.addToHistory.of(false),
  });
  return live ? 'live' : 'source';
}

/**
 * Observa o modo do estado mostrado (barra de status do app): ao montar (view novo ou `setState`,
 * que recria os plugins) e quando o modo muda; nunca a cada transação.
 */
export function observeLivePreview(
  listener: (mode: EditorMode, state: EditorState) => void,
): Extension {
  const modeOf = (state: EditorState): EditorMode => (isLivePreview(state) ? 'live' : 'source');
  return ViewPlugin.define((view) => {
    listener(modeOf(view.state), view.state);
    return {
      update(update) {
        const mode = modeOf(update.state);
        if (modeOf(update.startState) !== mode) listener(mode, update.state);
      },
    };
  });
}

/** Ponto de entrada puro para testes (R-3.3, AC-I1.1): o que o editor desenharia nas faixas dadas. */
export function computeLivePreviewDecorations(
  state: EditorState,
  ranges: readonly VisibleRange[],
): { inline: DecorationSet; block: DecorationSet } {
  return { inline: inline.compute(state, ranges), block: block.compute(state) };
}
