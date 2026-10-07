import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * SHA-256 em hexadecimal minúsculo (arch-backend r2 §1.1, D-B1). Síncrono e em JS puro, então o
 * resultado é o mesmo no Node, no Chromium, no WKWebView e no WebView2; `crypto.subtle` não é usado
 * (é assíncrono e não foi verificado sob o esquema `tauri://localhost`). Base de escrita do vault,
 * hash dos plugins e índice usam esta mesma função.
 */
export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}
