/**
 * Escape e lista de esquemas da exportação (R-10.4, D-15). Todo texto do documento passa por
 * {@link escapeHtml}; um `href`/`src` só sai quando {@link safeUrl} o aceita.
 */
const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Texto ou valor de atributo entre aspas duplas, sem nenhuma marcação viva. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);
}

const SCHEME = /^([a-z][a-z0-9+.-]*):/;
const LINK_SCHEMES: Record<string, true> = { http: true, https: true, mailto: true };
const IMAGE_SCHEMES: Record<string, true> = { http: true, https: true };

/**
 * URL permitida (R-10.4): links só `http:`, `https:`, `mailto:` ou relativos; imagens só `http:`,
 * `https:` ou relativas. Qualquer outro esquema (`javascript:`, `data:`, `file:`…) → `null`, e
 * quem chama mostra o texto. Navegadores ignoram espaços e controles dentro do esquema
 * (`java\tscript:`), então a checagem é feita sem eles.
 */
export function safeUrl(raw: string, kind: 'link' | 'image'): string | null {
  const url = raw.trim();
  const probe = [...url]
    .filter((char) => char.charCodeAt(0) > 32)
    .join('')
    .toLowerCase();
  const scheme = SCHEME.exec(probe)?.[1];
  if (scheme === undefined) return url;
  return (kind === 'link' ? LINK_SCHEMES : IMAGE_SCHEMES)[scheme] ? url : null;
}

/**
 * Elementos que nunca saem de um renderizador injetado (KaTeX, Mermaid): script, conteúdo
 * embutido/ativo e metadados do documento.
 */
const UNSAFE_ELEMENT =
  /<\s*\/?\s*(?:script|iframe|frame|frameset|object|embed|applet|portal|foreignobject|base|meta|link|form|noscript|template)(?=[\s/>]|$)/i;
/** Uma tag de abertura: nome e o resto até `>` (atributos), aspas respeitadas. */
const TAG = /<([a-z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>?/gi;
/** Atributo: nome e valor opcional; `/` também separa atributos (`<svg/onload=…>`). */
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
/** Atributos cujo valor o navegador trata como URL. */
const URL_ATTRIBUTES: Readonly<Record<string, true>> = {
  href: true,
  'xlink:href': true,
  src: true,
  action: true,
  formaction: true,
  background: true,
  poster: true,
  data: true,
};
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  colon: ':',
  tab: '\t',
  newline: '\n',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  sol: '/',
  lpar: '(',
  rpar: ')',
};

/** Decodifica as referências de caractere de um valor de atributo, como o navegador faria. */
function decodeEntities(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));?/gi, (whole, hex, dec, name) => {
    if (hex !== undefined || dec !== undefined) {
      const code = Number.parseInt(hex ?? dec, hex !== undefined ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\uFFFD';
    }
    return NAMED_ENTITIES[String(name).toLowerCase()] ?? whole;
  });
}

/**
 * CSS que busca algo fora do documento (APPSEC-R2-12): `@import`, ou `url(`/`image-set(` cujo alvo
 * (sem aspas, espaços e escapes CSS) não é um `#id` do próprio documento (marcadores do Mermaid).
 */
function fetchesCss(text: string): boolean {
  const css = text
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\uFFFD';
    })
    .replace(/\\(.)/gs, '$1')
    .toLowerCase();
  if (css.includes('@import')) return true;
  for (const [, target = ''] of css.matchAll(/(?:url|image-set)\(([^)]*)/g)) {
    if (!target.replace(/["'\s]/g, '').startsWith('#')) return true;
  }
  return false;
}

/**
 * Saída de um renderizador injetado com script, conteúdo ativo, atributo `on*` ou URL fora da
 * lista de esquemas é descartada (defesa em profundidade; R-10.4, CR2-06). Sem DOM no core: cada
 * tag é lida como o navegador a leria (`/` separa atributos, valores com entidades decodificadas e
 * sem espaços/controles no esquema). CSS em atributo ou texto (`<style>`) não pode buscar nada de
 * fora. Na dúvida, recusa — a exportação mostra o código cru.
 */
export function isUnsafeRender(html: string): boolean {
  if (UNSAFE_ELEMENT.test(html) || fetchesCss(decodeEntities(html))) return true;
  for (const [, , rest = ''] of html.matchAll(TAG)) {
    for (const [, rawName = '', double, single, bare] of rest.matchAll(ATTRIBUTE)) {
      const name = rawName.toLowerCase();
      if (name.startsWith('on')) return true;
      const value = decodeEntities(double ?? single ?? bare ?? '');
      const probe = [...value]
        .filter((char) => char.charCodeAt(0) > 32)
        .join('')
        .toLowerCase();
      if (/(?:javascript|vbscript|livescript):|data:text\/html/.test(probe)) return true;
      if (URL_ATTRIBUTES[name] && safeUrl(value, 'link') === null) return true;
    }
  }
  return false;
}
