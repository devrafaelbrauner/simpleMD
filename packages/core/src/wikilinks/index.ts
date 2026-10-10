export {
  BacklinkIndex,
  type BacklinkGroup,
  type BacklinkOccurrence,
  type Backlinks,
  type LinkSource,
  type SourceLink,
} from './backlinks';
export {
  editorText,
  extractLinks,
  linkParser,
  NOTE_LINKS_MAX,
  startLinkExtraction,
  type ExtractedLink,
  type LinkExtraction,
  type LinkExtractionJob,
} from './extract';
export { resolveInEditor, wikilinkIndexFacet, type WikilinkIndex } from './facet';
export {
  readWikilink,
  WIKILINK_HEADING_SEPARATOR,
  wikilinkLabel,
  type WikilinkInfo,
} from './parse';
export {
  createNoteNameIndex,
  normalizeWikiTarget,
  resolveNotePath,
  resolveWikilink,
  WIKILINK_OTHERS_SHOWN,
  wikilinkCreatePath,
  type NoteNameIndex,
  type WikilinkResolution,
} from './resolve';
export { splitWikilink, WIKILINK_MAX_CHARS, WIKILINK_NODES, wikiLinkSyntax } from './syntax';
