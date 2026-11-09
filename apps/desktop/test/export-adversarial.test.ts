// @vitest-environment jsdom
// APPSEC-R2-12 (AC-B12.8, AC-B12.11): o corpo adversarial da AppSec r2 (17 saídas hostis de
// renderizador + 2 diferenças de parser + CSS que busca recurso externo) passa pelo normalizador da
// exportação, que relê a saída com o parser do navegador e só devolve a serialização conferida.
import '../../../packages/core/test/setup-dom';
import '../../../packages/plugins-internal/test/setup-svg';
import type { ExportRenderers, ExportSegment } from '@simplemd/core';
import { exportDocument, renderExportBody } from '@simplemd/core/export';
import { HTML_ADVERSARIAL } from '@simplemd/core/testing';
import exportFixture from '@simplemd/plugins-internal/fixtures/export-fixture.md?raw';
import richFixture from '@simplemd/plugins-internal/fixtures/rich.md?raw';
import {
  loadMermaid,
  renderMermaidMarkup,
  themeVariables,
} from '@simplemd/plugins-internal/mermaid/render';
import { lightTokens } from '@simplemd/themes';
import { beforeAll, describe, expect, test } from 'vitest';
import { fxR7 } from '../harness/fixtures/r7';
import { exportSanitizer, normalizeRender, normalizeRenderers } from '../src/export/normalize';

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

/** Construções vivas no documento exportado JÁ PARSEADO (texto que só as menciona não conta). */
function liveConstructs(html: string): string[] {
  const hits: string[] = [];
  for (const el of parse(html).querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    if (
      [
        'script',
        'iframe',
        'object',
        'embed',
        'base',
        'form',
        'frame',
        'foreignobject',
        'link',
      ].includes(tag)
    )
      hits.push(`<${tag}>`);
    // A única meta com http-equiv permitida é a CSP do próprio exportador (APPSEC-R2-09).
    if (
      tag === 'meta' &&
      el.getAttribute('http-equiv') &&
      el.getAttribute('http-equiv') !== 'Content-Security-Policy'
    )
      hits.push('<meta http-equiv>');
    for (const attr of el.attributes) {
      const v = [...attr.value]
        .filter((char) => char.charCodeAt(0) > 32)
        .join('')
        .toLowerCase();
      if (attr.name.toLowerCase().startsWith('on')) hits.push(`${tag}[${attr.name}]`);
      if (/^(javascript|vbscript|livescript):|^data:text\/html/.test(v))
        hits.push(`${tag}[${attr.name}=${attr.value}]`);
    }
  }
  return hits;
}

const markdown = [
  '---',
  'lang: \'pt" onload="alert(1)\'',
  'title: x',
  '---',
  '# T</title><script>alert(1)</script>',
  '',
  '<script>alert(1)</script>',
  '',
  '<img src=x onerror=alert(1)>',
  '',
  'inline <svg onload=alert(1)> and <a href="javascript:alert(1)">a</a>',
  '',
  '[l1](javascript:alert(1)) [l2](JaVaScRiPt:alert(1)) [l3](java\tscript:alert(1)) [l4](java&#115;cript:alert(1))',
  '[l5](<javascript:alert(1)>) [l6](data:text/html,<script>alert(1)</script>) [l7](vbscript:x) [l8][r]',
  '',
  '![i1](javascript:alert(1)) ![i2](data:image/svg+xml,<svg onload=alert(1)>) ![i3](" onerror="alert(1))',
  '',
  '<javascript:alert(1)>',
  '',
  '[r]: javascript:alert(1)',
  '',
  '```mermaid',
  'graph TD; A-->B',
  '```',
  '',
  '$$',
  'x',
  '$$',
  '',
].join('\n');

/** As 17 saídas hostis da AppSec r2 (`qa/AppSecR2/export-adversarial`). */
const evilOutputs = [
  '<svg onload="alert(1)"></svg>',
  '<svg/onload=alert(1)>',
  '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
  '<svg><a href="java&#115;cript:alert(1)">x</a></svg>',
  '<svg><a href="java&#x09;script:alert(1)">x</a></svg>',
  '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>',
  '<svg><foreignObject><div>x</div></foreignObject></svg>',
  '<svg><use href="data:image/svg+xml,&lt;svg onload=alert(1)&gt;"/></svg>',
  '<math><mi href="javascript:alert(1)">x</mi></math>',
  '<img src="x" onerror="alert(1)">',
  '<IMG SRC=x OnError=alert(1)>',
  '<svg><script>alert(1)</script></svg>',
  '<svg><SCRIPT >alert(1)</SCRIPT></svg>',
  '<iframe srcdoc="x"></iframe>',
  '<base href="https://evil.example/">',
  '<form action="https://evil.example/"><button>x</button></form>',
  '<a href="&#106;avascript:alert(1)">x</a>',
];

/** Diferenças de parser (o leitor de texto aceitava) e CSS que busca recurso externo. */
const differentials = [
  '<svg x=a"b onload=alert(1)>',
  '<!--<a x="--><img src=x onerror=alert(1)>">',
  '<svg><style>@import url(https://evil.example/x.css)</style></svg>',
  '<svg><rect style="fill:url(https://evil.example/p)"/></svg>',
  '<svg><rect fill="url(https://evil.example/p)"/></svg>',
];

describe('APPSEC-R2-12 — normalizador da saída dos renderizadores', () => {
  test.each(evilOutputs)('saída hostil recusada: %s', (html) => {
    expect(normalizeRender(html)).toBeNull();
  });

  test.each(differentials)('diferença de parser / CSS externo recusado: %s', (html) => {
    expect(normalizeRender(html)).toBeNull();
  });

  test('saída legítima passa e sai com o mesmo DOM', () => {
    for (const html of [
      '<svg viewBox="0 0 10 10"><g><text x="1">A</text></g></svg>',
      '<span class="katex"><span class="mord">x</span></span>',
      '<svg id="m1"><marker id="m1_end"><path d="M 0 0 L 10 5 z"></path></marker><path d="M0,0L10,10" marker-end="url(#m1_end)"></path></svg>',
    ]) {
      const out = normalizeRender(html);
      expect(out, html).not.toBeNull();
      expect(parse(out!).body.innerHTML).toBe(parse(html).body.innerHTML);
    }
  });

  test('AC-B12.11: <title> e <desc> do SVG (pizza acessível, B-15) ficam', () => {
    const pie =
      '<svg role="img" aria-labelledby="t d"><title id="t">Pets</title><desc id="d">Cães 60%, gatos 40%</desc><g><path d="M0,0L1,1" fill="#336"></path></g></svg>';
    const svg = parse(normalizeRender(pie)!).querySelector('svg');
    expect(svg?.querySelector(':scope > title')?.textContent).toBe('Pets');
    expect(svg?.querySelector(':scope > desc')?.textContent).toBe('Cães 60%, gatos 40%');
  });

  for (const mode of ['file', 'print'] as const) {
    test(`pipeline (${mode}) com documento e renderizadores hostis → 0 construções vivas`, async () => {
      const outputs = [...evilOutputs, ...differentials];
      let i = 0;
      const hostile: ExportRenderers = {
        fence: async () => ({ html: outputs[i++ % outputs.length]! }),
        block: async (text) =>
          text.startsWith('$$')
            ? { html: '<svg/onload=alert(1)>', end: text.indexOf('$$', 2) + 2 }
            : null,
        inline: (text, blocked): ExportSegment[] =>
          text.length > 4 && blocked.length === 0
            ? [{ from: 0, to: 1, html: '<img src=x onerror=alert(1)>', math: true }]
            : [],
      };
      const { bodyHtml } = await renderExportBody(markdown, {
        renderers: normalizeRenderers(hostile),
        mode,
        images: { notePath: null, map: new Map() },
      });
      const doc = exportDocument({
        title: 'T</title><script>alert(1)</script>',
        lang: 'pt-BR',
        css: 'a{}',
        bodyHtml,
      });
      expect(liveConstructs(doc)).toEqual([]);
      expect(doc).not.toMatch(/evil\.example/);
    });
  }
});

/** Tudo o que veio da nota e não pode sobrar no HTML cru renderizado (r7 I-10, D-31). */
function noteAttributes(html: string): string[] {
  const hits: string[] = [];
  for (const el of parse(html).querySelectorAll('main *')) {
    for (const { name, value } of el.attributes) {
      if (name === 'id' || name === 'name') hits.push(`${el.localName}[${name}=${value}]`);
      // Classes geradas pelo próprio serializador (alt de imagem, fonte crua, linguagem da cerca).
      if (name === 'class' && !/^(?:smd-img-alt|smd-raw|language-[\w-]+)$/.test(value))
        hits.push(`${el.localName}[class=${value}]`);
      if (name === 'style' && /position|z-index|transform|width|height|margin|url\(/i.test(value))
        hits.push(`${el.localName}[style=${value}]`);
      // Espessura de decoração pinta fora da caixa (S10-SEC-01).
      if (
        name === 'style' &&
        /text-decoration:[^;]*\d(?:px|em|rem|%|\b)/i.test(value.replace(/\w+\([^()]*\)/g, ''))
      )
        hits.push(`${el.localName}[style=${value}]`);
      // A nota está na raiz do vault: qualquer `../` sai dele (S10-SEC-06).
      if (name === 'href' && /^(?:\.\.|%2e%2e)[/\\]/i.test(value))
        hits.push(`${el.localName}[href=${value}]`);
      if (name === 'src' && !value.startsWith('data:image/png')) hits.push(`src=${value}`);
      if (['srcset', 'target', 'rel', 'ping', 'formaction', 'action'].includes(name))
        hits.push(`${el.localName}[${name}]`);
    }
  }
  return hits;
}

describe('r7 I-10 (AC-I10.5, R-I10.4) — HTML cru pela política única, antes do pós-checagem', () => {
  const vectors = HTML_ADVERSARIAL.join('\n\n');
  const logo = 'data:image/png;base64,iVBORw0KGgo=';

  for (const mode of ['file', 'print'] as const) {
    test(`pipeline (${mode}) com os ${HTML_ADVERSARIAL.length} vetores + documento hostil → 0 construções vivas, 0 busca externa`, async () => {
      const { bodyHtml } = await renderExportBody(`${markdown}\n${vectors}\n`, {
        renderers: normalizeRenderers({}),
        mode,
        images: { notePath: 'n.md', map: new Map([['img/bandeira.png', { src: logo }]]) },
        sanitizer: await exportSanitizer(),
      });
      const doc = exportDocument({ title: 'T', lang: 'pt-BR', css: 'a{}', bodyHtml });
      expect(liveConstructs(doc)).toEqual([]);
      expect(noteAttributes(doc)).toEqual([]);
      // Texto escapado pode mencionar o domínio e uma URL solta no texto vira link (GFM, só com
      // clique); nenhum OUTRO atributo (src, estilo…) aponta para ele: 0 busca automática.
      const attributes = [...parse(doc).querySelectorAll('*')].flatMap((el) =>
        [...el.attributes].map((a) => `${el.localName}[${a.name}=${a.value}]`),
      );
      expect(
        attributes.filter((a) => a.includes('evil.example') && !a.startsWith('a[href=')),
      ).toEqual([]);
      // O HTML cru passou pela política (não ficou só como texto): a imagem do vault saiu do mapa.
      expect(parse(doc).querySelectorAll(`img[src="${logo}"]`).length).toBeGreaterThan(0);
    });
  }

  test('os vetores um a um pelo sanitizador da exportação: o normalizador aceita a saída sem mudar nada', async () => {
    // A imagem do vault chega ao normalizador como a marca relativa (o `data:` entra depois).
    const sanitizer = await exportSanitizer();
    for (const vector of HTML_ADVERSARIAL) {
      const html = sanitizer.policy.toExportHtml(vector, () => '#smd-img-marca-0', 'n.md');
      if (html === '') continue;
      expect(sanitizer.normalize(html), vector).toBe(html);
    }
  });

  test('o pós-checagem existente continua recusando o que recusava (r2)', () => {
    for (const html of [...evilOutputs, ...differentials]) expect(normalizeRender(html)).toBeNull();
  });
});

/**
 * F1 (r38a2): folhas que alcançariam algo fora do diagrama `#mmd-x` — na prévia, o app inteiro (o
 * `<style>` entra no DOM dele). Todas recusadas pelo pós-checagem.
 */
const outOfScopeStyles = [
  // P3a: folha fora de um SVG de diagrama, ou num SVG sem id de diagrama.
  '<p>x<style>body{display:none}</style></p>',
  '<svg><style>#mmd-x .a{fill:red}</style></svg>',
  '<svg id="root"><style>#root *{display:none}</style></svg>',
  // Seletor global, de irmão, de coluna ou de outro id.
  '<svg id="mmd-x"><style>body{display:none}</style></svg>',
  '<svg id="mmd-x"><style>#mmd-x .a{fill:red}body{display:none}</style></svg>',
  '<svg id="mmd-x"><style>#mmd-x .a,body{fill:red}</style></svg>',
  '<svg id="mmd-x"><style>#mmd-x ~ p{display:none}</style></svg>',
  '<svg id="mmd-x"><style>#mmd-x+p{display:none}</style></svg>',
  '<svg id="mmd-x"><style>#mmd-x || td{color:red}</style></svg>',
  '<svg id="mmd-x"><style>#mmd-xy p{color:red}</style></svg>',
  '<svg id="mmd-x"><style>#MMD-X p{color:red}</style></svg>',
  '<svg id="mmd-x"><style>:root:has(#mmd-x) body::after{content:"x"}</style></svg>',
  '<svg id="mmd-x"><style>:is(#mmd-x) ~ p{color:red}</style></svg>',
  // At-rules com nome global ou que valem para o documento.
  '<svg id="mmd-x"><style>@keyframes cm-blink{from{opacity:0}}</style></svg>',
  '<svg id="mmd-x"><style>@font-face{font-family:x;src:local(x)}</style></svg>',
  '<svg id="mmd-x"><style>@counter-style x{system:cyclic;symbols:"*"}</style></svg>',
  '<svg id="mmd-x"><style>@layer app{#mmd-x .a{fill:red}}</style></svg>',
  '<svg id="mmd-x"><style>@layer a, b;</style></svg>',
  '<svg id="mmd-x"><style>@property --x{syntax:"*";inherits:true}</style></svg>',
  '<svg id="mmd-x"><style>@media print{body{display:none}}</style></svg>',
  '<svg id="mmd-x"><style>@import "x.css";</style></svg>',
  // O que a leitura não imita: regra aninhada, comentário, escape, `url(` sem aspas (o navegador
  // fecharia a primeira regra antes de `body`), string com quebra de linha, elemento na folha.
  '<svg id="mmd-x"><style>#mmd-x .a{fill:red;&~p{display:none}}</style></svg>',
  '<svg id="mmd-x"><style>#mmd-x .a{fill:red}/**/body{display:none}</style></svg>',
  '<svg id="mmd-x"><style>#mmd-x .a,b\\ody{fill:red}</style></svg>',
  `<svg id="mmd-x"><style>#mmd-x .a{fill:url(#a'b)c'd)}#mmd-x .b{x:'} body{display:none} #mmd-x .c{y:'}</style></svg>`,
  '<svg id="mmd-x"><style>#mmd-x [a="\n"]{fill:red}</style></svg>',
  '<svg id="mmd-x"><style><a>x</a>#mmd-x .a{fill:red}</style></svg>',
  // `url(#…)` só para um id do próprio diagrama.
  '<svg id="mmd-x"><style>#mmd-x .a{fill:url(#root)}</style></svg>',
];

describe('F1 (r38a2) — `<style>` só no `#id` do diagrama', () => {
  beforeAll(async () => {
    await loadMermaid();
  }, 20_000);

  test.each(outOfScopeStyles)('folha que sai do diagrama recusada: %s', (html) => {
    expect(normalizeRender(html)).toBeNull();
  });

  test('folha na forma do Mermaid (seletores no #id e as animações dele) passa', () => {
    const html =
      '<svg id="mmd-x"><style>#mmd-x{font-family:"trebuchet ms", verdana;font-size:16px;fill:#333;}@keyframes edge-animation-frame{from{stroke-dashoffset:0;}}@keyframes dash{to{stroke-dashoffset:0;}}#mmd-x .node rect,#mmd-x .node circle{fill:#eee;}#mmd-x>g{opacity:1;}#mmd-x [data-look="neo"].node path{stroke:url(#mmd-x-gradient);filter:drop-shadow( 1px 2px 2px rgba(185,185,185,1));}</style><g></g></svg>';
    const out = normalizeRender(html);
    expect(out).not.toBeNull();
    expect(parse(out!).body.innerHTML).toBe(parse(html).body.innerHTML);
  });

  test('saída real do Mermaid nas notas do FX-RICH, do FX-R7 e da export-fixture passa sem mudar', async () => {
    const vars = themeVariables((token) => lightTokens[token] ?? '');
    const notes = [
      richFixture,
      exportFixture,
      ...Object.entries(fxR7()).flatMap(([path, value]) =>
        path.endsWith('.md') && typeof value === 'string' ? [value] : [],
      ),
    ];
    const sources = notes.flatMap((note) =>
      [...note.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((match) => match[1] ?? ''),
    );
    expect(sources).toHaveLength(5);
    for (const source of sources) {
      const html = `<figure class="smd-mermaid">${(await renderMermaidMarkup(source, vars)) ?? ''}</figure>`;
      expect(parse(html).querySelectorAll('svg > style'), source).toHaveLength(1);
      const out = normalizeRender(html);
      expect(out, source).not.toBeNull();
      expect(parse(out!).body.innerHTML, source).toBe(parse(html).body.innerHTML);
    }
  }, 30_000);

  test('`%%{init}%%` com themeCSS, fontes e htmlLabels não chega à folha; a saída passa', async () => {
    const source = [
      '%%{init: {"themeCSS": "@keyframes evil{from{opacity:0}} body{display:none}", "fontFamily": "x} @keyframes ff{} a{b:c", "altFontFamily": "y", "htmlLabels": true, "flowchart": {"htmlLabels": true}, "securityLevel": "loose"}}%%',
      'flowchart TD',
      '  A["<b>x</b>"] --> B',
    ].join('\n');
    const svg = await renderMermaidMarkup(
      source,
      themeVariables((token) => lightTokens[token] ?? ''),
    );
    const doc = parse(svg ?? '');
    const css = doc.querySelector('svg > style')?.textContent ?? '';
    expect([...css.matchAll(/@keyframes ([\w-]+)/g)].map((match) => match[1])).toEqual([
      'edge-animation-frame',
      'dash',
    ]);
    expect(css).not.toMatch(/evil|ff\{|body\{|a\{b:c/);
    expect(doc.querySelectorAll('foreignObject')).toHaveLength(0);
    expect(normalizeRender(`<figure class="smd-mermaid">${svg}</figure>`)).not.toBeNull();
  }, 30_000);

  test('F3: URL e texto alternativo não são lidos como CSS; estilo e atributo de apresentação, sim', () => {
    for (const html of [
      '<a href="https://developer.mozilla.org/en-US/docs/Web/CSS/url()">url() no MDN</a>',
      '<img src="img.png" alt="usa url(x) e @import">',
    ])
      expect(normalizeRender(html), html).toBe(html);
    for (const html of [
      '<p style="background:url(https://evil.example/x.png)">x</p>',
      '<svg><rect fill="url(https://evil.example/p)"></rect></svg>',
    ])
      expect(normalizeRender(html), html).toBeNull();
  });
});
