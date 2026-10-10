/** Códigos de erro do vault (arch-backend §1.8; r7 §1.3: `UNSUPPORTED_IMAGE`). */
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
  | 'UNSUPPORTED_IMAGE'
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

/**
 * O arquivo mudou (ou sumiu) desde a última leitura/escrita do app. Nunca é resolvido
 * sobrescrevendo: a UI oferece "Manter ambos" ou "Recarregar do disco" (regra 6, D-3).
 */
export class ConflictError extends VaultError {
  readonly expectedMtime: number;
  readonly actualMtime: number | null;
  readonly reason: 'modified' | 'deleted';

  constructor(
    path: string,
    expectedMtime: number,
    actualMtime: number | null,
    reason: 'modified' | 'deleted',
  ) {
    super(
      'CONFLICT',
      reason === 'deleted'
        ? 'O arquivo foi removido fora do simpleMD.'
        : 'O arquivo foi alterado fora do simpleMD.',
      { path },
    );
    this.name = 'ConflictError';
    this.expectedMtime = expectedMtime;
    this.actualMtime = actualMtime;
    this.reason = reason;
  }
}

/** `true` se `error` é um `VaultError` (e, se `code` foi dado, com esse código). */
export function isVaultError(error: unknown, code?: VaultErrorCode): error is VaultError {
  return error instanceof VaultError && (code === undefined || error.code === code);
}
