// @vitest-environment jsdom
// AC-I10.1 (R-I10.1; D-31): para cada elemento e atributo da política, um caso que entra e um que
// sai; `style` re-serializado só com as 6 propriedades; cache por texto (R-I10.6, NFR-41).
import { describe, expect, it } from 'vitest';
import { liveCounters } from '../src/live-preview/counters';
import { SanitizeCache } from '../src/sanitize/cache';
import {
  ALLOWED_ATTR,
  ALLOWED_TAGS,
  attributeAllowedOn,
  attributeValue,
  FORBID_ATTR,
  FORBID_TAGS,
  hrefAllowed,
  imageSourceCandidate,
  INLINE_TAGS,
  STYLE_PROPS,
} from '../src/sanitize/policy';
import {
  createHtmlSanitizer,
  hasVisibleContent,
  IMAGE_SOURCE_ATTR,
} from '../src/sanitize/sanitizer';
import { sanitizeStyle } from '../src/sanitize/style';

const sanitizer = createHtmlSanitizer(window);

/** Serialização do fragmento do editor (para comparar como texto). */
function editorHtml(html: string): string {
  const holder = document.createElement('div');
  holder.append(sanitizer.toFragment(html));
  return holder.innerHTML;
}

/** Contexto mínimo em que o parser HTML mantém o elemento (partes de tabela, itens, summary). */
const CONTEXT: Readonly<Record<string, (inner: string) => string>> = {
  li: (x) => `<ul>${x}</ul>`,
  dd: (x) => `<dl>${x}</dl>`,
  dt: (x) => `<dl>${x}</dl>`,
  summary: (x) => `<details>${x}</details>`,
  td: (x) => `<table><tbody><tr>${x}</tr></tbody></table>`,
  th: (x) => `<table><tbody><tr>${x}</tr></tbody></table>`,
  tr: (x) => `<table><tbody>${x}</tbody></table>`,
  tbody: (x) => `<table>${x}</table>`,
  thead: (x) => `<table>${x}</table>`,
  tfoot: (x) => `<table>${x}</table>`,
};
const VOID = new Set(['br', 'hr', 'img']);

function sample(tag: string): string {
  const own = VOID.has(tag)
    ? tag === 'img'
      ? '<img src="a.png" alt="x">'
      : `<${tag}>`
    : `<${tag}>conteúdo</${tag}>`;
  return (CONTEXT[tag] ?? ((x: string) => x))(own);
}

describe('AC-I10.1 elementos', () => {
  it.each(ALLOWED_TAGS)('<%s> entra', (tag) => {
    const fragment = sanitizer.toFragment(sample(tag));
    expect(fragment.querySelector(tag)).not.toBeNull();
  });

  it.each(FORBID_TAGS)('<%s> sai (script/style levam o conteúdo junto)', (tag) => {
    const fragment = sanitizer.toFragment(`<${tag}>texto ${tag}</${tag}><b>depois</b>`);
    expect(fragment.querySelector(tag)).toBeNull();
    const text = fragment.textContent ?? '';
    if (tag === 'script' || tag === 'style') expect(text).not.toContain(`texto ${tag}`);
  });

  it('o texto dos removidos fica (form/button/svg), comentários saem', () => {
    expect(editorHtml('<form>a<button>b</button></form><!-- c -->d')).toBe('abd');
    expect(editorHtml('<svg><text>no svg</text></svg>')).toBe('no svg');
    expect(editorHtml('<p>x<!-- comentário --></p>')).toBe('<p>x</p>');
  });

  it('<details> sem <summary> ganha "Detalhes"; com summary fica como está', () => {
    expect(editorHtml('<details>corpo</details>')).toBe(
      '<details><summary>Detalhes</summary>corpo</details>',
    );
    expect(editorHtml('<details open><summary>S</summary>c</details>')).toBe(
      '<details open=""><summary>S</summary>c</details>',
    );
  });

  it('grupos em linha só com conteúdo de frase: subconjunto da lista, sem elemento de fluxo', () => {
    for (const tag of INLINE_TAGS) expect(ALLOWED_TAGS).toContain(tag);
    for (const tag of ['div', 'p', 'table', 'td', 'details', 'summary', 'h1', 'pre', 'ul', 'hr'])
      expect(INLINE_TAGS).not.toContain(tag);
  });
});

/** [atributo, HTML onde entra, seletor que o mostra, HTML onde sai]. */
const ATTRIBUTE_CASES: ReadonlyArray<readonly [string, string, string, string]> = [
  [
    'href',
    '<a href="https://exemplo.org/x">a</a>',
    'a[href="https://exemplo.org/x"]',
    '<a href="javascript:alert(1)">a</a>',
  ],
  [
    'src',
    '<img src="img/a.png" alt="a">',
    `img[${IMAGE_SOURCE_ATTR}="img/a.png"]`,
    '<img src="https://exemplo.org/a.png" alt="a">',
  ],
  ['alt', '<img src="a.png" alt="texto">', 'img[alt="texto"]', '<p alt="texto">p</p>'],
  ['title', '<span title="dica">s</span>', 'span[title="dica"]', '<iframe title="dica"></iframe>'],
  ['width', '<img src="a.png" width="120">', 'img[width="120"]', '<img src="a.png" width="99999">'],
  ['height', '<td height="40">c</td>', 'td[height="40"]', '<p height="40">p</p>'],
  ['align', '<p align="center">p</p>', 'p[align="center"]', '<p align="javascript">p</p>'],
  ['colspan', '<td colspan="2">c</td>', 'td[colspan="2"]', '<td colspan="x">c</td>'],
  ['rowspan', '<th rowspan="3">c</th>', 'th[rowspan="3"]', '<p rowspan="3">p</p>'],
  ['open', '<details open><summary>s</summary>c</details>', 'details[open]', '<p open>p</p>'],
  ['start', '<ol start="3"><li>a</li></ol>', 'ol[start="3"]', '<ol start="1e9"><li>a</li></ol>'],
  ['reversed', '<ol reversed><li>a</li></ol>', 'ol[reversed]', '<ul reversed><li>a</li></ul>'],
  ['type', '<ol type="a"><li>a</li></ol>', 'ol[type="a"]', '<ul type="a"><li>a</li></ul>'],
  ['abbr', '<th abbr="Nome: completo">N</th>', 'th[abbr="Nome: completo"]', '<td abbr="x">c</td>'],
  ['scope', '<th scope="col">N</th>', 'th[scope="col"]', '<th scope="tudo">N</th>'],
  [
    'style',
    '<span style="color: red">s</span>',
    'span[style="color: red"]',
    '<span style="position: fixed">s</span>',
  ],
];

describe('AC-I10.1 atributos', () => {
  it('a tabela cobre todos os atributos da política', () => {
    expect(ATTRIBUTE_CASES.map(([a]) => a).sort()).toEqual([...ALLOWED_ATTR].sort());
  });

  it.each(ATTRIBUTE_CASES)('%s entra e sai', (attribute, kept, selector, dropped) => {
    const wrap = (html: string) => (/^<t[dh]/.test(html) ? CONTEXT.td!(html) : html);
    expect(sanitizer.toFragment(wrap(kept)).querySelector(selector)).not.toBeNull();
    const out = sanitizer.toFragment(wrap(dropped));
    for (const el of out.querySelectorAll('*')) {
      // `src` nunca fica; o estacionado só existe para relativos.
      expect(el.hasAttribute(attribute === 'src' ? IMAGE_SOURCE_ATTR : attribute)).toBe(false);
    }
  });

  it.each(FORBID_ATTR)('%s sai sempre', (attribute) => {
    const fragment = sanitizer.toFragment(
      `<a href="https://exemplo.org" ${attribute}="v">a</a><img src="a.png" ${attribute}="v">`,
    );
    for (const el of fragment.querySelectorAll('*')) expect(el.hasAttribute(attribute)).toBe(false);
  });

  it('on*, xlink:*, data-*, aria-*, tabindex e afins saem', () => {
    const fragment = sanitizer.toFragment(
      '<span onclick="x()" onmouseover="y()" data-x="1" aria-hidden="true" tabindex="0" contenteditable="true" draggable="true" hidden accesskey="k">s</span>',
    );
    expect(fragment.querySelector('span')?.attributes).toHaveLength(0);
  });

  it('regras por elemento e valores enumerados', () => {
    expect(attributeAllowedOn('title', 'anything')).toBe(true);
    expect(attributeAllowedOn('href', 'img')).toBe(false);
    expect(attributeAllowedOn('desconhecido', 'p')).toBe(false);
    expect(attributeValue('align', 'CENTER')).toBe('center');
    expect(attributeValue('scope', 'ROW')).toBe('row');
    expect(attributeValue('type', 'I')).toBe('I');
    expect(attributeValue('type', 'x')).toBeNull();
    expect(attributeValue('start', '-2')).toBe('-2');
    expect(attributeValue('rowspan', '1000')).toBeNull();
    expect(attributeValue('open', 'qualquer')).toBe('');
    expect(attributeValue('title', 'livre')).toBe('livre');
  });
});

describe('AC-I10.1 URLs', () => {
  it.each([
    ['https://exemplo.org', true],
    ['http://exemplo.org/a?b=1', true],
    ['mailto:a@b.c', true],
    ['outra.md#Título', true],
    ['../pasta/nota.md', true],
    ['#secao', true],
    ['javascript:alert(1)', false],
    [' JaVa\tScRiPt:alert(1)', false],
    ['data:text/html,x', false],
    ['vbscript:x', false],
    ['file:///etc/passwd', false],
    ['ftp://exemplo.org', false],
    ['//evil.example', false],
    ['\\\\evil\\share', false],
    ['https://u:p@exemplo.org', false],
    ['', false],
  ] as const)('href %j → %s', (href, ok) => {
    expect(hrefAllowed(href)).toBe(ok);
  });

  it.each([
    ['img/a.png', true],
    ['../a.png', true],
    ['/raiz.png', true],
    ['https://exemplo.org/a.png', false],
    ['data:image/png;base64,AAAA', false],
    ['blob:http://x/1', false],
    ['//evil.example/a.png', false],
    ['C:/Windows/a.png', false],
    ['  ', false],
  ] as const)('src %j → %s', (src, ok) => {
    expect(imageSourceCandidate(src)).toBe(ok);
  });

  it('<img> com esquema vira o texto alternativo na exportação; sem alt, some', () => {
    expect(
      sanitizer.toExportHtml('<img src="https://x.org/a.png" alt="remota">', () => null, null),
    ).toBe('<span class="smd-img-alt">remota</span>');
    expect(
      sanitizer.toExportHtml('<p>a<img src="https://x.org/a.png"></p>', () => null, null),
    ).toBe('<p>a</p>');
    expect(
      sanitizer.toExportHtml(
        '<img src="img/a.png" alt="a" title="t">',
        (raw) => (raw === 'img/a.png' ? 'data:image/png;base64,AAAA' : null),
        null,
      ),
    ).toBe('<img alt="a" title="t" src="data:image/png;base64,AAAA">');
  });

  it('exportação mantém o href permitido; saída sem nada exibível = ""', () => {
    expect(sanitizer.toExportHtml('<a href="https://exemplo.org/x">x</a>', () => null, null)).toBe(
      '<a href="https://exemplo.org/x">x</a>',
    );
    expect(sanitizer.toExportHtml('<script>alert(1)</script>', () => null, null)).toBe('');
    expect(sanitizer.toExportHtml('<p></p><b> </b>', () => null, null)).toBe('');
    expect(sanitizer.toExportHtml('<br>', () => null, null)).toBe('<br>');
    expect(sanitizer.toExportHtml('<hr>', () => null, null)).toBe('<hr>');
  });

  it('exportação: <a> relativo que sai do vault vira só o texto; dentro do vault fica (S10-SEC-06)', () => {
    const out = (html: string) => sanitizer.toExportHtml(html, () => null, 'notas/n.md');
    expect(out('<a href="../../../../etc/passwd">p</a>')).toBe('p');
    expect(out('<a href="%2e%2e/%2e%2e/%2e%2e/etc/passwd">q</a>')).toBe('q');
    expect(out('<a href="../outra.md">o</a>')).toBe('<a href="../outra.md">o</a>');
    expect(out('<a href="#secao">s</a>')).toBe('<a href="#secao">s</a>');
    expect(out('<a href="https://exemplo.org">e</a>')).toBe('<a href="https://exemplo.org">e</a>');
  });
});

describe('AC-I10.1 style', () => {
  it('style="color:red;position:fixed" → só color:red', () => {
    expect(editorHtml('<p style="color:red;position:fixed">p</p>')).toBe(
      '<p style="color: red;">p</p>'.replace(';"', '"'),
    );
  });

  it('style="background:url(x)" → removido', () => {
    expect(editorHtml('<p style="background:url(x)">p</p>')).toBe('<p>p</p>');
    expect(editorHtml('<p style="background-color:url(x)">p</p>')).toBe('<p>p</p>');
  });

  it.each(STYLE_PROPS)('%s entra', (property) => {
    const value =
      {
        'text-align': 'center',
        'font-weight': 'bold',
        'font-style': 'italic',
        'text-decoration': 'underline wavy red',
      }[property] ?? 'rgb(1, 2, 3)';
    expect(sanitizeStyle(`${property}: ${value}`)).toBe(`${property}: ${value}`);
  });

  it.each([
    ['text-decoration: underline 300px', ''],
    ['text-decoration: underline 999px red', ''],
    ['text-decoration: overline 3000px', ''],
    ['text-decoration: line-through 100%', ''],
    ['text-decoration: underline 1em', ''],
    ['text-decoration: underline wavy 200px rgb(255 0 0)', ''],
    ['text-decoration: underline from-font', ''],
    ['text-decoration: underline 0', ''],
    ['color: red; text-decoration: overline 3000px', 'color: red'],
    [
      'text-decoration: underline wavy rgb(255 0 0)',
      'text-decoration: underline wavy rgb(255 0 0)',
    ],
    ['text-decoration: line-through', 'text-decoration: line-through'],
    ['text-decoration: underline #ff0000 dotted', 'text-decoration: underline #ff0000 dotted'],
    ['text-decoration: none', 'text-decoration: none'],
  ] as const)('text-decoration sem espessura (S10-SEC-01): %j → %j', (style, kept) => {
    expect(sanitizeStyle(style)).toBe(kept);
  });

  it.each([
    'color: url(x)',
    'color: URL (x)',
    'color: var(--color-accent)',
    'color: expression(alert(1))',
    'color: red !important',
    'color: \\72 ed',
    'color: "red"',
    'color: red @import x',
    'background-color: image-set(x 1x)',
    'color: env(safe-area-inset-top)',
    'color: rgb(1, 2, 3',
    'color: rgb 1, 2, 3)',
    'color: (red)',
    'color: /* c */ red',
    'position: fixed',
    'z-index: 9',
    'transform: scale(9)',
    'width: 9999px',
    'margin-top: -9999px',
    'background: red',
    'content: "x"',
    `color: ${'a'.repeat(201)}`,
  ])('%j → removido', (style) => {
    expect(sanitizeStyle(style)).toBe('');
  });

  it('a última ocorrência vence; espaços normalizados; atributo gigante sai', () => {
    expect(sanitizeStyle('COLOR : red ; color:  blue  ; font-weight:700')).toBe(
      'color: blue; font-weight: 700',
    );
    expect(sanitizeStyle('color: rgb(0 0 0 / 50%)')).toBe('color: rgb(0 0 0 / 50%)');
    expect(sanitizeStyle('color: burlywood')).toBe('color: burlywood');
    expect(sanitizeStyle(`color: red;${' '.repeat(2001)}`)).toBe('');
    expect(sanitizeStyle('sem-dois-pontos; color: red')).toBe('color: red');
  });
});

describe('R-I10.6 cache por texto (NFR-41)', () => {
  it('só uma falta roda o sanitizador e soma sanitizeRuns; clone independente; LRU', () => {
    let runs = 0;
    const cache = new SanitizeCache((html) => {
      runs++;
      return sanitizer.toFragment(html);
    }, 2);
    const before = liveCounters.sanitizeRuns;
    const a1 = cache.get('<b>a</b>');
    const a2 = cache.get('<b>a</b>');
    expect(runs).toBe(1);
    expect(liveCounters.sanitizeRuns - before).toBe(1);
    expect(a1).not.toBe(a2);
    a1.querySelector('b')?.remove();
    expect(cache.get('<b>a</b>').querySelector('b')).not.toBeNull();
    cache.get('<i>b</i>');
    cache.get('<b>a</b>'); // recém-usado
    cache.get('<u>c</u>'); // despeja <i>
    expect(cache.size).toBe(2);
    cache.get('<b>a</b>');
    expect(runs).toBe(3);
    cache.get('<i>b</i>');
    expect(runs).toBe(4);
  });

  it('inspect lê a mesma entrada sem clonar e conta só a falta', () => {
    let runs = 0;
    const cache = new SanitizeCache((html) => {
      runs++;
      return sanitizer.toFragment(html);
    });
    expect(cache.inspect('<span></span>', hasVisibleContent)).toBe(false);
    expect(cache.inspect('<b>a</b>', hasVisibleContent)).toBe(true);
    cache.get('<b>a</b>');
    expect(runs).toBe(2);
  });

  it('conteúdo visível: texto, imagem que aparece, régua ou quebra; só espaço/elementos vazios não', () => {
    expect(hasVisibleContent(sanitizer.toFragment('<br>'))).toBe(true);
    expect(hasVisibleContent(sanitizer.toFragment('<p> </p><span></span>'))).toBe(false);
    expect(hasVisibleContent(sanitizer.toFragment('<img src="a.png">'))).toBe(true);
    expect(hasVisibleContent(sanitizer.toFragment('<img src="https://x.org/a.png" alt="r">'))).toBe(
      true,
    );
    // Remota sem `alt`: some no editor e na exportação (CR-S10-02).
    expect(hasVisibleContent(sanitizer.toFragment('<img src="https://x.org/a.png">'))).toBe(false);
    expect(hasVisibleContent(sanitizer.toFragment('<img alt=" ">'))).toBe(false);
    expect(hasVisibleContent(sanitizer.toFragment('<hr>'))).toBe(true);
    expect(hasVisibleContent(sanitizer.toFragment('<script>x</script>'))).toBe(false);
  });

  it('<frameset> (sem body no documento de análise) → fragmento vazio', () => {
    expect(sanitizer.toFragment('<frameset><frame src="x"></frameset>').childNodes).toHaveLength(0);
  });
});
