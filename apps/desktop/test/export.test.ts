// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import '../../../packages/plugins-internal/test/setup-svg';
import { createHash } from 'node:crypto';
import exportFixture from '@simplemd/plugins-internal/fixtures/export-fixture.md?raw';
import { loadMermaid } from '@simplemd/plugins-internal/mermaid/render';
import { lightTokens } from '@simplemd/themes';
import { MEMORY_ROOT } from '@simplemd/vault/testing';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { useBuiltinCommands } from '../src/app/useBuiltinCommands';
import { EXPORT_TEXT } from '../src/export/controller';
import { exportHtml, markdownBytes } from '../src/export/pipeline';
import { PRINT_FONTS_TIMEOUT_MS } from '../src/export/print-fonts';
import { setup, type Harness } from './helpers';

const sha = (bytes: Uint8Array | null | undefined) =>
  bytes ? createHash('sha256').update(bytes).digest('hex') : null;
const encoder = new TextEncoder();
const ALL_ON = () => true;

/** Bytes entregues ao `saveTarget.write` na última exportação. */
const lastWrite = (h: Harness) => h.platform.saveTarget.write.mock.calls.at(-1)?.[1];

async function exportMarkdown(h: Harness, strip: boolean): Promise<Uint8Array | undefined> {
  h.app.exporter.start('md');
  expect(h.app.store.getState().exportOptions).not.toBeNull();
  await h.app.exporter.chooseMarkdown(strip);
  return lastWrite(h);
}

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

beforeAll(async () => {
  await loadMermaid();
  // O jsdom não tem `document.fonts` (a impressão carrega as fontes da raiz antes do painel).
  Object.defineProperty(document, 'fonts', {
    value: { ready: Promise.resolve(), load: async () => [] },
    configurable: true,
  });
}, 30_000);

afterEach(() => {
  document.getElementById('smd-print-root')?.remove();
});

describe('AC-10.1 — .md limpo = os bytes que salvar grava', () => {
  const FM = '---\ntitle: Nota\ntags: [a]\n---\n\n';

  test('arquivo LF limpo: sha256 igual ao arquivo; "Sem front matter" tira só o bloco + 1 linha', async () => {
    const text = `${FM}# Nota\n\nCorpo.\n`;
    const h = await setup({ 'lf.md': text });
    await h.app.sync.openFile('lf.md');
    const full = await exportMarkdown(h, false);
    expect(sha(full)).toBe(sha(h.port.readBytes('lf.md')));
    const stripped = await exportMarkdown(h, true);
    expect(new TextDecoder().decode(stripped)).toBe('# Nota\n\nCorpo.\n');
    // A diferença é exatamente o prefixo do front matter e a linha em branco.
    expect(sha(stripped)).toBe(sha(full!.slice(encoder.encode(FM).length)));
  });

  test('CRLF + BOM: bytes iguais ao arquivo; sem front matter o BOM e o CRLF ficam', async () => {
    const raw = `\uFEFF${FM}# T\n\nx\n`.replace(/\n/g, '\r\n');
    const h = await setup({ 'crlf.md': raw });
    await h.app.sync.openFile('crlf.md');
    const full = await exportMarkdown(h, false);
    expect(sha(full)).toBe(sha(h.port.readBytes('crlf.md')));
    const stripped = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
      await exportMarkdown(h, true),
    );
    expect(stripped).toBe('\uFEFF# T\r\n\r\nx\r\n');
  });

  test('buffer não salvo: a exportação = o que o salvamento grava depois', async () => {
    const h = await setup({ 'n.md': '# N\r\n\r\ntexto\r\n' });
    await h.app.sync.openFile('n.md');
    h.type('n.md', 'mais\n');
    const exported = await exportMarkdown(h, false);
    const writes = h.writes();
    expect(writes).toBe(0); // regra 1: exportar não grava a nota
    await h.app.sync.flush('n.md');
    expect(sha(exported)).toBe(sha(h.port.readBytes('n.md')));
  });

  test('sem front matter a opção não muda nada', async () => {
    const h = await setup({ 'p.md': '# P\n\n---\nnão é front matter\n---\n' });
    await h.app.sync.openFile('p.md');
    expect(h.app.store.getState().exportOptions).toBeNull();
    const full = await exportMarkdown(h, false);
    expect(h.app.store.getState().exportOptions).toBeNull();
    h.app.exporter.start('md');
    expect(h.app.store.getState().exportOptions?.hasFrontMatter).toBe(false);
    await h.app.exporter.chooseMarkdown(true);
    expect(sha(lastWrite(h))).toBe(sha(full));
    expect(sha(markdownBytes('a\n', { eol: '\n', bom: false, mixed: false }, true))).toBe(
      sha(encoder.encode('a\n')),
    );
  });

  test('nome sugerido <basename>.md, origem = a nota; sucesso → STR-119 com o nome', async () => {
    const h = await setup({ 'pasta/receita.md': '# R\n' });
    await h.app.sync.openFile('pasta/receita.md');
    await exportMarkdown(h, false);
    expect(h.platform.saveTarget.pick).toHaveBeenLastCalledWith({
      suggestedName: 'receita.md',
      ext: 'md',
      sourceRel: 'pasta/receita.md',
    });
    const notice = h.app.store.getState().notices.at(-1);
    expect(notice).toMatchObject({ notice: 'export-done', kind: 'info' });
    expect(notice?.text).toBe(EXPORT_TEXT.done('receita.md'));
    expect(h.app.store.getState().exportOptions).toBeNull();
  });
});

describe('AC-10.2 — o próprio arquivo de origem é recusado com 0 gravações', () => {
  const refuse = (h: Harness) =>
    h.platform.saveTarget.pick.mockRejectedValue({ code: 'SAME_AS_SOURCE', message: 'x' });

  test('Markdown: alerta STR-117 no L7, L7 continua aberto, 0 gravações, sha e mtime iguais', async () => {
    const h = await setup({ 'a.md': '---\nt: 1\n---\n# A\n' });
    await h.app.sync.openFile('a.md');
    const stat = () => h.port.lstat(`${MEMORY_ROOT}/a.md`);
    const before = { sha: sha(h.port.readBytes('a.md')), stat: await stat() };
    expect(before.stat?.mtime).toBeTypeOf('number');
    refuse(h);
    h.app.exporter.start('md');
    await h.app.exporter.chooseMarkdown(true);
    expect(h.app.store.getState().exportOptions).toEqual({
      hasFrontMatter: true,
      error: 'Escolha outro nome: este é o arquivo de origem.',
      picking: false,
    });
    expect(h.platform.saveTarget.write).not.toHaveBeenCalled();
    expect(h.writes()).toBe(0);
    expect(sha(h.port.readBytes('a.md'))).toBe(before.sha);
    expect(await stat()).toEqual(before.stat);
  });

  test('HTML: aviso de erro export-refused com STR-117; 0 gravações', async () => {
    const h = await setup({ 'a.md': '# A\n' });
    await h.app.sync.openFile('a.md');
    refuse(h);
    await h.app.exporter.exportHtml();
    expect(h.app.store.getState().notices.at(-1)).toMatchObject({
      kind: 'error',
      notice: 'export-refused',
      text: 'Escolha outro nome: este é o arquivo de origem.',
    });
    expect(h.platform.saveTarget.write).not.toHaveBeenCalled();
    expect(h.writes()).toBe(0);
  });

  test('cancelar o diálogo: L7 continua (silencioso); falha de gravação → STR-120', async () => {
    const h = await setup({ 'a.md': '# A\n' });
    await h.app.sync.openFile('a.md');
    h.platform.saveTarget.pick.mockResolvedValueOnce(null);
    h.app.exporter.start('md');
    await h.app.exporter.chooseMarkdown(false);
    expect(h.app.store.getState().exportOptions).toMatchObject({ error: null, picking: false });
    expect(h.app.store.getState().notices).toEqual([]);
    h.platform.saveTarget.write.mockRejectedValueOnce({ code: 'PERMISSION_DENIED' });
    await h.app.exporter.chooseMarkdown(false);
    expect(h.app.store.getState().notices.at(-1)).toMatchObject({
      kind: 'error',
      notice: 'export-failed',
      text: 'Sem permissão para gravar em “a.md”.',
    });
    expect(h.app.store.getState().exportBusy).toBe(false);
  });
});

describe('AC-10.3 / AC-10.5 — HTML autocontido e seguro', () => {
  test('export-fixture.md com os renderizadores reais (Mermaid, KaTeX, calc)', async () => {
    // RG-R7-2 (D-32, AC-EX.1): a imagem do vault sai pelo mapa do app como `data:` (antes: o `src`
    // relativo como escrito no arquivo).
    const logo = 'data:image/png;base64,iVBORw0KGgo=';
    const images = {
      notePath: 'export-fixture.md',
      map: new Map([['imagens/logo.png', { src: logo }]]),
    };
    const html = await exportHtml(exportFixture, 'export-fixture.md', ALL_ON, images);
    const doc = parse(html);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(doc.documentElement.getAttribute('lang')).toBe('pt-BR');
    expect(doc.querySelector('meta[charset]')?.getAttribute('charset')).toBe('utf-8');
    // APPSEC-R2-09 (AC-B12.9): uma CSP em <meta>, com o texto fixado pela AppSec.
    const csp = doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
    expect(csp.length).toBe(1);
    expect(csp[0]?.getAttribute('content')).toBe(
      "default-src 'none'; img-src * file: data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'",
    );
    expect(doc.title).toBe('Exportação');
    expect(doc.querySelector('h1')?.textContent).toBe('Exportação');
    expect(doc.querySelector('em')?.textContent).toBe('itálico');
    expect(doc.querySelector('strong')?.textContent).toBe('negrito');
    expect(doc.querySelector('a[href="https://example.com"]')?.textContent).toBe('link seguro');
    expect(doc.querySelectorAll('ul > li').length).toBe(2);
    expect(doc.querySelectorAll('ol > li').length).toBe(2);
    expect(doc.querySelector('pre code')?.textContent).toBe('<b>negrito em código</b>\n'.trimEnd());
    expect(html).toContain('&lt;b&gt;negrito em código&lt;/b&gt;');
    const aligned = [...doc.querySelectorAll('th')].map((th) => th.getAttribute('style'));
    expect(aligned).toEqual(
      expect.arrayContaining(['text-align: left', 'text-align: center', 'text-align: right']),
    );
    // Mermaid como <svg> em linha com os rótulos dos nós (texto SVG real: htmlLabels false).
    const svgs = doc.querySelectorAll('figure.smd-mermaid > svg');
    expect(svgs.length).toBe(3);
    expect(svgs[0]?.getAttribute('role')).toBe('img');
    expect(svgs[0]?.textContent).toContain('Rascunho');
    expect(svgs[0]?.textContent).toContain('Publicado');
    expect(svgs[0]?.querySelector('foreignObject')).toBeNull();
    // KaTeX com MathML; calc como texto (`=2+3` → 5).
    expect(doc.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(20);
    expect(doc.querySelector('.katex math')).not.toBeNull();
    expect(doc.querySelectorAll('.katex-display').length).toBe(2);
    const calc = [...doc.querySelectorAll('.smd-calc')].map((el) => el.textContent);
    expect(calc[0]).toBe('5');
    expect(calc).toContain('divisão por zero');
    // Front matter fora; javascript: vira texto; 0 script/on*. r7 I-10 (AC-I10.5, supera D-15): a
    // linha de HTML cru sai renderizada pela política única (o `<b>` sem `onclick`); o bloco
    // `<script>` não tem nada exibível e some.
    expect(doc.body.textContent).not.toContain('author: Fixture');
    expect(doc.querySelector('a[href^="javascript"]')).toBeNull();
    expect(doc.body.textContent).toContain('Um link perigoso: clique.');
    expect(doc.body.textContent).not.toContain('alert(1)');
    const raw = [...doc.querySelectorAll('b')].find((b) =>
      b.textContent?.includes('HTML cru que deve aparecer como texto'),
    );
    expect(raw?.attributes).toHaveLength(0);
    expect(html.match(/<script/gi)).toBeNull();
    const attrs = [...doc.querySelectorAll('*')].flatMap((el) =>
      [...el.attributes].map((a) => a.name),
    );
    expect(attrs.filter((name) => /^on[a-z]+$/.test(name))).toEqual([]);
    // Nenhuma referência http(s) fora dos links e imagens do próprio usuário.
    const external = [
      ...html.matchAll(/(?:href|src)="(https?:[^"]*)"|url\((['"]?)(https?:[^)'"]*)\2\)|@import/gi),
    ].map((m) => m[1] ?? m[3] ?? m[0]);
    expect(external).toEqual(['https://example.com']);
    expect(doc.querySelector('img')?.getAttribute('src')).toBe(logo);
    expect(doc.querySelector('img')?.getAttribute('alt')).toBe('Logotipo do simpleMD');
    // Fora do mapa (arquivo ausente ou recusado): só o texto alternativo, nenhum `src` relativo.
    const bare = parse(await exportHtml(exportFixture, 'export-fixture.md', ALL_ON));
    expect(bare.querySelector('img[src="imagens/logo.png"]')).toBeNull();
    expect(bare.body.textContent).toContain('Logotipo do simpleMD');
    // Uma folha: tokens claros (valores de tokens.css) + KaTeX com fontes data: (há fórmula).
    const styles = doc.head.querySelectorAll('style');
    expect(styles.length).toBe(1);
    // Os outros `<style>` são os internos de cada SVG do Mermaid (seletores pelo id do diagrama).
    expect(doc.querySelectorAll('style').length).toBe(1 + svgs.length);
    const css = styles[0]?.textContent ?? '';
    expect(css).toContain(`--color-bg:${lightTokens['--color-bg']}`);
    expect(css).toMatch(
      /@font-face\{[^}]*font-family:KaTeX_Main[^}]*url\(data:font\/woff2;base64,/,
    );
    expect(css).not.toMatch(/url\(fonts\//);
  }, 60_000);

  test('AC-10.5: sem fórmula nem Mermaid → 0 @font-face data: e CSS ≤ 30 KB', async () => {
    const html = await exportHtml('# Simples\n\nTexto e =2+3.\n', 'simples.md', ALL_ON);
    const css = parse(html).querySelector('style')?.textContent ?? '';
    expect(css).not.toContain('@font-face');
    expect(css).not.toContain('data:');
    expect(new TextEncoder().encode(css).length).toBeLessThanOrEqual(30 * 1024);
    expect(parse(html).title).toBe('Simples');
  });

  test('plugin interno desligado → conteúdo cru, como no editor (R-10.4)', async () => {
    const off = (id: string) => id !== 'simplemd.calc' && id !== 'simplemd.mermaid';
    const doc = parse(
      await exportHtml('=2+3 e $x$\n\n```mermaid\nflowchart LR\n  A-->B\n```\n', 'x.md', off),
    );
    expect(doc.body.textContent).toContain('=2+3');
    expect(doc.querySelector('.katex')).not.toBeNull();
    expect(doc.querySelector('svg')).toBeNull();
    expect(doc.querySelector('pre code.language-mermaid')?.textContent).toContain('A-->B');
  });

  test('CR3-B1: texto que só menciona url( ou @import (rótulo, \\text{}, fatia) continua renderizado', async () => {
    const doc = parse(
      await exportHtml(
        [
          '# Nota',
          '',
          '```mermaid',
          'flowchart LR',
          '  A["veja url(a)"]-->B',
          '```',
          '',
          '$\\text{url(a)}$',
          '',
          '```mermaid',
          'pie title Regras',
          '  "@import x" : 1',
          '  "outra" : 2',
          '```',
          '',
        ].join('\n'),
        'nota.md',
        ALL_ON,
      ),
    );
    const svgs = doc.querySelectorAll('figure.smd-mermaid > svg');
    expect(svgs).toHaveLength(2);
    expect(svgs[0]?.textContent).toContain('veja url(a)');
    expect(svgs[1]?.textContent).toContain('@import x');
    expect(doc.querySelector('.katex')?.textContent).toContain('url(a)');
    expect(doc.querySelector('pre code')).toBeNull();
  }, 60_000);
});

describe('R-10.1 / AC-10.10 — entradas e PDF pela impressão', () => {
  test('sem aba: motivo STR-115; sem pasta: "Abra uma pasta primeiro."; Mod-P sem aba = aviso, 0 impressões', async () => {
    const closed = await setup({ 'a.md': '# A\n' }, { open: false });
    expect(closed.app.exporter.enabled()).toEqual({ reason: 'Abra uma pasta primeiro.' });
    const h = await setup({ 'a.md': '# A\n' });
    expect(h.app.exporter.enabled()).toEqual({ reason: 'Abra uma nota para exportar.' });
    h.app.exporter.start('pdf');
    await Promise.resolve();
    expect(h.platform.print).not.toHaveBeenCalled();
    expect(h.app.store.getState().notices.at(-1)).toMatchObject({
      kind: 'info',
      text: 'Abra uma nota para exportar.',
    });
    await h.app.sync.openFile('a.md');
    expect(h.app.exporter.enabled()).toBe(true);
  });

  test('PDF: raiz de impressão com o conteúdo e os tokens claros; 1 impressão; marca NFR-32; foco volta', async () => {
    const root = document.body.appendChild(document.createElement('div'));
    root.id = 'smd-print-root';
    const invoker = document.body.appendChild(document.createElement('button'));
    invoker.focus();
    const h = await setup({
      'p.md': '---\nt: 1\n---\n# Título\n\n![alt da imagem](x.png) e =2+3\n',
    });
    await h.app.sync.openFile('p.md');
    let printing: string | undefined;
    h.platform.print.mockImplementationOnce(async () => {
      printing = document.documentElement.dataset.printing;
      invoker.blur();
    });
    await h.app.exporter.exportPdf();
    expect(h.platform.print).toHaveBeenCalledTimes(1);
    expect(printing).toBe('');
    expect(document.documentElement.dataset.printing).toBeUndefined();
    expect(h.platform.log).toHaveBeenCalledWith('simplemd:export-print');
    expect(root.querySelector('h1')?.textContent).toBe('Título');
    expect(root.textContent).toContain('alt da imagem');
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).not.toContain('t: 1');
    expect(root.style.getPropertyValue('--color-bg')).toBe(lightTokens['--color-bg']);
    expect(document.activeElement).toBe(invoker);
    expect(h.app.store.getState().exportBusy).toBe(false);
    // Sem aviso de sucesso (o app não sabe se o usuário salvou).
    expect(h.app.store.getState().notices).toEqual([]);
    expect(h.writes()).toBe(0);
    // Trocar de aba esvazia a visualização de impressão.
    h.app.store.setState({ activeId: null });
    expect(root.childElementCount).toBe(0);
  });

  test('falha ao abrir a impressão → STR-121 (aviso de erro)', async () => {
    document.body.appendChild(document.createElement('div')).id = 'smd-print-root';
    const h = await setup({ 'p.md': '# P\n' });
    await h.app.sync.openFile('p.md');
    h.platform.print.mockRejectedValueOnce(new Error('negado'));
    await h.app.exporter.exportPdf();
    expect(h.app.store.getState().notices.at(-1)).toMatchObject({
      kind: 'error',
      notice: 'print-failed',
      text: 'Não foi possível abrir a impressão.',
    });
  });

  /** `document.fonts` do teste com o `load` dado; devolve o desfazer. */
  function stubFonts(load: () => Promise<FontFace[]>): () => void {
    const fonts = document.fonts;
    Object.defineProperty(document, 'fonts', {
      value: { ready: Promise.resolve(), load },
      configurable: true,
    });
    return () => Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
  }

  test('W-02 (AC-W02.5): o painel só abre depois de carregar as fontes da raiz de impressão', async () => {
    document.body.appendChild(document.createElement('div')).id = 'smd-print-root';
    const loaded = Promise.withResolvers<FontFace[]>();
    const load = vi.fn(() => loaded.promise);
    const restore = stubFonts(load);
    try {
      const h = await setup({ 'm.md': '# M\n\n$a^2$\n' });
      await h.app.sync.openFile('m.md');
      const done = h.app.exporter.exportPdf();
      await vi.waitFor(() => expect(load).toHaveBeenCalled());
      // A face do KaTeX que só a raiz de impressão usa (`$a^2$`: o `a` em KaTeX_Math itálico).
      expect(load.mock.calls).toContainEqual(['italic 400 16px KaTeX_Math', 'a']);
      expect(h.platform.print).not.toHaveBeenCalled();
      expect(h.platform.log).not.toHaveBeenCalledWith('simplemd:export-print');
      loaded.resolve([]);
      await done;
      expect(h.platform.print).toHaveBeenCalledTimes(1);
      expect(h.platform.log).toHaveBeenCalledWith('simplemd:export-print');
    } finally {
      restore();
    }
  });

  test('AC-W02.7: fonte que nunca carrega → o painel abre após PRINT_FONTS_TIMEOUT_MS', async () => {
    document.body.appendChild(document.createElement('div')).id = 'smd-print-root';
    const called = Promise.withResolvers<void>();
    const restore = stubFonts(() => {
      called.resolve();
      return new Promise<FontFace[]>(() => {});
    });
    try {
      const h = await setup({ 'm.md': '# M\n\n$a^2$\n' });
      await h.app.sync.openFile('m.md');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const done = h.app.exporter.exportPdf();
      await called.promise;
      await vi.advanceTimersByTimeAsync(PRINT_FONTS_TIMEOUT_MS - 1);
      expect(h.platform.print).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(h.platform.print).toHaveBeenCalledTimes(1);
      expect(h.platform.log).toHaveBeenCalledWith('simplemd:export-print');
    } finally {
      vi.useRealTimers();
      restore();
    }
  });

  test('AC-W02.7: face que falha ao carregar → o painel abre assim mesmo, sem STR-121', async () => {
    document.body.appendChild(document.createElement('div')).id = 'smd-print-root';
    const load = vi.fn(() => Promise.reject(new DOMException('falhou', 'NetworkError')));
    const restore = stubFonts(load);
    try {
      const h = await setup({ 'm.md': '# M\n\n$a^2$\n' });
      await h.app.sync.openFile('m.md');
      await h.app.exporter.exportPdf();
      expect(load).toHaveBeenCalled();
      expect(h.platform.print).toHaveBeenCalledTimes(1);
      expect(h.app.store.getState().notices).toEqual([]);
    } finally {
      restore();
    }
  });

  test('paleta: os 3 comandos export:* com Mod-P no PDF e o motivo sem aba', async () => {
    const h = await setup({ 'a.md': '# A\n' });
    renderHook(() => useBuiltinCommands(h.app, { current: null }));
    const commands = h.app.plugins.commands.getSnapshot().filter((c) => c.id.startsWith('export:'));
    expect(commands.map((c) => [c.id, c.title, c.hotkey])).toEqual([
      ['export:md', 'Exportar como Markdown…', undefined],
      ['export:html', 'Exportar como HTML…', undefined],
      ['export:pdf', 'Exportar como PDF…', 'Mod-p'],
    ]);
    expect(commands.map((c) => c.isEnabled?.())).toEqual(
      Array(3).fill({ reason: 'Abra uma nota para exportar.' }),
    );
  });
});
