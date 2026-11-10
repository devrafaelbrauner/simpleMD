import { invoke } from '@tauri-apps/api/core';
import type { SpellError, SpellErrorCode, SpellReloaded, SpellTransport } from '../types';

/**
 * Mensagem do app por código. O `TIMEOUT` do Rust traz a do LanguageTool ("O servidor não respondeu
 * a tempo.", D-R34-9): a do corretor sai daqui, pelo código.
 */
const MESSAGES: Readonly<Record<SpellErrorCode, string>> = {
  UNSUPPORTED_LANG: 'Idioma sem dicionário no corretor.',
  TOO_MANY_WORDS: 'Palavras demais num só pedido ao corretor.',
  CANCELLED: 'Um pedido mais novo ao corretor substituiu este.',
  TIMEOUT: 'O corretor demorou demais; tente de novo.',
  SPELL_UNAVAILABLE: 'O dicionário pt-BR do corretor não carregou.',
  NO_VAULT: 'Nenhuma pasta aberta.',
  VAULT_CLOSED: 'A pasta foi fechada.',
  IO: 'Falha no corretor.',
};

/** O número `key` do `detail` do Rust, se for finito. */
function detailNumber(detail: unknown, key: 'max' | 'seconds'): number | null {
  if (typeof detail !== 'object' || detail === null || !(key in detail)) return null;
  const value: unknown = (detail as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Erro do Rust (`{ code, message, detail? }`) → `SpellError`: o código da lista (outro, ou rejeição
 * sem código, → `IO`), a mensagem do app e só o `detail` que o código usa (`max`, `seconds`).
 */
export function toSpellError(error: unknown): SpellError {
  const raw: object = typeof error === 'object' && error !== null ? error : {};
  const given = 'code' in raw ? raw.code : undefined;
  const code: SpellErrorCode =
    typeof given === 'string' && Object.hasOwn(MESSAGES, given) ? (given as SpellErrorCode) : 'IO';
  const detail = 'detail' in raw ? raw.detail : undefined;
  const max = code === 'TOO_MANY_WORDS' ? detailNumber(detail, 'max') : null;
  const seconds = code === 'TIMEOUT' ? detailNumber(detail, 'seconds') : null;
  return {
    code,
    message: MESSAGES[code],
    ...(max !== null ? { detail: { max } } : {}),
    ...(seconds !== null ? { detail: { seconds } } : {}),
  };
}

/**
 * Corretor offline pelo Rust (r34; r35a): `spell_check { lang, words }`, `spell_suggest { lang,
 * word }` e `spell_reload { token? }`, sem tradução dos argumentos. O token da pasta aberta
 * (`token()`, o do `TauriFsPort`) vai só com pasta; sem ela a recarga é só da camada global. Toda
 * rejeição sai como `SpellError` (`toSpellError`).
 */
export function createTauriSpell(token: () => number | null): SpellTransport {
  const call = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>(command, args);
    } catch (error) {
      throw toSpellError(error);
    }
  };
  return {
    check: (lang, words) => call<number[]>('spell_check', { lang, words }),
    suggest: (lang, word) => call<string[]>('spell_suggest', { lang, word }),
    reload: () => {
      const open = token();
      return call<SpellReloaded>('spell_reload', open === null ? {} : { token: open });
    },
  };
}
