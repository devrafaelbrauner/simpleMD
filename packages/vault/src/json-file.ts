import { isVaultError } from './errors';
import type { VaultHandle, VaultProvider } from './types';

export type JsonObject = Record<string, unknown>;

export type UpdateJsonResult =
  | { readonly status: 'written'; readonly mtime: number }
  /** O arquivo existe mas não é um objeto JSON legível: nada foi gravado (regra 1). */
  | { readonly status: 'malformed' };

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Ler-mesclar-gravar de um arquivo JSON do vault (arch-backend §1.6), base do `config.json`:
 * 1. lê o arquivo de novo (inexistente → `{}` e gravação só-criação, que também cria a pasta);
 * 2. ilegível, JSON malformado ou raiz que não é objeto → `malformed`, sem gravar nada;
 * 3. `mutate` altera só as chaves conhecidas: chaves desconhecidas e a ordem existente ficam;
 * 4. grava `JSON.stringify(obj, null, 2) + '\n'` com o `mtime` lido. Se outro programa gravou
 *    no meio (conflito ou o arquivo passou a existir), volta ao passo 1, no máximo `retries` vezes,
 *    então as chaves gravadas pelo outro nunca se perdem.
 */
export async function updateJsonFile(
  provider: VaultProvider,
  handle: VaultHandle,
  path: string,
  mutate: (obj: JsonObject) => void,
  options: { retries?: number } = {},
): Promise<UpdateJsonResult> {
  const retries = options.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    let obj: JsonObject = {};
    let expectedMtime: number | undefined;
    try {
      const { text, mtime } = await provider.read(handle, path);
      // Um BOM inicial não torna o JSON inválido (API-02); a regravação sai sem BOM (UTF-8 puro).
      const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (!isJsonObject(parsed)) return { status: 'malformed' };
      obj = parsed;
      expectedMtime = mtime;
    } catch (error) {
      if (error instanceof SyntaxError) return { status: 'malformed' };
      if (isVaultError(error, 'NOT_UTF8') || isVaultError(error, 'TOO_LARGE'))
        return { status: 'malformed' };
      if (!isVaultError(error, 'NOT_FOUND')) throw error;
    }
    mutate(obj);
    try {
      const { mtime } = await provider.write(
        handle,
        path,
        `${JSON.stringify(obj, null, 2)}\n`,
        expectedMtime,
      );
      return { status: 'written', mtime };
    } catch (error) {
      const raced = isVaultError(error, 'CONFLICT') || isVaultError(error, 'ALREADY_EXISTS');
      if (!raced || attempt >= retries) throw error;
    }
  }
}
