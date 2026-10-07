import { isVaultError } from './errors';
import type { ContentBase, ContentVaultProvider, VaultHandle, VaultProvider } from './types';

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
 * 4. grava `JSON.stringify(obj, null, 2) + '\n'` só se o disco ainda tem o texto lido no passo 1
 *    (base de conteúdo, RR-03; um provider só com a interface §4.3 recebe o `mtime` lido). Se outro
 *    programa gravou no meio (conflito ou o arquivo passou a existir), volta ao passo 1, no máximo
 *    `retries` vezes, então as chaves gravadas pelo outro nunca se perdem.
 *
 * Sempre reserializa: espaços, quebras e um BOM inicial do arquivo original não são preservados
 * (QR-04; diferente dos `.md`, que mantêm BOM e finais de linha, R-2.5).
 */
export async function updateJsonFile(
  provider: VaultProvider | ContentVaultProvider,
  handle: VaultHandle,
  path: string,
  mutate: (obj: JsonObject) => void,
  options: { retries?: number } = {},
): Promise<UpdateJsonResult> {
  const retries = options.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    let obj: JsonObject = {};
    let base: ContentBase | undefined;
    try {
      const { text, mtime } = await provider.read(handle, path);
      // Um BOM inicial não torna o JSON inválido (API-02); a regravação sai sem BOM (UTF-8 puro).
      const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (!isJsonObject(parsed)) return { status: 'malformed' };
      obj = parsed;
      base = { text, mtime };
    } catch (error) {
      if (error instanceof SyntaxError) return { status: 'malformed' };
      if (isVaultError(error, 'NOT_UTF8') || isVaultError(error, 'TOO_LARGE'))
        return { status: 'malformed' };
      if (!isVaultError(error, 'NOT_FOUND')) throw error;
    }
    mutate(obj);
    const next = `${JSON.stringify(obj, null, 2)}\n`;
    try {
      const { mtime } =
        base !== undefined && 'writeIfUnchanged' in provider
          ? await provider.writeIfUnchanged(handle, path, next, base)
          : await provider.write(handle, path, next, base?.mtime);
      return { status: 'written', mtime };
    } catch (error) {
      const raced = isVaultError(error, 'CONFLICT') || isVaultError(error, 'ALREADY_EXISTS');
      if (!raced || attempt >= retries) throw error;
    }
  }
}
