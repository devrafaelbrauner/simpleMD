import { invoke } from '@tauri-apps/api/core';
import type { LanguageToolTransport } from '../types';

/** O Rust recebe `request_id: u32`; fora disso o Tauri rejeitaria com texto puro, sem `code` (F-08). */
const MAX_REQUEST_ID = 2 ** 32 - 1;

/**
 * LanguageTool local pelo Rust (r7 arch-backend §1.4, variante N): o webview nunca abre conexão
 * (`connect-src` inalterado). `lt_check` recebe o pedido tipado e o id; um novo `check` aborta o
 * anterior no Rust (`CANCELLED`). Erros chegam como `{ code, message, detail? }` do Rust, sem
 * tradução aqui (o plugin mapeia pelo código); um id fora de `[0, 2³²)` é recusado aqui com o
 * mesmo formato (`LT_INVALID_REQUEST`), antes do IPC.
 */
export function createTauriLanguageTool(): LanguageToolTransport {
  const checkId = (requestId: number) => {
    if (!Number.isInteger(requestId) || requestId < 0 || requestId > MAX_REQUEST_ID)
      throw { code: 'LT_INVALID_REQUEST', message: 'Pedido de verificação inválido.' };
  };
  return {
    languages: () => invoke<string>('lt_languages'),
    async check(req, requestId) {
      checkId(requestId);
      return invoke<string>('lt_check', { requestId, req });
    },
    async cancel(requestId) {
      checkId(requestId);
      return invoke<void>('lt_cancel', { requestId });
    },
  };
}
