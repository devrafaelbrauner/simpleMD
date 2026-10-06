/** Códigos de erro do vault (arch-backend §1.8). */
export type VaultErrorCode =
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'OUTSIDE_VAULT'
  | 'INVALID_PATH'
  | 'PERMISSION_DENIED'
  | 'NOT_UTF8'
  | 'TOO_LARGE'
  | 'CANCELLED'
  | 'IO';

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  readonly path?: string;

  constructor(code: VaultErrorCode, message: string, options?: { path?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'VaultError';
    this.code = code;
    if (options?.path !== undefined) this.path = options.path;
  }
}
