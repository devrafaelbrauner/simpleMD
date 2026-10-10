// @vitest-environment jsdom
// AC-I10.2 (R-I10.5): a suíte adversarial (≥ 100 vetores) pela política única, no editor (fragmento)
// e na exportação (texto serializado, relido pelo parser como o arquivo seria): 0 `<script>`,
// 0 `on*`, 0 `class`/`id`/`name`, 0 URL proibida, 0 elemento/atributo fora da lista.
import { describe, expect, it } from 'vitest';
import { createHtmlSanitizer, IMAGE_SOURCE_ATTR } from '../src/sanitize/sanitizer';
import { ALLOWED_ATTR, ALLOWED_TAGS, hrefAllowed } from '../src/sanitize/policy';
import { sanitizeStyle } from '../src/sanitize/style';
import { HTML_ADVERSARIAL } from '../src/testing/html-adversarial';

const sanitizer = createHtmlSanitizer(window);
const TAGS = new Set(ALLOWED_TAGS);
const ATTRS = new Set(ALLOWED_ATTR);
const DATA_PNG = 'data:image/png;base64,iVBORw0KGgo=';

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
      if (name === 'href' && !hrefAllowed(value)) hits.push(`${tag}[href=${value}]`);
      if (name === 'src' && !(target === 'export' && value === DATA_PNG))
        hits.push(`${tag}[src=${value}]`);
      if (name === 'style' && sanitizeStyle(value) !== value) hits.push(`${tag}[style=${value}]`);
      if (/url\(|expression|@import|javascript:|vbscript:|data:text/i.test(value) && name !== 'title' && name !== 'alt' && name !== 'abbr')
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
      const html = sanitizer.toExportHtml(vector, () => DATA_PNG);
      const reparsed = new DOMParser().parseFromString(html, 'text/html').body;
      expect(violations(reparsed, 'export')).toEqual([]);
      // Releitura estável: o arquivo é o DOM que foi conferido.
      expect(reparsed.innerHTML).toBe(html);
    },
  );

  it('nada executou durante a sanitização (bandeira e ouvintes)', () => {
    for (const vector of HTML_ADVERSARIAL) {
      sanitizer.toFragment(vector);
      sanitizer.toExportHtml(vector, () => null);
    }
    expect('__xss' in window).toBe(false);
  });
});
