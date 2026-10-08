import { expect, test } from '@playwright/test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * W-04 / F-WIN-05 — o painel do WebView2 imprime o cabeçalho e o rodapé do Chromium (data, título,
 * URL `tauri.localhost`, n/N) na margem da página. Com `displayHeaderFooter` ligado (o equivalente do
 * `printToPDF`), o PDF da visualização de impressão tem exatamente as mesmas palavras, na mesma
 * ordem e página, que sem ele; A4, 2 páginas e o texto a 20 mm da borda, como antes.
 */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

async function words(bytes: Uint8Array) {
  const pdf = await getDocument({ data: bytes.slice() }).promise;
  const items: { page: number; str: string; x: number; y: number }[] = [];
  let view: number[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    view = page.view;
    for (const item of (await page.getTextContent()).items)
      if ('str' in item && item.str.trim() !== '')
        items.push({ page: n, str: item.str, x: item.transform[4], y: item.transform[5] });
  }
  return { pages: pdf.numPages, view, items };
}

test('W-04: sem cabeçalho/rodapé do Chromium; A4, 2 páginas, 20 mm', async ({ page }) => {
  await page.goto('/?vault=FX-EXPORT');
  await page.getByRole('treeitem', { name: /export-fixture\.md/ }).click();
  await page.locator('.cm-content').waitFor();
  await page.evaluate(() => {
    window.__simplemdHarness.print.mode = 'hold';
  });
  await page.locator('.cm-content').click();
  await page.keyboard.press(`${MOD}+p`);
  await expect.poll(() => page.evaluate(() => window.__simplemdHarness.print.calls())).toBe(1);
  const opts = { format: 'A4', preferCSSPageSize: true } as const;
  const withUa = await words(
    new Uint8Array(await page.pdf({ ...opts, displayHeaderFooter: true })),
  );
  const plain = await words(new Uint8Array(await page.pdf(opts)));
  const text = withUa.items.map((i) => i.str).join(' ');
  expect(text).not.toContain('localhost');
  expect(text).not.toMatch(/\b[12]\/2\b/);
  expect(withUa.items.map((i) => `${i.page}|${i.str}`)).toEqual(
    plain.items.map((i) => `${i.page}|${i.str}`),
  );
  expect(withUa.pages).toBe(2);
  expect(withUa.view[2]).toBeCloseTo(594.96, 1);
  expect(withUa.view[3]).toBeCloseTo(841.92, 1);
  // 20 mm = 56,69 pt (o Chromium arredondava a margem para 76 px = 57 pt; o padding não arredonda).
  const first = withUa.items[0]!;
  expect(first.str).toBe('Exportação');
  expect(first.x).toBeGreaterThan(56.2);
  expect(first.x).toBeLessThan(57.2);
  await page.evaluate(() => window.__simplemdHarness.print.release());
});
