import { VaultError, isVaultError } from './errors';
import type { VaultHandle, VaultProvider } from './types';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Nome da cópia de conflito (R-2.10): `<pasta>/<nome> (conflito AAAA-MM-DD HH-mm-ss).md` para
 * `n = 1` e `… (conflito …) n.md` a partir de 2. Hora local; `-` no lugar de `:` (válido no Windows).
 */
export function conflictCopyCandidate(originalPath: string, at: Date, n: number): string {
  const slash = originalPath.lastIndexOf('/');
  const dir = slash === -1 ? '' : originalPath.slice(0, slash + 1);
  const file = originalPath.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : '.md';
  const stamp =
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`;
  return `${dir}${stem} (conflito ${stamp})${n > 1 ? ` ${n}` : ''}${ext}`;
}

/**
 * "Nunca sobrescrever, próximo nome livre" (arch-backend §1.5.5). Cada tentativa é uma escrita
 * só-criação: a colisão é detectada pelo próprio sistema de arquivos (`O_EXCL`/`create_new`), sem
 * janela entre checar e gravar. Continua apenas em `ALREADY_EXISTS`; qualquer outro erro sobe.
 */
export async function createWithFreeName(
  provider: VaultProvider,
  handle: VaultHandle,
  candidate: (n: number) => string,
  text: string,
  options: { max?: number } = {},
): Promise<{ path: string; mtime: number }> {
  const max = options.max ?? 100;
  for (let n = 1; n <= max; n++) {
    const path = candidate(n);
    try {
      const { mtime } = await provider.write(handle, path, text);
      return { path, mtime };
    } catch (error) {
      if (!isVaultError(error, 'ALREADY_EXISTS')) throw error;
    }
  }
  throw new VaultError('ALREADY_EXISTS', `Nenhum nome livre após ${max} tentativas.`, {
    path: candidate(1),
  });
}
