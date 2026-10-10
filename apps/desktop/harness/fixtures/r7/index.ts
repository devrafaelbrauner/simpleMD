import {
  GIF_BASE64,
  HOSTILE_SVG_TEXT,
  JPEG_BASE64,
  PNG_BASE64,
  SVG_TEXT,
  WEBP_BASE64,
} from './images';

/**
 * Vault `FX-R7` do harness e dos testes do r7 (product r7 §6; sprint S0). As notas são arquivos
 * `.md` em `./vault/` lidos byte a byte (fora do Prettier: o lint e as tabelas dependem de espaços);
 * imagens e caminhos que o git não guarda (`.git/`, nome com acento) são montados aqui. Conteúdo:
 *
 * - `links.md`, `inline.md`, `imagens.md` (I-1): links de todas as formas e a matriz de esquemas;
 *   tachado, código, citações de 3 níveis, tarefas ` `/`x`/`X`/`-`/`/`; os 5 tipos de imagem
 *   (relativa, `/raiz`, `../`, `<com espaços>`, `%20`), remotas/esquemas, recusas (fora do vault,
 *   `.git/`, `.simplemd/`, bytes trocados, ausente, extensão não suportada), SVG hostil e os limites;
 * - `wikilinks.md` + `receitas/Bolo.md`, `a|b/Nota.md`, `Pão.md`/`Pao.md`, `diario/`, `notas/`
 *   (I-2): única, caixa, apelido, título, ambígua, acentos, inexistentes; backlinks do Bolo em
 *   `FX_R7_BOLO_SOURCES`;
 * - `tarefas/`, `diario/`, `livros/`, `consultas.md` (I-9): `FX_R7_TASKS` tarefas com todos os sinais
 *   e uma data inválida, propriedades no front matter, 10 consultas `tasks` + 10 `dataview` de
 *   referência e 3 recusadas;
 * - `html.md` (I-10), `tabelas.md` (I-3, CJK/emoji/escape/faltando), `listas.md` (I-7), `lint.md`
 *   (I-5), `latex.md` (I-6).
 */

type Files = Record<string, string | Uint8Array>;

const notes = import.meta.glob<string>('./vault/**/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
});

/** Limites de imagem de NFR-45 (product r7 §6). */
export const FX_R7_LIMITS = { raster: 20 * 1024 * 1024, svg: 2 * 1024 * 1024 } as const;

/** Número exato de linhas de tarefa (`- [?] `) no vault. */
export const FX_R7_TASKS = 200;

/** Notas que apontam para `receitas/Bolo.md` (wikilink ou `.md` relativo); conjunto do AC-I2.6. */
export const FX_R7_BOLO_SOURCES = [
  'diario/2026-10-01.md',
  'links.md',
  'notas/relativo.md',
  'notas/sub/profunda.md',
  'wikilinks.md',
] as const;

const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const utf8 = (text: string) => new TextEncoder().encode(text);

/**
 * Imagem com cabeçalho válido do tipo e exatamente `size` bytes (o resto é preenchimento): para os
 * limites de NFR-45 serem testados pelo tamanho, não pelo tipo. Gerada na hora (nada no git).
 */
export function oversizeImage(kind: 'png' | 'svg', size: number): Uint8Array {
  const out = new Uint8Array(size);
  if (kind === 'png') {
    out.set(bytes(PNG_BASE64).subarray(0, 33)); // assinatura + IHDR
    return out;
  }
  const open = utf8('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><!--');
  const close = utf8('--></svg>\n');
  out.fill(0x20);
  out.set(open);
  out.set(close, size - close.length);
  return out;
}

/** As imagens válidas dos 5 tipos em `img/` (também usadas pelo `rich-r7-10k.md`). */
export function fxR7Images(): Files {
  return {
    'img/bandeira.png': bytes(PNG_BASE64),
    'img/foto.jpg': bytes(JPEG_BASE64),
    'img/anim.gif': bytes(GIF_BASE64),
    'img/imagem.webp': bytes(WEBP_BASE64),
    'img/desenho.svg': utf8(SVG_TEXT),
  };
}

/** O vault `FX-R7` (caminho → conteúdo), sem as duas imagens de limite (`fxR7Oversize()`). */
export function fxR7(): Files {
  const files: Files = {};
  for (const [path, text] of Object.entries(notes)) files[path.slice('./vault/'.length)] = text;
  const png = bytes(PNG_BASE64);
  const jpeg = bytes(JPEG_BASE64);
  return {
    ...files,
    ...fxR7Images(),
    'Pão.md': '# Pão\n\nAcento faz parte do nome.\n',
    'img/com espaços.png': png,
    'img/hostil.svg': utf8(HOSTILE_SVG_TEXT),
    // Bytes trocados (AC-I1.8): a extensão diz PNG, o conteúdo não.
    'img/falso-html.png': utf8('<!doctype html><html><body>não é imagem</body></html>\n'),
    'img/falso-svg.png': utf8(SVG_TEXT),
    'img/falso-jpeg.png': jpeg,
    'img/documento.bmp': Uint8Array.of(0x42, 0x4d, 0x1e, 0, 0, 0, 0, 0, 0, 0),
    '.git/x.png': png,
    '.simplemd/x.png': png,
  };
}

/**
 * Limites (AC-I1.9): raster de 20 MiB + 1 e SVG de 2 MiB + 1, citados em `imagens.md`. Fora de
 * `fxR7()` (CR-S0-07): só os testes de limite e o preset do harness pagam os ~22 MiB.
 */
export function fxR7Oversize(): Files {
  return {
    'img/grande.png': oversizeImage('png', FX_R7_LIMITS.raster + 1),
    'img/grande.svg': oversizeImage('svg', FX_R7_LIMITS.svg + 1),
  };
}
