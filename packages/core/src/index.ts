export {
  EDITOR_KEY_BINDINGS,
  EditorHost,
  EMPTY_CONTRIBUTIONS,
  type CompletionRuntime,
  type EditorContributions,
} from './assembly/host';
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
