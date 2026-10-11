// @vitest-environment jsdom
// AC-I10.2 (R-I10.5): a suíte adversarial (≥ 100 vetores) pela política única, no editor (fragmento)
// e na exportação (texto serializado, relido pelo parser como o arquivo seria): 0 `<script>`,
// 0 `on*`, 0 `class`/`id`/`name`, 0 URL proibida, 0 elemento/atributo fora da lista.
// O oráculo de `href`/`style` é INDEPENDENTE da política (CR-S10-04): regras próprias aqui, sem
// `hrefAllowed`/`sanitizeStyle`, para que uma regressão nelas apareça nesta suíte.
import { describe, expect, it } from 'vitest';
import { IMAGE_SOURCE_ATTR } from '../src/sanitize/fragment';
import { createHtmlSanitizer } from '../src/sanitize/sanitizer';
import { ALLOWED_ATTR, ALLOWED_TAGS } from '../src/sanitize/policy';
import { HTML_ADVERSARIAL } from '../src/testing/html-adversarial';

const sanitizer = createHtmlSanitizer(window);
const TAGS = new Set(ALLOWED_TAGS);
const ATTRS = new Set(ALLOWED_ATTR);
const DATA_PNG = 'data:image/png;base64,iVBORw0KGgo=';
/** Nota de onde a exportação parte (um nível abaixo da raiz do vault). */
const NOTE = 'notas/n.md';

/** `href` aceitável: http(s)/mailto ou sem esquema, nunca relativo ao esquema (`//`, `\\`). */
const SAFE_HREF = /^(?:https?:|mailto:|(?![a-z][a-z0-9+.-]*:)(?![/\\]{2}))/i;
/** Credenciais na autoridade (`https://u:p@host`). */
const CREDENTIALS = /^https?:[/\\]*[^/\\?#]*@/i;
/** Declaração re-serializada: só as 6 propriedades da R-I10.1, `propriedade: valor`. */
const DECLARATION =
  /^(color|background-color|text-align|font-weight|font-style|text-decoration): ([^;]+)$/;
/** O que nunca pode estar num valor de `style`. */
const STYLE_BANNED = /url\(|var\(|expression|image-set|attr\(|env\(|!|\\|@|["']|\/\*/i;
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^()]*\)/gi;

function hrefViolates(value: string, target: 'editor' | 'export'): boolean {
  const compact = [...value].filter((char) => char.charCodeAt(0) > 32).join('');
  if (!SAFE_HREF.test(compact) || CREDENTIALS.test(compact)) return true;
  if (target === 'editor') return false;
  // Exportação: relativo que sobe dois níveis a partir de `notas/` sai do vault (S10-SEC-06).
  let decoded = compact;
  try {
    decoded = decodeURIComponent(compact);
  } catch {
    // Escape inválido: confere como escrito.
  }
  return decoded.split(/[/\\]/).filter((segment) => segment === '..').length >= 2;
}

function styleViolates(value: string): boolean {
  return value.split('; ').some((declaration) => {
    const match = DECLARATION.exec(declaration);
    if (!match) return true;
    const [, property, body = ''] = match;
    if (STYLE_BANNED.test(body)) return true;
    // `text-decoration` sem espessura (S10-SEC-01): nenhum número fora das funções de cor.
    return property === 'text-decoration' && /\d/.test(body.replace(COLOR_FUNCTION, ''));
  });
}

/** Tudo o que não pode existir numa saída da política (lista vazia = vetor neutralizado). */
function violations(root: ParentNode, target: 'editor' | 'export'): string[] {
  const hits: string[] = [];
  for (const el of root.querySelectorAll('*')) {
    const tag = el.localName;
    if (!TAGS.has(tag)) hits.push(`<${tag}>`);
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') hits.push(`ns ${el.namespaceURI}`);
    for (const { name, value } of el.attributes) {
      if (name.startsWith('on')) hits.push(`${tag}[${name}]`);
      if (name === 'id' || name === 'name') hits.push(`${tag}[${name}]`);
      if (name === 'class' && !(target === 'export' && value === 'smd-img-alt'))
        hits.push(`${tag}[class=${value}]`);
      if (name === 'href' && hrefViolates(value, target)) hits.push(`${tag}[href=${value}]`);
      if (name === 'src' && !(target === 'export' && value === DATA_PNG))
        hits.push(`${tag}[src=${value}]`);
      if (name === 'style' && styleViolates(value)) hits.push(`${tag}[style=${value}]`);
      if (
        /url\(|expression|@import|javascript:|vbscript:|data:text/i.test(value) &&
        name !== 'title' &&
        name !== 'alt' &&
        name !== 'abbr'
      )
        hits.push(`${tag}[${name}=${value}]`);
      const allowed =
        ATTRS.has(name) ||
        (target === 'editor' && name === IMAGE_SOURCE_ATTR && tag === 'img') ||
        (target === 'export' && name === 'class');
      if (!allowed) hits.push(`${tag}[${name}] fora da lista`);
    }
  }
  return hits;
}

describe('AC-I10.2 suíte adversarial (jsdom)', () => {
  it(`tem ≥ 100 vetores distintos (${HTML_ADVERSARIAL.length})`, () => {
    expect(HTML_ADVERSARIAL.length).toBeGreaterThanOrEqual(100);
    expect(new Set(HTML_ADVERSARIAL).size).toBe(HTML_ADVERSARIAL.length);
    for (const vector of HTML_ADVERSARIAL) expect(vector).not.toMatch(/\n\s*\n/);
  });

  it.each(HTML_ADVERSARIAL.map((v, i) => [i, v] as const))(
    'editor #%i: fragmento sem construção viva',
    (_, vector) => {
      const fragment = sanitizer.toFragment(vector);
      expect(violations(fragment, 'editor')).toEqual([]);
      // O fragmento nunca carrega nada: nenhum `<img src>`, nenhum `srcset`.
      expect(fragment.querySelector('[src], [srcset]')).toBeNull();
    },
  );

  it.each(HTML_ADVERSARIAL.map((v, i) => [i, v] as const))(
    'exportação #%i: texto serializado e relido sem construção viva (mXSS)',
    (_, vector) => {
      const html = sanitizer.toExportHtml(vector, () => DATA_PNG, NOTE);
      const reparsed = new DOMParser().parseFromString(html, 'text/html').body;
      expect(violations(reparsed, 'export')).toEqual([]);
      // Releitura estável: o arquivo é o DOM que foi conferido.
      expect(reparsed.innerHTML).toBe(html);
    },
  );

  // 167 vetores × (editor + exportação) num só teste: sob a suíte completa passou dos 5 s padrão
  // (TestResultsR7 F1); limite explícito, mesmas asserções.
  it('nada executou durante a sanitização (bandeira e ouvintes)', () => {
    for (const vector of HTML_ADVERSARIAL) {
      sanitizer.toFragment(vector);
      sanitizer.toExportHtml(vector, () => null, NOTE);
    }
    expect('__xss' in window).toBe(false);
  }, 30_000);
});
