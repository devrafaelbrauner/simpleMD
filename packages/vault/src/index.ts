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
export type { FsDirItem, FsKind, FsPort, FsStat, WriteMode } from './port';
export { LocalFsProvider, type LocalFsProviderOptions, type ReadLimit } from './provider';
export type {
  ContentBase,
  ContentVaultProvider,
  Entry,
  NoteStat,
  Unsubscribe,
  VaultHandle,
  VaultImage,
  VaultProvider,
  VaultWatchEvent,
} from './types';
export {
  createVaultIndex,
  EXTRACTION_SLICE_MS,
  INDEX_LINKS_MAX,
  INDEX_MAX_BYTES,
  INDEX_PATH,
  INDEX_VERSION,
  type CatalogClock,
  type CatalogNoteMeta,
  type CatalogSnapshot,
  type CatalogStatus,
  type ExtractionJob,
  type IndexedLink,
  type IndexEntry,
  type NoteExtractor,
  type NoteIndexData,
  type TruncatedField,
  type VaultIndex,
  type VaultIndexDeps,
} from './catalog/index';
export { newNotePathForWikilink, type NewNoteNameError } from './note-name';
