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
  isTabFocusToggleKey,
  onTabFocusChange,
  problemsCommandsFacet,
  resetTabFocus,
  runContextChain,
  runInteract,
  SPOKEN_TOGGLE,
  TAB_FOCUS_HOTKEY,
  TAB_FOCUS_TEXT,
  TAB_HELP_ID,
  tabFocusMode,
  tabModeDescription,
  toggleTabFocusAnnounced,
  type ContextAction,
  type ContextKind,
  type ContextSlot,
  type EscapeOwner,
  type InteractHandler,
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
  livePreview,
  setEditorFocus,
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
  exportDocument,
  frontMatterLang,
  renderExportBody,
  type ExportBody,
  type ExportMode,
  type ExportRenderers,
  type ExportSegment,
  type ExportSpan,
} from './export/html';
export { stripFrontMatter } from './export/markdown';
