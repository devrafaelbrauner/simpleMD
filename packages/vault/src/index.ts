export { decodeDocument, encodeDocument, type TextFormat } from './codec';
export { VAULT_CONFIG_FILES, isVaultConfigFile, type VaultConfigFile } from './config-files';
export { ConflictError, VaultError, isVaultError, type VaultErrorCode } from './errors';
export { conflictCopyCandidate, createWithFreeName } from './free-name';
export { sha256Hex } from './hash';
export {
  IMAGE_MAX_BYTES,
  IMAGE_MIME,
  imageKindOf,
  imageMaxBytes,
  sniffImage,
  type ImageKind,
} from './image-type';
export { isJsonObject, updateJsonFile, type JsonObject, type UpdateJsonResult } from './json-file';
export { toVaultPath } from './path';
export type {
  FsDirItem,
  FsKind,
  FsPort,
  FsSearchOptions,
  FsStat,
  TextSearchHit,
  TextSearchNote,
  TextSearchSkipped,
  TextSearchSummary,
  WriteMode,
} from './port';
export { LocalFsProvider, type LocalFsProviderOptions, type ReadLimit } from './provider';
export {
  checkSearchQuery,
  foldForSearch,
  searchNote,
  searchTree,
  SEARCH_HITS_PER_NOTE,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  SEARCH_NOTE_MAX_BYTES,
  SEARCH_QUERY_MAX,
  SEARCH_QUERY_MIN,
  SEARCH_TOTAL_MAX,
  type SearchRead,
  type SearchSource,
} from './search';
export type {
  ContentBase,
  ContentVaultProvider,
  Entry,
  NoteStat,
  TextSearchOptions,
  TextSearchResult,
  Unsubscribe,
  VaultHandle,
  VaultImage,
  VaultProvider,
  VaultWatchEvent,
} from './types';
export {
  createVaultIndex,
  EMPTY_INDEX_DATA,
  EXTRACTION_SLICE_MS,
  INDEX_ITAGS_MAX,
  INDEX_LINKS_MAX,
  INDEX_MAX_BYTES,
  INDEX_PATH,
  INDEX_PROP_KEY_MAX,
  INDEX_PROP_VALUE_BYTES,
  INDEX_PROPS_MAX,
  INDEX_TASK_RECURRENCE_MAX,
  INDEX_TASK_TEXT_MAX,
  INDEX_TASKS_MAX,
  INDEX_VERSION,
  propertiesFrom,
  serializeIndex,
  type CatalogClock,
  type CatalogNoteMeta,
  type CatalogSnapshot,
  type CatalogStatus,
  type ExtractionJob,
  type IndexedLink,
  type IndexedTask,
  type IndexEntry,
  type NoteExtractor,
  type NoteIndexData,
  type PropertyValue,
  type TaskDateField,
  type TruncatedField,
  type VaultIndex,
  type VaultIndexDeps,
} from './catalog/index';
export { newNotePathForWikilink, newNotePathInFolder, type NewNoteNameError } from './note-name';
