// Só o que a entrada usa (NFR-54): a política e o DOMPurify (`policy.ts`, `style.ts`,
// `sanitizer.ts`) chegam pelo `import()` de `load.ts`; um re-export daqui os traria de volta.
export { SanitizeCache, SANITIZE_CACHE_MAX } from './cache';
export { EMPTY_HTML_TEXT, hasVisibleContent, IMAGE_SOURCE_ATTR, INLINE_TAGS } from './fragment';
export { loadedHtmlSanitizer, loadHtmlSanitizer } from './load';
export type { HtmlSanitizer } from './sanitizer';
