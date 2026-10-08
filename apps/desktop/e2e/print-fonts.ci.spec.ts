import { expect, test, type Page } from '@playwright/test';

/**
 * W-02 / F-WIN-02 — impressão logo depois de abrir a nota, com as fórmulas fora da tela do editor:
 * a raiz de impressão fica `display: none` na tela, então só o layout de impressão pedia as faces do
 * KaTeX (`font-display: block`) e o instantâneo do painel saía sem os glifos. Com a impressão
 * segurada no momento de `platform.print()`, toda fonte usada na raiz já está carregada e, com as
 * fontes do KaTeX lentas (0,8 s), o primeiro quadro em mídia de impressão já tem os glifos.
 */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test.use({ viewport: { width: 1296, height: 839 } });

async function openAndHoldPrint(page: Page): Promise<void> {
  await page.goto('/?vault=FX-EXPORT');
  await page.getByRole('treeitem', { name: /export-fixture\.md/ }).click();
  await page.locator('.cm-content').waitFor();
  // Pré-condição do achado: nenhuma fórmula na tela do editor, nenhuma face do KaTeX pedida.
  expect(
    await page.evaluate(
      () =>
        [...document.fonts].filter((f) => f.family.startsWith('KaTeX_') && f.status !== 'unloaded')
          .length,
    ),
  ).toBe(0);
  await page.evaluate(() => {
    window.__simplemdHarness.print.mode = 'hold';
  });
  await page.locator('.cm-content').click();
  await page.keyboard.press(`${MOD}+p`);
  await expect.poll(() => page.evaluate(() => window.__simplemdHarness.print.calls())).toBe(1);
}

test('W-02: no pedido do painel, toda fonte da raiz de impressão (KaTeX, código) já carregou', async ({
  page,
}) => {
  await openAndHoldPrint(page);
  const state = await page.evaluate(() => {
    const root = document.getElementById('smd-print-root')!;
    const missing = new Set<string>();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || (node.nodeValue ?? '').trim() === '') continue;
      const s = getComputedStyle(el);
      if (
        !document.fonts.check(
          `${s.fontStyle} ${s.fontWeight} 16px ${s.fontFamily}`,
          node.nodeValue!,
        )
      )
        missing.add(s.fontFamily);
    }
    return {
      katex: root.querySelectorAll('.katex').length,
      missing: [...missing],
      loaded: [...document.fonts]
        .filter((f) => f.family.startsWith('KaTeX_') && f.status === 'loaded')
        .map((f) => f.family),
    };
  });
  expect(state.katex).toBe(20);
  expect(state.missing).toEqual([]);
  expect(state.loaded).toEqual(expect.arrayContaining(['KaTeX_Main', 'KaTeX_Math', 'KaTeX_Size1']));
  await page.evaluate(() => window.__simplemdHarness.print.release());
});

test('W-02: fontes do KaTeX lentas (0,8 s) → o primeiro quadro em mídia de impressão já tem os glifos', async ({
  page,
  context,
}) => {
  await page.route(/KaTeX_[^/]*\.woff2$/, async (route) => {
    const delay = Promise.withResolvers<void>();
    setTimeout(delay.resolve, 800);
    await delay.promise;
    await route.continue();
  });
  await openAndHoldPrint(page);
  // CDP direto: o `page.screenshot` do Playwright espera as fontes e esconderia a corrida.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
  const clip = await page.evaluate(() => {
    const r = document.querySelector('#smd-print-root .katex-display')!.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 };
  });
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip,
    captureBeyondViewport: true,
  });
  const dark = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = new OffscreenCanvas(img.width, img.height);
    const g = canvas.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, img.width, img.height).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i]! + px[i + 1]! + px[i + 2]! < 384) n++;
    return n;
  }, data);
  // `E = mc^2` com as fontes do KaTeX: ~155 px escuros; antes da correção, 0 (glifos invisíveis).
  expect(dark).toBeGreaterThan(50);
  await page.evaluate(() => window.__simplemdHarness.print.release());
});
