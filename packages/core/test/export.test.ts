// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  exportDocument,
  frontMatterLang,
  renderExportBody,
  safeUrl,
  stripFrontMatter,
  type ExportRenderers,
} from '../src';
import { isUnsafeRender } from '../src/export/escape';
import { EXPORT_CSP } from '../src/export/html';

const body = async (
  doc: string,
  renderers: ExportRenderers = {},
  mode: 'file' | 'print' = 'file',
) => (await renderExportBody(doc, { renderers, mode })).bodyHtml;

/** O corpo como DOM (asserções estruturais, nunca um HTML "dourado"; design-ack T-16). */
const dom = (html: string) => {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
};

describe('stripFrontMatter (R-10.2, AC-10.1)', () => {
  it('tira o bloco e no máximo uma linha em branco; nada mais', () => {
    expect(stripFrontMatter('---\na: 1\n---\n\n# T\n')).toBe('# T\n');
    expect(stripFrontMatter('---\na: 1\n---\n\n\n# T\n')).toBe('\n# T\n');
    expect(stripFrontMatter('---\na: 1\n---\n# T\n')).toBe('# T\n');
    expect(stripFrontMatter('---\na: 1\n...\n  \nx')).toBe('x');
    expect(stripFrontMatter('---\na: 1\n---')).toBe('');
  });

  it('sem front matter (ou começando na linha 3) → igual', () => {
    for (const text of ['# T\n\n---\na\n---\n', 'x\n\n---\na: 1\n---\n', '---\nsem fim\n'])
      expect(stripFrontMatter(text)).toBe(text);
  });

  it('texto cru: BOM e CRLF ficam (só o bloco sai)', () => {
    expect(stripFrontMatter('\uFEFF---\r\na: 1\r\n---\r\n\r\n# T\r\n')).toBe('\uFEFF# T\r\n');
  });
});

describe('safeUrl (R-10.4)', () => {
  it('links: http, https, mailto e relativos; o resto é recusado', () => {
    for (const ok of ['https://a.b/c', 'http://x', 'mailto:a@b.c', 'notas/a.md', '#topo', '../x'])
      expect(safeUrl(ok, 'link')).toBe(ok);
    for (const bad of [
      'javascript:alert(1)',
      ' JavaScript:x',
      'java\tscript:x',
      'data:text/html,x',
      'file:///etc',
      'vbscript:x',
    ])
      expect(safeUrl(bad, 'link')).toBeNull();
    expect(safeUrl('mailto:a@b.c', 'image')).toBeNull();
  });
});

describe('renderExportBody (R-10.4, D-15)', () => {
  it('blocos e marcas da GFM com a mesma árvore do editor', async () => {
    const html = await body(
      [
        '# Título *um*',
        '',
        'Texto **forte**, *ênfase*, ~~riscado~~, `a<b` e [link](https://example.com "t").',
        'Linha dois com \\* escapado e &amp; entidade.',
        '',
        '- um',
        '- dois',
        '',
        '3. três',
        '4. quatro',
        '',
        '- [x] feito',
        '',
        '> citação',
        '',
        '```js',
        'const x = "<b>";',
        '```',
        '',
        '    indentado <i>',
        '',
        '---',
        '',
        'Setext',
        '======',
      ].join('\n'),
    );
    const root = dom(html);
    expect(root.querySelector('h1')?.textContent).toBe('Título um');
    expect(root.querySelector('h1 em')?.textContent).toBe('um');
    expect(root.querySelector('strong')?.textContent).toBe('forte');
    expect(root.querySelector('em')?.textContent).toBe('um');
    expect(root.querySelector('del')?.textContent).toBe('riscado');
    expect(root.querySelector('p code')?.textContent).toBe('a<b');
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    expect(root.querySelector('a')?.textContent).toBe('link');
    expect(root.querySelector('p')?.textContent).toContain('* escapado e & entidade');
    expect([...root.querySelectorAll('ul > li')].map((li) => li.textContent)).toEqual([
      'um',
      'dois',
      '☑ feito',
    ]);
    expect(root.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect(root.querySelector('blockquote p')?.textContent).toBe('citação');
    expect(root.querySelector('pre code.language-js')?.textContent).toBe('const x = "<b>";');
    expect(html).toContain('const x = &quot;&lt;b&gt;&quot;;');
    expect([...root.querySelectorAll('pre code')][1]?.textContent).toBe('indentado <i>');
    expect(root.querySelector('hr')).not.toBeNull();
    expect(root.querySelector('h1:last-of-type')?.textContent).toBe('Setext');
  });

  it('front matter fora; HTML cru como texto; javascript: vira texto; 0 script/on*', async () => {
    const html = await body(
      '---\ntitle: X\n---\n\n<script>alert(1)</script>\n\n<b onclick="x()">cru</b> e <i>em linha</i>\n\n[clique](javascript:alert(1)) ![img](javascript:x)\n',
    );
    const root = dom(html);
    expect(html).not.toContain('title: X');
    expect(html.match(/<script/gi)).toBeNull();
    expect(
      [...root.querySelectorAll('*')]
        .flatMap((el) => [...el.attributes].map((a) => a.name))
        .filter((n) => n.startsWith('on')),
    ).toEqual([]);
    expect(root.textContent).toContain('<script>alert(1)</script>');
    expect(root.textContent).toContain('<b onclick="x()">cru</b> e <i>em linha</i>');
    expect(root.querySelector('a')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('clique');
  });

  it('tabela GFM com alinhamento; célula vazia não desloca colunas', async () => {
    const root = dom(await body('| C | D | E |\n| :-- | :-: | --: |\n| x |  | z |\n'));
    expect([...root.querySelectorAll('th')].map((th) => th.getAttribute('style'))).toEqual([
      'text-align: left',
      'text-align: center',
      'text-align: right',
    ]);
    expect([...root.querySelectorAll('td')].map((td) => td.textContent)).toEqual(['x', '', 'z']);
    expect(root.querySelector('th')?.getAttribute('scope')).toBe('col');
  });

  it('imagens: src como escrito no arquivo; só o alt na impressão', async () => {
    const doc = '![Logo](imagens/logo.png)\n';
    expect(
      dom(await body(doc))
        .querySelector('img')
        ?.getAttribute('src'),
    ).toBe('imagens/logo.png');
    const print = dom(await body(doc, {}, 'print'));
    expect(print.querySelector('img')).toBeNull();
    expect(print.textContent).toBe('Logo');
  });

  it('links por referência resolvem; sem definição ficam como texto', async () => {
    const root = dom(await body('[a][r] e [b]\n\n[r]: https://r.example\n'));
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://r.example');
    expect(root.textContent).toContain('[b]');
  });

  it('renderizadores injetados: cerca de topo, bloco $$ e trechos em linha (fora do código)', async () => {
    const seen: string[] = [];
    const renderers: ExportRenderers = {
      fence: async (info, code) =>
        info === 'mermaid'
          ? { html: `<figure class="smd-mermaid"><svg>${code.trim()}</svg></figure>` }
          : null,
      block: async (text) =>
        text.startsWith('$$\nE\n$$')
          ? { html: '<div class="katex-display">E</div>', end: 7 }
          : null,
      inline: (text, blocked) => {
        seen.push(text);
        const out = [];
        for (const m of text.matchAll(/=2\+3|\$x\$/g)) {
          const from = m.index;
          if (blocked.some((b) => from >= b.from && from < b.to)) continue;
          out.push({
            from,
            to: from + m[0].length,
            html: m[0] === '$x$' ? '<span class="katex">x</span>' : '5',
            math: m[0] === '$x$',
          });
        }
        return out;
      },
    };
    const { bodyHtml, usesMath } = await renderExportBody(
      '```mermaid\nA\n```\n\n$$\nE\n$$\ndepois\n\nSoma =2+3, **$x$** e `=2+3`.\n\n- ```mermaid\n  B\n  ```\n',
      { renderers, mode: 'file' },
    );
    const root = dom(bodyHtml);
    expect(root.querySelector('figure.smd-mermaid svg')?.textContent).toBe('A');
    expect(root.querySelector('.katex-display')?.textContent).toBe('E');
    expect([...root.querySelectorAll('p')].map((p) => p.textContent)).toContain('depois');
    expect(root.querySelector('strong .katex')?.textContent).toBe('x');
    expect(root.textContent).toContain('Soma 5,');
    expect(root.querySelector('p code')?.textContent).toBe('=2+3');
    // Cerca dentro de lista não é de topo: sai como código (paridade com o editor).
    expect(root.querySelector('li pre code.language-mermaid')).not.toBeNull();
    expect(usesMath).toBe(true);
  });

  it('saída de renderizador com script/on*/javascript: é descartada (fica a fonte)', async () => {
    const renderers: ExportRenderers = {
      fence: async () => ({ html: '<svg onload="x()"></svg>' }),
      inline: (text) => [
        { from: 0, to: text.length, html: '<a href="javascript:x">y</a>', math: false },
      ],
    };
    const { bodyHtml, usesMath } = await renderExportBody('```mermaid\nA\n```\n\ntexto\n', {
      renderers,
      mode: 'file',
    });
    expect(bodyHtml).not.toMatch(/onload|javascript:/);
    expect(dom(bodyHtml).querySelector('pre code')?.textContent).toBe('A\n'.trim());
    expect(usesMath).toBe(false);
  });

  it('CR2-06: desvios do pós-checagem por regex (svg/onload, entidades, foreignObject, iframe) são descartados', async () => {
    const payloads = [
      '<svg/onload=alert(1)>',
      '<svg><a xlink:href="jav&#x61;script:alert(1)"><text>x</text></a></svg>',
      '<a href="jav&#97;script&colon;alert(1)">x</a>',
      '<a href="java&Tab;script:x">x</a>',
      '<svg><foreignObject><div>x</div></foreignObject></svg>',
      '<iframe src="https://exemplo.com"></iframe>',
      '<svg><set attributeName="href" to="javascript:alert(1)"/></svg>',
      '<img src="data:image/svg+xml,x">',
      '<svg><a href="vbscript:x">x</a></svg>',
      '<svg><animate onbegin="x()"/></svg>',
      '<div ONCLICK = "x()">',
    ];
    for (const payload of payloads) expect(isUnsafeRender(payload), payload).toBe(true);
    for (const payload of payloads) {
      const renderers: ExportRenderers = { fence: async () => ({ html: payload }) };
      const html = await body('```mermaid\nA\n```\n', renderers);
      expect(dom(html).querySelector('pre code')?.textContent, payload).toBe('A');
    }
  });

  it('CR2-06: saída legítima de KaTeX e de Mermaid continua aceita', () => {
    const katex =
      '<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base"><span class="strut" style="height:0.4306em;"></span><span class="mord mathnormal">x</span></span></span></span>';
    const mermaid =
      '<svg id="m1" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Diagrama"><style>#m1{font-family:"trebuchet ms";}#m1 .node rect{fill:#eee;}</style><g><marker id="m1_end" viewBox="0 0 10 10"><path d="M 0 0 L 10 5 z"></path></marker><path d="M0,0L10,10" marker-end="url(#m1_end)"></path><a href="#topo"><text x="1" y="2">A &amp; B</text></a></g></svg>';
    expect(isUnsafeRender(katex)).toBe(false);
    expect(isUnsafeRender(mermaid)).toBe(false);
  });

  it('APPSEC-R2-12: CSS que busca algo fora do documento é recusado; url(#id) continua aceito', () => {
    const fetching = [
      '<svg><style>@import url(https://evil.example/x.css)</style></svg>',
      '<svg><style>@IMPORT "x.css";</style></svg>',
      '<svg><rect style="fill:url(https://evil.example/p)"/></svg>',
      '<svg><rect fill="url(https://evil.example/p)"/></svg>',
      '<svg><rect fill="&#117;rl(https://evil.example/p)"/></svg>',
      '<svg><style>rect{fill:\\75 rl(https://evil.example/p)}</style></svg>',
      '<span style="background:image-set(\'x.png\' 1x)"></span>',
    ];
    for (const payload of fetching) expect(isUnsafeRender(payload), payload).toBe(true);
    expect(isUnsafeRender('<svg><path marker-end="url(#m1_end)"></path></svg>')).toBe(false);
    expect(isUnsafeRender('<svg><rect style="fill: url( \'#grad\' )"/></svg>')).toBe(false);
    // CR3-B1: texto comum que só menciona url(/@import não é CSS.
    for (const text of [
      '<svg><text>veja url(a) e @import x</text></svg>',
      '<span class="katex"><span class="mord text"><span class="mord">url(a)</span></span></span>',
      '<svg><g><text>&#64;import x</text></g></svg>',
    ])
      expect(isUnsafeRender(text), text).toBe(false);
    // Sem fechamento, o `<style>` vai até o fim e continua conferido.
    expect(isUnsafeRender('<svg><style>rect{fill:url(https://evil.example/p)}')).toBe(true);
  });
});

describe('documento (R-10.4)', () => {
  it('doctype, lang, charset e title escapados', () => {
    const html = exportDocument({ title: 'A <b>', lang: 'en', css: 'p{}', bodyHtml: '<p>x</p>' });
    expect(html.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<title>A &lt;b&gt;</title>');
  });

  it('APPSEC-R2-09: CSP em <meta> logo depois do charset, antes do título e do estilo', () => {
    expect(EXPORT_CSP).toBe(
      "default-src 'none'; img-src * file:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'",
    );
    const html = exportDocument({ title: 'T', lang: 'en', css: 'p{}', bodyHtml: '<p>x</p>' });
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>')).split('\n');
    expect(head.slice(0, 3)).toEqual([
      '<head>',
      '<meta charset="utf-8">',
      `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`,
    ]);
    const order = ['Content-Security-Policy', '<title>', '<style>'].map((s) => html.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(
      new DOMParser().parseFromString(html, 'text/html').querySelectorAll('meta[http-equiv]'),
    ).toHaveLength(1);
  });

  it('lang do front matter (válido), senão null', () => {
    expect(frontMatterLang('---\nlang: en-US\n---\n')).toBe('en-US');
    expect(frontMatterLang('---\nlang: "<x>"\n---\n')).toBeNull();
    expect(frontMatterLang('# sem\n')).toBeNull();
  });
});
