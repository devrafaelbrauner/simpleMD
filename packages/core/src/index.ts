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
export { escapeHtml, safeUrl } from './export/escape';
export {
  collectExportImages,
  exportDocument,
  frontMatterLang,
  renderExportBody,
  type ExportBody,
  type ExportImage,
  type ExportImages,
  type ExportMode,
  type ExportRenderers,
  type ExportSanitizer,
  type ExportSegment,
  type ExportSpan,
} from './export/html';
export { stripFrontMatter } from './export/markdown';
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
export {
  createHtmlSanitizer,
  EMPTY_HTML_TEXT,
  sanitizeStyle,
  type HtmlSanitizer,
} from './sanitize';
// r7 S2 (I-2): wikilinks — sintaxe, resolução, extração para o índice, backlinks e o extrator.
export * from './wikilinks';
export type { ExportWikilinks } from './export/html';
export { createNoteExtractor, type NoteExtractor, type NoteIndexData } from './metadata/note';
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
