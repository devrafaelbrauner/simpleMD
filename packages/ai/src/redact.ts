/**
 * Redação de chaves (R-11.5, AC-11.7), espelho de `src-tauri/src/ai/redact.rs`: `sk-ant-…`,
 * `sk-…` (letras, dígitos, `_`, `-`) e `Bearer <token>` viram `[chave redigida]`, cada um só no
 * começo de uma "palavra" (o caractere anterior não é letra, dígito, `_` nem `-`). Aplicada de novo
 * no TS a toda mensagem de erro, mesmo já redigida no Rust.
 */
export const REDACTED = '[chave redigida]';

const isTokenChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_-]/.test(c);

function matchAt(text: string, i: number): number {
  if (text.startsWith('sk-', i)) {
    let end = i + 3;
    while (end < text.length && isTokenChar(text[end])) end++;
    return end > i + 3 ? end - i : 0;
  }
  if (text.slice(i, i + 6).toLowerCase() !== 'bearer') return 0;
  let end = i + 6;
  const spaceStart = end;
  while (end < text.length && /\s/.test(text[end] ?? '')) end++;
  if (end === spaceStart) return 0;
  const tokenStart = end;
  while (end < text.length && !/\s/.test(text[end] ?? '')) end++;
  return end > tokenStart ? end - i : 0;
}

export function redact(text: string): string {
  let out = '';
  let prev: string | undefined;
  let i = 0;
  while (i < text.length) {
    if (!isTokenChar(prev)) {
      const length = matchAt(text, i);
      if (length > 0) {
        out += REDACTED;
        i += length;
        prev = ']';
        continue;
      }
    }
    prev = text[i];
    out += prev;
    i++;
  }
  return out;
}
