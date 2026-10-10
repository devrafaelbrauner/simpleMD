import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * AC-10.8 — critério 4 no motor do WebView2 (CI; product §4.4 P3; arch-backend r2 §1.6):
 * 1. o HTML da exportação de `export-fixture.md` sai do código de PRODUÇÃO (`exportHtml` do
 *    harness = `src/export/pipeline.ts` com os plugins internos ligados);
 * 2. aberto num contexto SEM rede e impresso em A4 com mídia de impressão pelo canal escolhido
 *    (`msedge` no `windows-latest`: o Chromium do WebView2);
 * 3. PDF > 0 bytes e a camada de texto (pdfjs) tem as sentinelas: célula de tabela, o `5` do
 *    calc, rótulos do Mermaid (texto SVG real: `htmlLabels: false`);
 * 4. `build/export-pdf/` guarda `export.pdf`, `export.pdf.sha256`, o HTML e o navegador usado.
 * A impressão DENTRO do app no WebView2 continua NÃO TESTADA (AC-10.9).
 */
const OUT = fileURLToPath(new URL('../../../build/export-pdf/', import.meta.url));
const FIXTURE = readFileSync(
  new URL('../../../packages/plugins-internal/test/fixtures/export-fixture.md', import.meta.url),
  'utf8',
);

/** Texto de todas as páginas, na ordem da camada de texto. */
async function pdfText(bytes: Uint8Array): Promise<{ pages: number; text: string }> {
  // Cópia: o pdfjs transfere (esvazia) o buffer que recebe.
  const pdf = await getDocument({ data: bytes.slice() }).promise;
  const parts: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    for (const item of content.items) if ('str' in item) parts.push(item.str);
  }
  return { pages: pdf.numPages, text: parts.join(' ').replace(/\s+/g, ' ') };
}

test('AC-10.8: export HTML de produção → PDF A4 com Mermaid, KaTeX, tabela e calc', async ({
  page,
  browser,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__simplemdHarness !== undefined);
  const html = await page.evaluate(
    (markdown) => window.__simplemdHarness.exportHtml(markdown),
    FIXTURE,
  );
  expect(html.match(/<script/gi)).toBeNull();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}export.html`, html);

  const offline = await browser.newContext({ offline: true });
  const print = await offline.newPage();
  await print.goto(pathToFileURL(`${OUT}export.html`).href);
  await print.evaluate(() => document.fonts.ready);
  expect(await print.evaluate(() => document.fonts.check('16px KaTeX_Main'))).toBe(true);
  expect(await print.locator('figure.smd-mermaid svg').count()).toBe(3);
  await print.emulateMedia({ media: 'print' });
  await print.screenshot({ path: `${OUT}export-print-media.png`, fullPage: true });
  const pdf = new Uint8Array(await print.pdf({ format: 'A4', preferCSSPageSize: true }));
  await offline.close();

  expect(pdf.byteLength).toBeGreaterThan(0);
  const sha = createHash('sha256').update(pdf).digest('hex');
  writeFileSync(`${OUT}export.pdf`, pdf);
  writeFileSync(`${OUT}export.pdf.sha256`, `${sha}  export.pdf\n`);

  const { pages, text } = await pdfText(pdf);
  writeFileSync(
    `${OUT}export.pdf.txt`,
    `browser: ${browser.browserType().name()} ${browser.version()} (canal: ${process.env.SIMPLEMD_PDF_CHANNEL ?? 'chromium do Playwright'})\n` +
      `bytes: ${pdf.byteLength}\nsha256: ${sha}\npáginas: ${pages}\n\n${text}\n`,
  );
  // Sentinelas: célula de tabela, o resultado de `=2+3` e rótulos do diagrama Mermaid.
  expect(text).toContain('só uma coluna');
  expect(text).toMatch(/Cálculos: 5 2 4/);
  expect(text).toContain('Rascunho');
  expect(text).toContain('Publicado');
  // r7 I-10 (AC-I10.5, supera D-15): HTML cru pela política única — o `<b>` sai como texto
  // renderizado, o bloco `<script>` some; o front matter fora.
  expect(text).toContain('HTML cru que deve aparecer como texto');
  expect(text).not.toContain('alert(1)');
  expect(text).not.toContain('author: Fixture');
});
