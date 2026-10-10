import { invoke } from '@tauri-apps/api/core';
import type { LanguageToolTransport } from '../types';

/**
 * LanguageTool local pelo Rust (r7 arch-backend §1.4, variante N): o webview nunca abre conexão
 * (`connect-src` inalterado). `lt_check` recebe o pedido tipado e o id; um novo `check` aborta o
 * anterior no Rust (`CANCELLED`). Erros chegam como `{ code, message, detail? }` do Rust, sem
 * tradução aqui (o plugin mapeia pelo código).
 */
export function createTauriLanguageTool(): LanguageToolTransport {
  return {
    languages: () => invoke<string>('lt_languages'),
    check: (req, requestId) => invoke<string>('lt_check', { requestId, req }),
    cancel: (requestId) => invoke<void>('lt_cancel', { requestId }),
  };
}
