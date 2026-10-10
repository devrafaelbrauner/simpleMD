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
  INDEX_MAX_BYTES,
  INDEX_PATH,
  type CatalogClock,
  type CatalogNoteMeta,
  type CatalogSnapshot,
  type CatalogStatus,
  type IndexEntry,
  type VaultIndex,
  type VaultIndexDeps,
} from './catalog/index';
