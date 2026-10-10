/**
 * Tipos de imagem do vault (r7 arch-backend §1.3; R-I1.7, D-32): 5 tipos, reconhecidos pela
 * extensão e confirmados pelos bytes mágicos — extensão e bytes precisam concordar (um `.png` com
 * bytes JPEG, HTML ou SVG é recusado). Mesma tabela do Rust (`vault/image.rs`); a paridade é
 * provada pela fixture `test/fixtures/image-magic-cases.json`, lida pelos dois lados.
 */
export type ImageKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'svg';

export const IMAGE_MIME: Readonly<Record<ImageKind, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/** Tetos de leitura (NFR-45): raster 20 MiB, SVG 2 MiB. */
export const IMAGE_MAX_BYTES = { raster: 20 * 1024 * 1024, svg: 2 * 1024 * 1024 } as const;

/** Janela em que o `<svg` precisa aparecer. */
export const SVG_SNIFF_BYTES = 4096;

const EXTENSIONS: Readonly<Record<string, ImageKind>> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
  svg: 'svg',
};

/**
 * Tipo pela extensão do último segmento (sem caixa); qualquer outra → `null`. `Object.hasOwn`:
 * `x.constructor`/`x.__proto__` não podem casar com chaves do protótipo (F-01).
 */
export function imageKindOf(path: string): ImageKind | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(EXTENSIONS, ext) ? (EXTENSIONS[ext] ?? null) : null;
}

export function imageMaxBytes(kind: ImageKind): number {
  return kind === 'svg' ? IMAGE_MAX_BYTES.svg : IMAGE_MAX_BYTES.raster;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  if (bytes.length < at + prefix.length) return false;
  return prefix.every((b, i) => bytes[at + i] === b);
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87 = ascii('GIF87a');
const GIF89 = ascii('GIF89a');
const RIFF = ascii('RIFF');
const WEBP = ascii('WEBP');
const BOM = [0xef, 0xbb, 0xbf];
const LT = 0x3c;

/** Bytes → minúsculas ASCII (só A-Z muda), como `to_ascii_lowercase` do Rust. */
function lowerAscii(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b >= 0x41 && b <= 0x5a ? b + 0x20 : b);
  return out;
}

/**
 * SVG: depois do BOM UTF-8 opcional e de espaços ASCII, o 1º byte é `<`; os primeiros 4.096 bytes
 * (em minúsculas ASCII) contêm `<svg`; o texto não começa por `<!doctype html` nem `<html`. UTF-16 e
 * gzip (`svgz`) caem fora pelas mesmas regras. É CONFERÊNCIA DE TIPO, não sanitização (SN-SEC-05):
 * um SVG com `<script>` passa. A fronteira é o uso: a URL `blob:` só vai em `<img src>` (scripts
 * não rodam), nunca em `<a href>`, `window.open`, `<object>`, `<embed>`, `<iframe>` ou `<use>`.
 */
function sniffSvg(bytes: Uint8Array): boolean {
  const window = lowerAscii(bytes.subarray(0, SVG_SNIFF_BYTES));
  let start = startsWith(bytes, BOM) ? BOM.length : 0;
  while (start < window.length && ' \t\n\r\f'.includes(window[start] ?? '')) start++;
  const body = window.slice(start);
  return (
    body.charCodeAt(0) === LT &&
    !body.startsWith('<!doctype html') &&
    !body.startsWith('<html') &&
    window.includes('<svg')
  );
}

/** Os bytes são do tipo `kind`? (tabela do §1.3). */
export function sniffImage(kind: ImageKind, bytes: Uint8Array): boolean {
  switch (kind) {
    case 'png':
      return startsWith(bytes, PNG);
    case 'jpeg':
      return startsWith(bytes, JPEG);
    case 'gif':
      return startsWith(bytes, GIF87) || startsWith(bytes, GIF89);
    case 'webp':
      return startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8);
    case 'svg':
      return sniffSvg(bytes);
  }
}
