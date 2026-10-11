// @vitest-environment jsdom
// AC-I10.5 (R-I10.4; VT): a exportação usa a MESMA política do editor (um módulo), antes do
// pós-checagem; imagens do vault dentro do HTML só pelo mapa; sem sanitizador, como no r2.
import { describe, expect, it } from 'vitest';
import type { ExportImages, ExportSanitizer } from '../src';
import { collectExportImages, renderExportBody } from '../src/export';
import { createHtmlSanitizer } from '../src/sanitize/sanitizer';

const policy = createHtmlSanitizer(window);
const IDENTITY: ExportSanitizer = { policy, normalize: (html) => html };
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

const images = (entries: Record<string, string>): ExportImages => ({
  notePath: 'notas/n.md',
  map: new Map(Object.entries(entries).map(([path, src]) => [path, { src }])),
});

const body = async (
  doc: string,
  sanitizer: ExportSanitizer | undefined = IDENTITY,
  img = images({}),
) =>
  (await renderExportBody(doc, { renderers: {}, mode: 'file', images: img, sanitizer })).bodyHtml;

const dom = (html: string) => {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
};

describe('AC-I10.5 HTML cru na exportação', () => {
  it('bloco e tags em linha saem renderizados e sanitizados; desbalanceada e script não', async () => {
    const html = await body(
      [
        '<details>',
        '<summary>S</summary>',
        '<p style="color:red;position:fixed" class="smd-dialog" onclick="x()">corpo <a href="https://exemplo.org" target="_blank">l</a> <a href="javascript:alert(1)">js</a></p>',
        '</details>',
        '',
        'Teclas <kbd>Ctrl</kbd>, <mark>m <a href="outra.md">nota</a></mark>, a<br>b e <b onclick="x()">negrito</b> mas <i>solta.',
        '',
        '<script>alert(1)</script>',
        '',
        '<details><p>sem resumo</p></details>',
      ].join('\n'),
    );
    const root = dom(html);
    expect(root.querySelector('details > summary')?.textContent).toBe('S');
    const p = root.querySelector('details p');
    expect(p?.getAttribute('style')).toBe('color: red');
    expect(p?.hasAttribute('class')).toBe(false);
    expect(p?.hasAttribute('onclick')).toBe(false);
    expect(
      [...root.querySelectorAll('a')].map((a) => [
        a.textContent,
        a.getAttribute('href'),
        a.getAttribute('target'),
      ]),
    ).toEqual([
      ['l', 'https://exemplo.org', null],
      ['nota', 'outra.md', null],
    ]);
    // `<a href="javascript:…">js</a>`: o `href` sai e o `<a>` também (só o texto fica).
    expect(root.querySelector('details p')?.textContent).toContain(' js');
    expect(root.querySelector('kbd')?.textContent).toBe('Ctrl');
    expect(root.querySelector('mark a')?.getAttribute('href')).toBe('outra.md');
    expect(root.querySelector('p br')).not.toBeNull();
    expect(root.querySelector('b')?.attributes).toHaveLength(0);
    // `<i>solta.` sem fechamento: texto escapado; `<script>`: some (nada exibível; D-R7-S10-03).
    expect(root.textContent).toContain('<i>solta.');
    expect(root.querySelector('i')).toBeNull();
    expect(html).not.toMatch(/<script|alert\(1\)<\/script/);
    expect([...root.querySelectorAll('summary')].map((s) => s.textContent)).toEqual([
      'S',
      'Detalhes',
    ]);
  });

  it('<img> do vault dentro do HTML: data: do mapa (bloco e em linha); fora do mapa/remota → alt', async () => {
    const html = await body(
      [
        '<p><img src="../img/a.png" alt="vault"> <img src="img/falta.png" alt="ausente"> <img src="https://evil.example/x.png" alt="remota"></p>',
        '',
        'Em linha <img src="../img/a.png" alt="inline"> fim.',
      ].join('\n'),
      IDENTITY,
      images({ 'img/a.png': PNG }),
    );
    const root = dom(html);
    expect([...root.querySelectorAll('img')].map((i) => [i.alt, i.getAttribute('src')])).toEqual([
      ['vault', PNG],
      ['inline', PNG],
    ]);
    expect([...root.querySelectorAll('.smd-img-alt')].map((s) => s.textContent)).toEqual([
      'ausente',
      'remota',
    ]);
    expect(html).not.toContain('evil.example');
    expect(html).not.toContain('#smd-img-');
  });

  it('a marca das imagens não é adivinhável pelo texto da nota', async () => {
    const html = await body(
      '<p><img src="../img/a.png" alt="a"> #smd-img-00000000000000000000000000000000-0</p>',
      IDENTITY,
      images({ 'img/a.png': PNG }),
    );
    expect(html).toContain('#smd-img-00000000000000000000000000000000-0');
    expect(dom(html).querySelector('img')?.getAttribute('src')).toBe(PNG);
  });

  it('pós-checagem recusa (normalize → null ou saída insegura) → fonte escapada, como no r2', async () => {
    const refuse: ExportSanitizer = { policy, normalize: () => null };
    const block = dom(await body('<p>bloco</p>\n\nlinha <b>x</b> fim', refuse));
    expect(block.querySelector('p.smd-raw')?.textContent).toBe('<p>bloco</p>');
    expect(block.textContent).toContain('<b>x</b>');
    expect(block.querySelector('b')).toBeNull();
    const unsafe: ExportSanitizer = {
      policy,
      normalize: (h) => `${h}<img src=x onerror=alert(1)>`,
    };
    const html = await body('<p>bloco</p>', unsafe);
    expect(dom(html).querySelector('p.smd-raw')?.textContent).toBe('<p>bloco</p>');
  });

  it('sem sanitizador (núcleo puro): HTML cru continua texto (r2 D-15)', async () => {
    const { bodyHtml: html } = await renderExportBody('<p>x</p>\n\na <b>y</b>', {
      renderers: {},
      mode: 'file',
      images: images({}),
    });
    const root = dom(html);
    expect(root.querySelector('p.smd-raw')?.textContent).toBe('<p>x</p>');
    expect(root.querySelector('b')).toBeNull();
  });

  it('<details> com linha em branco: três blocos; o </details> solto fica cru, como no editor', async () => {
    const root = dom(await body('<details>\n<summary>S</summary>\n\ncorpo\n\n</details>\n'));
    expect(root.querySelector('details summary')?.textContent).toBe('S');
    expect(root.querySelector('p:not(.smd-raw)')?.textContent).toBe('corpo');
    expect(root.querySelector('p.smd-raw')?.textContent).toBe('</details>');
  });

  it('HTML em linha dentro de lista e citação também passa pela política', async () => {
    const root = dom(await body('> <mark>citado</mark>\n\n- <kbd>K</kbd>\n'));
    expect(root.querySelector('blockquote mark')?.textContent).toBe('citado');
    expect(root.querySelector('li kbd')?.textContent).toBe('K');
  });

  it('bloco HTML aninhado (citação/lista) sai como fonte, como no editor (CR-S10-01)', async () => {
    const root = dom(
      await body('> <div><b>q</b></div>\n\n- <div><b>l</b></div>\n\n<div><b>top</b></div>\n'),
    );
    expect(root.querySelector('blockquote .smd-raw')?.textContent).toBe('<div><b>q</b></div>');
    expect(root.querySelector('li .smd-raw')?.textContent).toBe('<div><b>l</b></div>');
    expect([...root.querySelectorAll('b')].map((b) => b.textContent)).toEqual(['top']);
  });

  it('elemento de fluxo em linha deixa o grupo cru, como no editor (CR-S10-03)', async () => {
    const root = dom(
      await body(
        'x <table width="9999%" height="9999"><tr><td>t</td></tr></table> y\n\nx <div>bloco</div> y\n',
      ),
    );
    expect(root.querySelector('table, div')).toBeNull();
    expect(root.textContent).toContain('<table width="9999%" height="9999">');
    expect(root.textContent).toContain('<div>bloco</div>');
  });

  it('grupo em linha sem nada exibível fica cru, como no editor (CR-S10-02)', async () => {
    const root = dom(await body('a <span></span> b <img src="https://evil.example/x.png"> c\n'));
    expect(root.textContent).toBe('a <span></span> b <img src="https://evil.example/x.png"> c');
    expect(root.querySelector('span, img')).toBeNull();
  });

  it('<a> relativo que sai do vault vira só o texto (S10-SEC-06)', async () => {
    const root = dom(
      await body(
        '<p><a href="../../../../etc/passwd">p</a> <a href="../outra.md">o</a></p>\n\nx <a href="%2e%2e/%2e%2e/etc/passwd">q</a> y\n',
      ),
    );
    expect([...root.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      '../outra.md',
    ]);
    expect(root.textContent).toContain('p o');
    expect(root.textContent).toContain('x q y');
  });
});

describe('Q-R7-F06 pré-passada das imagens com o HTML cru', () => {
  it('na ordem do documento, sem repetição; esquemas, `:` e fora do vault ficam de fora', () => {
    const doc = [
      '![a](a.png)',
      '<p><img src="b.png" alt="b"><img src="https://x.org/r.png"><IMG SRC=\'c.png\'></p>',
      'texto <img src=d.png> e <img alt="x" src="&#46;/e.png">',
      '<img src="data:image/png;base64,AA"> <img src="../../fora.png"> <img src="x:y.png">',
      '![a de novo](a.png)',
      '```html',
      '<img src="no-codigo.png">',
      '```',
      '<!-- <img src="comentario.png"> -->',
    ].join('\n\n');
    expect(collectExportImages(doc, 'n.md')).toEqual(['a.png', 'b.png', 'c.png', 'd.png', 'e.png']);
  });
});
