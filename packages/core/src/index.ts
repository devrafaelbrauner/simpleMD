import type * as NoteIndexer from './metadata/indexer';
import type * as TaskCompletion from './tasks/complete';

export {
  EDITOR_KEY_BINDINGS,
  EditorHost,
  EMPTY_CONTRIBUTIONS,
  type CompletionRuntime,
  type EditorContributions,
  type HostStateOptions,
} from './assembly/host';
export { noteContext, type NoteContext } from './assembly/note-context';
export { appPlatformFacet, type EditorPlatform } from './assembly/platform';
export {
  captureTabExtension,
  contextAction,
  contextActionFacet,
  contextChainKeymap,
  coreContextActions,
  escapeArbiter,
  escapeHandler,
  escapeHandlerFacet,
  interactFacet,
  internalCommandsFacet,
  isTabFocusToggleKey,
  problemsCommandsFacet,
  resetTabFocus,
  runContextChain,
  runInteract,
  SPOKEN_TOGGLE,
  TAB_FOCUS_HOTKEY,
  TAB_FOCUS_TEXT,
  TAB_HELP_ID,
  tabFocusObserver,
  tabFocusMode,
  tabModeDescription,
  toggleTabFocusAnnounced,
  type ContextAction,
  type ContextKind,
  type ContextSlot,
  type EscapeOwner,
  type InteractHandler,
  type InternalCommand,
  type ProblemsCommands,
  type TabMode,
} from './keys';
export {
  createMarkdownExtensions,
  createMarkdownState,
  markdownLanguageSupport,
  type MarkdownExtensionsOptions,
} from './markdown';
export { insertLink, markdownKeymap, toggleBold, toggleItalic } from './commands';
export {
  detectFrontMatter,
  FRONT_MATTER_MAX_CONTENT,
  FRONT_MATTER_SEARCH_LIMIT,
  type FrontMatterRange,
} from './frontmatter/detect';
export {
  computeBlockDecorations,
  computeInlineDecorations,
  computeLivePreviewDecorations,
  IMAGE_CACHE_MAX_BYTES,
  ImageBlobCache,
  imageSourceFacet,
  interactWithElement,
  liveCounters,
  livePreview,
  setEditorFocus,
  type ImageBytes,
  type ImageError,
  type ImageHandle,
  type ImageSource,
  type ImageState,
  type VisibleRange,
} from './live-preview';
export { markdownEditorTheme, markdownHighlightStyle } from './theme';
export {
  extractNoteMeta,
  fileTitle,
  firstHeading1,
  NOTE_TITLE_MAX,
  type NoteMeta,
} from './metadata/note';
export {
  compactValue,
  PROPERTY_DISPLAY_MAX,
  readNoteProperties,
  type NoteProperties,
  type PropertyRow,
} from './metadata/properties';
export {
  FRONT_MATTER_WARNINGS,
  isValidDateText,
  MAX_ALIAS_COUNT,
  normalizeTags,
  parseFrontMatterYaml,
  validateFrontMatter,
  type FrontMatterProperty,
  type FrontMatterResult,
} from './metadata/yaml';
export { computeToc, type TocEntry } from './toc';
export {
  clampMinChars,
  DEFAULT_AUTOCOMPLETE,
  normalizeAutocomplete,
  SNIPPET_PREFIXES,
  type AutocompleteField,
  type AutocompleteMode,
  type AutocompleteSettings,
  type SnippetPrefix,
} from './autocomplete/settings';
export {
  appCompletionSources,
  documentWords,
  isoDay,
  noteLinkTarget,
  SNIPPETS,
  wordIndexField,
  type AppCompletionDeps,
  type NoteRef,
} from './autocomplete/sources';
// Exportação: as funções saem por `@simplemd/core/export` (pedaços sob demanda, NFR-54); aqui só tipos.
export type {
  ExportBody,
  ExportImage,
  ExportImages,
  ExportMode,
  ExportRenderers,
  ExportSanitizer,
  ExportSegment,
  ExportSpan,
} from './export/html';
export {
  classifyHref,
  linkAccessibleName,
  linkAt,
  linkOpenerFacet,
  openLinkAtCursor,
  resolveVaultPath,
  targetLabel,
  visibleText,
  urlRefusal,
  urlRefusalLabel,
  validateUrl,
  type LinkInfo,
  type LinkOpener,
  type LinkTarget,
  type UrlRefusal,
} from './links';
export {
  isTaskDone,
  nextTaskStatus,
  simpleTaskSemantics,
  taskToggleFacet,
  toggleTaskCommand,
  type TaskRef,
  type TaskSemantics,
  type TaskToggleResult,
} from './tasks/semantics';
export { extendedTaskList } from './tasks/syntax';
// r7 S10 (I-10): o sanitizador do HTML cru (DOMPurify e a política) é um pedaço sob demanda
// (NFR-54); a exportação espera `loadHtmlSanitizer()` antes de renderizar.
export { EMPTY_HTML_TEXT, loadHtmlSanitizer, type HtmlSanitizer } from './sanitize';
// r7 S2 (I-2): wikilinks — sintaxe, resolução, extração para o índice, backlinks e o extrator.
export * from './wikilinks';
export type { ExportWikilinks } from './export/html';
// r7 S9 (I-9): o extrator do índice v3 (tarefas, propriedades, tags do corpo e o título pela mesma
// árvore, NFR-47) é um pedaço sob demanda; a entrada guarda só `extractNoteMeta` (NFR-54, S9a B1).
export type {
  IndexPropertyValue,
  NoteExtractionJob,
  NoteExtractor,
  NoteIndexData,
} from './metadata/indexer';
export type NoteIndexerModule = typeof NoteIndexer;
/** Carrega o extrator do índice v3 (o catálogo do app, antes de começar o índice da pasta). */
export function loadNoteIndexer(): Promise<NoteIndexerModule> {
  return import('./metadata/indexer');
}
export { redecorate } from './live-preview';
// r7 S3 (I-3): comandos "Tabela: …", aviso STR-155 e carga do motor. A extensão entra só pela
// cadeia (`keys/index.ts`); registrá-la de novo dobraria o slot e o keymap (CR-S3-09).
export {
  loadTableEngine,
  runTableCommand,
  TABLE_COMMANDS,
  TABLE_TEXT,
  tableNoticeFacet,
  type TableCommandId,
  type TableCommandSpec,
} from './tables';
// r7 S9 (I-9): o parser de linha de tarefa, as datas e a conclusão de R-I9.7 (`complete.ts` +
// `recurrence.ts`) ficam em pedaços sob demanda, fora do chunk de entrada (NFR-54); o catálogo de
// tarefas do app os recebe pelo módulo da conclusão.
export type { ParsedTask, TaskDateField, TaskPriority } from './tasks/line';
export type {
  LineEdit,
  TaskCompletionOptions,
  TaskCompletionSemanticsOptions,
  TaskLineToggle,
} from './tasks/complete';
export type TaskCompletionModule = typeof TaskCompletion;
/** Carrega a conclusão de I-9 (só o registro do `simplemd.tasks` a usa, dentro do `load`). */
export function loadTaskCompletion(): Promise<TaskCompletionModule> {
  return import('./tasks/complete');
}
