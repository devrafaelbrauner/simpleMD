import { validateUrl } from '../links/url-policy';

/**
 * Política ÚNICA do HTML cru (R-I10.1; D-31 = JEV D-R7-P09b): a mesma tabela vale para o editor
 * (`live-preview/html.ts`) e para a exportação (`export/html.ts`). Nada de `class`/`id`/`name`
 * (o conteúdo da nota não imita nem sobrepõe diálogos do app, nem faz clobbering), `style` só com
 * propriedades sem efeito de layout, e URLs só pelos esquemas da lista.
 */

/** Elementos permitidos (R-I10.1). Todo o resto sai; o texto dos removidos fica (salvo script/style). */
export const ALLOWED_TAGS: readonly string[] = [
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'code',
  'dd',
  'del',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
];

/**
 * Removidos sempre (R-I10.1), mesmo que um dia entrem na lista acima por engano. Conteúdo de
 * `script`/`style` é descartado ({@link FORBID_CONTENTS}); dos demais, o que está dentro fica.
 */
export const FORBID_TAGS: readonly string[] = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'video',
  'audio',
  'source',
  'track',
  'link',
  'meta',
  'base',
  'svg',
  'math',
  'template',
  'noscript',
  'canvas',
  'frame',
  'frameset',
  'noframes',
];

/** Elementos cujo conteúdo sai junto com eles. */
export const FORBID_CONTENTS: readonly string[] = ['script', 'style'];

/** Atributos removidos sempre (R-I10.1); `on*` e `xlink:*` saem pela regra de nome. */
export const FORBID_ATTR: readonly string[] = [
  'class',
  'id',
  'name',
  'target',
  'rel',
  'srcset',
  'ping',
  'formaction',
];

/** Propriedades de `style` que ficam (re-serializadas; `style.ts`). */
export const STYLE_PROPS: readonly string[] = [
  'color',
  'background-color',
  'text-align',
  'font-weight',
  'font-style',
  'text-decoration',
];

const ALIGNABLE = [
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
];
const CELLS = ['td', 'th'];

/** Atributo → elementos onde vale (`*` = todos). Fora disso o atributo sai. */
const ATTRIBUTE_ON: Readonly<Record<string, readonly string[] | '*'>> = {
  href: ['a'],
  src: ['img'],
  alt: ['img'],
  title: '*',
  style: '*',
  width: ['img', 'table', ...CELLS],
  height: ['img', 'table', ...CELLS],
  align: ALIGNABLE,
  colspan: CELLS,
  rowspan: CELLS,
  open: ['details'],
  start: ['ol'],
  reversed: ['ol'],
  type: ['ol'],
  abbr: ['th'],
  scope: ['th'],
};

/** Atributos permitidos (lista para o DOMPurify; a regra por elemento é {@link attributeAllowedOn}). */
export const ALLOWED_ATTR: readonly string[] = Object.keys(ATTRIBUTE_ON);

/** O atributo vale neste elemento? (nomes em minúsculas). */
export function attributeAllowedOn(attribute: string, tag: string): boolean {
  const on = ATTRIBUTE_ON[attribute];
  return on === '*' || (on !== undefined && on.includes(tag));
}

const DIMENSION = /^\d{1,4}%?$/;
const SPAN = /^\d{1,3}$/;
const INTEGER = /^-?\d{1,9}$/;
const ALIGN = /^(?:left|right|center|justify|top|middle|bottom)$/i;
const OL_TYPE = /^[1aAiI]$/;
const SCOPE = /^(?:row|col|rowgroup|colgroup)$/i;

/**
 * Valor aceito de um atributo enumerado/numérico, ou `null` (o atributo sai). `href`/`src`/`style`
 * têm regra própria ({@link hrefAllowed}, {@link imageSourceCandidate}, `sanitizeStyle`); os de
 * texto (`title`, `alt`, `abbr`) ficam como estão (o DOM os trata como texto).
 */
export function attributeValue(attribute: string, value: string): string | null {
  switch (attribute) {
    case 'width':
    case 'height':
      return DIMENSION.test(value) ? value : null;
    case 'colspan':
    case 'rowspan':
      return SPAN.test(value) ? value : null;
    case 'start':
      return INTEGER.test(value) ? value : null;
    case 'align':
      return ALIGN.test(value) ? value.toLowerCase() : null;
    case 'type':
      return OL_TYPE.test(value) ? value : null;
    case 'scope':
      return SCOPE.test(value) ? value.toLowerCase() : null;
    case 'open':
    case 'reversed':
      return '';
    default:
      return value;
  }
}

/** Valor sem espaços nem controles e em minúsculas: o navegador os ignora dentro do esquema. */
function probe(value: string): string {
  let out = '';
  for (const char of value) if (char.charCodeAt(0) > 32) out += char;
  return out.toLowerCase();
}

const SCHEME = /^([a-z][a-z0-9+.-]*):/;
const WEB_OR_MAIL: Readonly<Record<string, true>> = { http: true, https: true, mailto: true };

/** `//host`, `\\host`, `/\host`: relativo ao esquema, sai do vault (e no Windows vira SMB). */
function schemeRelative(compact: string): boolean {
  return /^[/\\]{2}/.test(compact);
}

/**
 * `href` (R-I10.1): `http`/`https`/`mailto` válidos pelo espelho do Rust (`validateUrl`) ou
 * relativo (`.md` e o resto decididos pelo serviço de links, R-I2.6). Outro esquema, relativo ao
 * esquema ou vazio → o atributo sai.
 */
export function hrefAllowed(value: string): boolean {
  const compact = probe(value);
  if (compact === '' || schemeRelative(compact)) return false;
  const scheme = SCHEME.exec(compact)?.[1];
  if (scheme === undefined) return true;
  return WEB_OR_MAIL[scheme] === true && validateUrl(value.trim()).ok;
}

/**
 * `src` de `<img>` (R-I10.1): só caminho relativo (imagem do vault, resolvida e lida pelo
 * pipeline de S1: `blob:` no editor, `data:` na exportação). Qualquer esquema (`https:`, `data:`,
 * `file:`…), relativo ao esquema ou `:` em qualquer ponto (nenhum nome de arquivo do vault o
 * usa; `` `javascript:…` `` nem chega a ser resolvido) → `false`: o elemento vira o texto
 * alternativo.
 */
export function imageSourceCandidate(value: string): boolean {
  const compact = probe(value);
  return compact !== '' && !schemeRelative(compact) && !compact.includes(':');
}

/**
 * `ALLOWED_URI_REGEXP` do DOMPurify (segunda barreira para `href`/`src`): `http:`, `https:`,
 * `mailto:` ou nenhum esquema. O DOMPurify testa o valor já sem espaços/controles.
 */
export const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto):|(?![a-z][a-z0-9+.-]*:))/i;

/** `<summary>` posto num `<details>` sem um (STR-178). */
export const DETAILS_FALLBACK = 'Detalhes';
