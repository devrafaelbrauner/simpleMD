/**
 * O que o editor usa do HTML cru sem o DOMPurify: os elementos de um grupo em linha, a leitura do
 * fragmento já sanitizado e o texto da saída vazia. Fica na entrada, enquanto o sanitizador e a
 * política (`sanitizer.ts`, `policy.ts`, `style.ts`) chegam sob demanda (NFR-54; `load.ts`).
 */

/**
 * Elementos que formam um grupo HTML EM LINHA (conteúdo de frase; R-I10.3, CR-S10-03): só estes
 * renderizam no meio de um parágrafo, no editor e na exportação (`inlineHtmlGroups`). Um elemento
 * de fluxo da política (`div`, `p`, `table`, `details`, `h1`…) no meio de um parágrafo deixa o
 * grupo cru: ele não cabe na linha e a caixa do widget em linha não o conteria. Todos estão na
 * lista `ALLOWED_TAGS` de `policy.ts` (conferido em teste).
 */
export const INLINE_TAGS: readonly string[] = [
  'a',
  'abbr',
  'b',
  'br',
  'code',
  'del',
  'em',
  'i',
  'img',
  'ins',
  'kbd',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'u',
];

/** Texto da saída vazia (STR-178; D-R7-D11). */
export const EMPTY_HTML_TEXT = 'HTML sem conteúdo exibível (removido por segurança).';

/**
 * Atributo onde o `src` relativo de um `<img>` fica estacionado depois da sanitização. O `src`
 * nunca sobrevive: quem consome (widget do editor, exportação) resolve o caminho no vault e
 * decide o que desenhar. Os `data-*` da nota já saíram (`ALLOW_DATA_ATTR: false`), então este só
 * pode ter vindo daqui.
 */
export const IMAGE_SOURCE_ATTR = 'data-smd-src';

/**
 * O fragmento tem algo para mostrar? Texto visível, régua, quebra de linha ou imagem que vai
 * aparecer: com `src` (exportação), estacionada do vault ({@link IMAGE_SOURCE_ATTR}) ou com texto
 * alternativo (vira o `alt`). `<img>` sem nada disso some no editor e na exportação.
 */
export function hasVisibleContent(root: ParentNode): boolean {
  if ((root.textContent ?? '').trim() !== '' || root.querySelector('hr, br') !== null) return true;
  for (const img of root.querySelectorAll('img')) {
    if (img.hasAttribute('src') || img.hasAttribute(IMAGE_SOURCE_ATTR)) return true;
    if ((img.getAttribute('alt') ?? '').trim() !== '') return true;
  }
  return false;
}
