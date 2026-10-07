export { decodeDocument, encodeDocument, type TextFormat } from './codec';
export { ConflictError, VaultError, isVaultError, type VaultErrorCode } from './errors';
export { conflictCopyCandidate, createWithFreeName } from './free-name';
export { sha256Hex } from './hash';
export { isJsonObject, updateJsonFile, type JsonObject, type UpdateJsonResult } from './json-file';
export { toVaultPath } from './path';
export type { FsDirItem, FsKind, FsPort, FsStat, WriteMode } from './port';
export { LocalFsProvider, type LocalFsProviderOptions, type ReadLimit } from './provider';
export type {
  ContentBase,
  ContentVaultProvider,
  Entry,
  Unsubscribe,
  VaultHandle,
  VaultProvider,
  VaultWatchEvent,
} from './types';
