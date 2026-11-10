import type { MemorySnapshot } from '@simplemd/vault/testing';

/**
 * `&persist=1` do harness (r41i): o que volta na recarga e o que cabe no `sessionStorage`.
 *
 * - A pasta guardada leva o `?vault=` da página que a guardou (`from`). Recarregar a mesma URL (ou
 *   uma sem `?vault=`) a restaura; uma URL com outro `?vault=` abre a pasta pedida, mesmo com o
 *   `pagehide` da página anterior regravando a dela (RC-R32B-E2).
 * - Cada chave tem teto de {@link PERSIST_MAX_CHARS} caracteres; acima dele, ou se o navegador
 *   recusa pela cota, a chave sai (nada velho volta) e o relato fica em
 *   {@link PERSIST_SKIPPED_KEY}, que a próxima carga lê uma vez (R32A-DETALHES).
 */

/** Teto por chave, em caracteres (o Chromium conta 10 MiB em UTF-16 por origem, as chaves juntas). */
export const PERSIST_MAX_CHARS = 4 * 1024 * 1024;
/** Relato do que o último `pagehide` não guardou (lido e apagado pela carga seguinte). */
export const PERSIST_SKIPPED_KEY = 'simplemd:harness-persist-skipped';

export type PersistStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Uma chave que o `&persist=1` não guardou: `cap` = acima do teto; `quota` = o navegador recusou. */
export interface PersistSkip {
  readonly key: string;
  readonly chars: number;
  readonly reason: 'cap' | 'quota';
}

/** A pasta guardada: os bytes e o `?vault=` da página que a guardou. */
export interface PersistedVault {
  readonly from: string | null;
  readonly snapshot: MemorySnapshot;
}

/** Como a pasta começa: a guardada, a do `?vault=` ou nenhuma (boas-vindas). */
export type VaultStart<P extends string> =
  | { readonly kind: 'restore'; readonly from: string | null; readonly snapshot: MemorySnapshot }
  | { readonly kind: 'seed'; readonly preset: P }
  | { readonly kind: 'none' };

/**
 * `stored`: o valor da chave da pasta (`null` sem `&persist=1` ou sem nada guardado); `preset`: o
 * `?vault=` válido desta URL. Valor ilegível conta como nada guardado.
 */
export function vaultStart<P extends string>(
  stored: string | null,
  preset: P | null,
): VaultStart<P> {
  const saved = parseVault(stored);
  if (saved && (preset === null || saved.from === preset))
    return { kind: 'restore', from: saved.from, snapshot: saved.snapshot };
  return preset === null ? { kind: 'none' } : { kind: 'seed', preset };
}

function parseVault(stored: string | null): PersistedVault | null {
  if (stored === null) return null;
  try {
    const value = JSON.parse(stored) as Partial<PersistedVault> | null;
    const snapshot = value?.snapshot;
    if (
      (typeof value?.from !== 'string' && value?.from !== null) ||
      !Array.isArray(snapshot?.dirs) ||
      !Array.isArray(snapshot?.files)
    )
      return null;
    return { from: value.from, snapshot };
  } catch {
    return null;
  }
}

/**
 * Guarda `value` (JSON) em `key`. Acima de `maxChars` ou recusado pela cota: tira a chave, anota em
 * {@link PERSIST_SKIPPED_KEY} e devolve o relato; guardado, `null`.
 */
export function persistItem(
  storage: PersistStorage,
  key: string,
  value: unknown,
  maxChars = PERSIST_MAX_CHARS,
): PersistSkip | null {
  const json = JSON.stringify(value);
  let reason: PersistSkip['reason'] | null = json.length > maxChars ? 'cap' : null;
  if (reason === null) {
    try {
      storage.setItem(key, json);
      return null;
    } catch {
      reason = 'quota';
    }
  }
  storage.removeItem(key);
  const skip: PersistSkip = { key, chars: json.length, reason };
  try {
    storage.setItem(PERSIST_SKIPPED_KEY, JSON.stringify([...readSkipped(storage), skip]));
  } catch {
    // Sem espaço nem para o relato: a chave já saiu, e a próxima carga começa limpa.
  }
  return skip;
}

/** O relato do último `pagehide`, uma vez (a chave sai). */
export function takeSkipped(storage: PersistStorage): PersistSkip[] {
  const skipped = readSkipped(storage);
  storage.removeItem(PERSIST_SKIPPED_KEY);
  return skipped;
}

function readSkipped(storage: PersistStorage): PersistSkip[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(PERSIST_SKIPPED_KEY) ?? '[]');
    return Array.isArray(value) ? (value as PersistSkip[]) : [];
  } catch {
    return [];
  }
}
