import { safeUrl, type ExportRenderers, type ExportSegment } from '@simplemd/core';

/**
 * APPSEC-R2-12: a saída dos renderizadores (Mermaid, KaTeX, calc) é lida pelo parser do próprio
 * navegador num documento inerte (`DOMParser`: não roda script nem carrega imagem) e só sai a
 * serialização desse DOM, conferida. Assim o que o arquivo exportado contém é o que foi conferido,
 * sem a diferença entre um leitor de texto e o parser HTML (comentários, aspas em valor sem aspas).
 * O core ainda passa o resultado pelo `isUnsafeRender` (defesa em profundidade). `<title>`/`<desc>`
 * do SVG são elementos comuns e ficam (contrato com o gráfico de pizza, B-15).
 */
const BLOCKED: Readonly<Record<string, true>> = {
  script: true,
  iframe: true,
  frame: true,
  frameset: true,
  object: true,
  embed: true,
  applet: true,
  portal: true,
  foreignobject: true,
  base: true,
  meta: true,
  link: true,
  form: true,
  noscript: true,
  template: true,
};
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
const SCRIPT_SCHEME = /(?:javascript|vbscript|livescript):|data:text\/html/;

/**
 * CSS que busca algo fora do documento: `@import`, ou `url(`/`image-set(` cujo alvo (sem aspas,
 * espaços e escapes CSS) não é um `#id` do próprio documento (os marcadores do Mermaid).
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

/** Texto de um nó de topo como o serializador HTML o escreveria. */
const TEXT_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '\u00a0': '&nbsp;',
  '<': '&lt;',
  '>': '&gt;',
};

/**
 * Lê `html` num documento inerte e devolve o `<body>` serializado nó a nó, ou `null` se o parser
 * mandou algo para fora do corpo (`<head>`, atributos em `<html>`/`<body>`): isso não sairia no
 * arquivo como foi conferido.
 */
function parseBody(html: string): { body: HTMLElement; serialized: string } | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (
    doc.head.childNodes.length > 0 ||
    doc.body.attributes.length > 0 ||
    doc.documentElement.attributes.length > 0
  )
    return null;
  let serialized = '';
  for (const node of doc.body.childNodes) {
    if (node.nodeType === Node.ELEMENT_NODE) serialized += (node as Element).outerHTML;
    else if (node.nodeType === Node.TEXT_NODE)
      serialized += (node.textContent ?? '').replace(/[&\u00a0<>]/g, (c) => TEXT_ESCAPES[c] ?? c);
    else if (node.nodeType === Node.COMMENT_NODE) serialized += `<!--${node.textContent ?? ''}-->`;
  }
  return { body: doc.body, serialized };
}

/** Saída de renderizador → HTML canônico conferido, ou `null` (o core mostra o código cru). */
export function normalizeRender(html: string): string | null {
  const parsed = parseBody(html);
  if (parsed === null) return null;
  for (const element of parsed.body.querySelectorAll('*')) {
    const tag = element.localName.toLowerCase();
    if (BLOCKED[tag] === true) return null;
    for (const { name, value } of element.attributes) {
      const attribute = name.toLowerCase();
      const probe = [...value]
        .filter((char) => char.charCodeAt(0) > 32)
        .join('')
        .toLowerCase();
      if (attribute.startsWith('on') || SCRIPT_SCHEME.test(probe) || fetchesCss(value)) return null;
      if (URL_ATTRIBUTES[attribute] === true && safeUrl(value, 'link') === null) return null;
    }
    if (tag === 'style' && fetchesCss(element.textContent ?? '')) return null;
  }
  // mXSS: a serialização relida tem de dar o mesmo texto, senão o arquivo seria outro DOM.
  return parseBody(parsed.serialized)?.serialized === parsed.serialized ? parsed.serialized : null;
}

/** Os mesmos renderizadores, com toda saída passando por {@link normalizeRender}. */
export function normalizeRenderers(renderers: ExportRenderers): ExportRenderers {
  const { fence, block, inline } = renderers;
  const out: ExportRenderers = {};
  if (fence) {
    out.fence = async (info, code) => {
      const rendered = await fence(info, code);
      const html = rendered === null ? null : normalizeRender(rendered.html);
      return html === null ? null : { html };
    };
  }
  if (block) {
    out.block = async (text) => {
      const rendered = await block(text);
      const html = rendered === null ? null : normalizeRender(rendered.html);
      return rendered === null || html === null ? null : { html, end: rendered.end };
    };
  }
  if (inline) {
    out.inline = (text, blocked) =>
      inline(text, blocked).flatMap((segment): ExportSegment[] => {
        const html = normalizeRender(segment.html);
        return html === null ? [] : [{ ...segment, html }];
      });
  }
  return out;
}
