import { expect, test, type Page } from '@playwright/test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Visualização de impressão DENTRO do app com o tema escuro (R-10.5, D-19; achados S6-1/S6-2 da
 * QA no WKWebView): a página impressa é sempre clara — nada do tema escuro aparece em volta do
 * documento (fundo da tela, `color-scheme`, margens colapsadas) — e as listas mantêm os marcadores
 * apesar do reset de listas da folha do app. Roda no harness de produção com a impressão segurada
 * (`print.mode = 'hold'`) e imprime a página do app com `page.pdf` em mídia de impressão.
 */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

async function printDark(page: Page): Promise<void> {
  await page.goto('/?vault=FX-EXPORT');
  await page.getByRole('treeitem', { name: /export-fixture\.md/ }).click();
  await page.locator('.cm-content').waitFor();
  await page.keyboard.press(`${MOD}+,`);
  await page.getByLabel('Tema', { exact: true }).selectOption('simplemd-dark');
  const settings = page.getByRole('dialog', { name: 'Configurações' });
  await settings.getByRole('button', { name: 'Fechar' }).click();
  await settings.waitFor({ state: 'detached' });
  await page.evaluate(() => {
    window.__simplemdHarness.print.mode = 'hold';
  });
  await page.locator('.cm-content').click();
  await page.keyboard.press(`${MOD}+p`);
  await expect.poll(() => page.evaluate(() => window.__simplemdHarness.print.calls())).toBe(1);
  await page.emulateMedia({ media: 'print' });
}

test('S6-1: tema escuro → nada escuro em volta do documento impresso (canvas, margens, bordas)', async ({
  page,
}) => {
  await printDark(page);
  const styles = await page.evaluate(() => {
    const root = document.getElementById('smd-print-root')!;
    const html = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    const first = root.firstElementChild!;
    const last = root.lastElementChild!;
    const rect = root.getBoundingClientRect();
    return {
      theme: document.documentElement.dataset.themeBase,
      htmlScheme: html.colorScheme,
      bodyScheme: body.colorScheme,
      rootScheme: getComputedStyle(root).colorScheme,
      htmlBg: html.backgroundColor,
      bodyBg: body.backgroundColor,
      rootDisplay: getComputedStyle(root).display,
      rootBg: getComputedStyle(root).backgroundColor,
      // Margens dos filhos ficam DENTRO da raiz (nada colapsa para o canvas do documento).
      firstInside:
        first.getBoundingClientRect().top - parseFloat(getComputedStyle(first).marginTop) >=
        rect.top - 0.5,
      lastInside:
        last.getBoundingClientRect().bottom + parseFloat(getComputedStyle(last).marginBottom) <=
        rect.bottom + 0.5,
      rootTop: rect.top,
    };
  });
  expect(styles.theme).toBe('dark');
  expect(styles.htmlScheme).toBe('light');
  expect(styles.bodyScheme).toBe('light');
  expect(styles.rootScheme).toBe('light');
  expect(styles.htmlBg).toBe('rgba(0, 0, 0, 0)');
  expect(styles.bodyBg).toBe('rgba(0, 0, 0, 0)');
  expect(styles.rootDisplay).toBe('flow-root');
  expect(styles.rootBg).toBe('rgb(255, 255, 255)');
  expect(styles.firstInside).toBe(true);
  expect(styles.lastInside).toBe(true);
  expect(styles.rootTop).toBe(0);
  // A faixa acima do primeiro título é igual a uma faixa branca do meio da raiz (mesmos pixels).
  const h1 = await page.locator('#smd-print-root h1').first().boundingBox();
  expect(h1).not.toBeNull();
  const above = await page.screenshot({
    clip: { x: 0, y: 0, width: 400, height: Math.floor(h1!.y) },
  });
  const white = await page.screenshot({
    clip: { x: 0, y: h1!.y + h1!.height + 400, width: 400, height: Math.floor(h1!.y) },
  });
  expect(Math.floor(h1!.y)).toBeGreaterThan(4);
  expect(Buffer.compare(above, white)).toBe(0);
  const pdf = await page.pdf({ format: 'A4', preferCSSPageSize: true });
  expect(pdf.byteLength).toBeGreaterThan(0);
  await page.evaluate(() => window.__simplemdHarness.print.release());
});

test('S6-2: listas impressas mantêm marcadores (disc/decimal) e o recuo; o PDF tem os números', async ({
  page,
}) => {
  await printDark(page);
  const lists = await page.evaluate(() => {
    const root = document.getElementById('smd-print-root')!;
    const style = (sel: string) => {
      const el = root.querySelector(sel)!;
      const s = getComputedStyle(el);
      return {
        type: s.listStyleType,
        position: s.listStylePosition,
        pad: parseFloat(s.paddingInlineStart),
      };
    };
    return {
      ul: style('ul'),
      ol: style('ol'),
      li: getComputedStyle(root.querySelector('li')!).display,
    };
  });
  expect(lists.ul.type).toBe('disc');
  expect(lists.ol.type).toBe('decimal');
  expect(lists.ul.position).toBe('outside');
  expect(lists.ul.pad).toBeGreaterThan(8);
  expect(lists.ol.pad).toBeGreaterThan(8);
  expect(lists.li).toBe('list-item');
  const pdf = new Uint8Array(await page.pdf({ format: 'A4', preferCSSPageSize: true }));
  const doc = await getDocument({ data: pdf.slice() }).promise;
  const parts: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    for (const item of (await (await doc.getPage(n)).getTextContent()).items)
      if ('str' in item) parts.push(item.str);
  }
  const text = parts.join(' ').replace(/\s+/g, ' ');
  // Estrutura e texto do documento impresso (a casca não sai; o front matter também não).
  expect(text).toMatch(/1\. ?passo um/);
  expect(text).toMatch(/2\. ?passo dois/);
  expect(text).toContain('primeiro item');
  expect(text).toContain('Rascunho');
  expect(text).toMatch(/Cálculos: 5 2 4/);
  expect(text).not.toContain('author: Fixture');
  expect(text).not.toContain('Abrir pasta');
  await page.evaluate(() => window.__simplemdHarness.print.release());
});
