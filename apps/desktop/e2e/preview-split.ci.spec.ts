import { expect, test, type Page } from '@playwright/test';

/**
 * r38b (design-r38 §5 E1–E6; AC-R38-1..3): a prévia lado a lado no harness de produção, no
 * Chromium real. `Mod-Shift-D` abre a prévia ao lado do MESMO editor; digitar atualiza depois do
 * debounce sem gravar a nota; o divisor anda pelo teclado e pelo ponteiro e a proporção volta ao
 * reabrir a pasta; HTML perigoso não executa e os links passam pelo serviço único; abaixo de 900 px
 * a prévia fica indisponível com o motivo; a rolagem segue o último painel com gesto.
 */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const CONFIG = '.simplemd/config.json';

const host = (page: Page) => page.getByTestId('preview-host');
const separator = (page: Page) =>
  page.getByRole('separator', { name: 'Redimensionar editor e prévia' });

async function openNote(page: Page, vault: string, name: string): Promise<void> {
  await page.goto(`/?vault=${vault}`);
  await page.getByRole('treeitem', { name }).click();
  await page.locator('.cm-content').waitFor();
}

/** Abre a prévia pela tecla e espera a 1ª renderização inserida (blocos no host, sem `aria-busy`). */
async function togglePreview(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+Shift+D`);
  await expect(host(page).locator(':scope > .smd-preview-block').first()).toBeAttached();
  await expect(host(page)).not.toHaveAttribute('aria-busy', 'true');
}

const writes = (page: Page) =>
  page.evaluate(() =>
    window.__simplemdHarness
      .calls()
      .filter((call) => call.op === 'write')
      .map((call) => call.path),
  );

test('E1/E2 (AC-R38-1): FX-RICH ao lado do mesmo editor; digitar atualiza depois do debounce', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openNote(page, 'FX-RICH', 'rich.md');
  const views = await page.evaluate(() => window.__simplemdHarness.editorViewConstructions());
  await page.locator('.cm-content').click();
  await togglePreview(page);

  const region = page.getByRole('region', { name: 'Prévia — rich.md' });
  await expect(region).toBeVisible();
  await expect(region.getByText('Só leitura')).toBeVisible();
  // Mermaid (SVG), KaTeX, tabela e calc renderizados pela política da exportação.
  await expect(host(page).locator('figure.smd-mermaid svg')).toBeVisible();
  await expect(host(page).locator('.katex').first()).toBeVisible();
  await expect(host(page).locator('table td')).toHaveCount(4);
  await expect(host(page).locator('.smd-calc')).toContainText('5');
  const box = await host(page).boundingBox();
  const editorBox = await page.locator('.cm-editor').boundingBox();
  expect(box && editorBox && box.x > editorBox.x + editorBox.width).toBe(true);
  // O host prende layout e pintura e rola sozinho (F7 da r38a, N2 da r38a2).
  const css = await host(page).evaluate((el) => {
    const s = getComputedStyle(el);
    return { overflowY: s.overflowY, contain: s.contain };
  });
  expect(css).toEqual({ overflowY: 'auto', contain: 'layout paint' });

  // E2: o título novo aparece só depois do debounce (≥ 300 ms da última tecla).
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="preview-host"]')!;
    const state = { key: 0, shown: 0 };
    Object.assign(window, { __e2: state });
    window.addEventListener('keydown', () => (state.key = performance.now()), true);
    new MutationObserver(() => {
      if (!state.shown && [...el.querySelectorAll('h2')].some((h) => h.textContent === 'Novo'))
        state.shown = performance.now();
    }).observe(el, { childList: true, subtree: true, characterData: true });
  });
  await page.locator('.cm-content').click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.press('Enter');
  await page.keyboard.type('## Novo');
  await expect(host(page).getByRole('heading', { level: 2, name: 'Novo' })).toBeVisible();
  const delay = await page.evaluate(() => {
    const state: unknown = Reflect.get(window, '__e2');
    if (!state || typeof state !== 'object' || !('key' in state) || !('shown' in state)) return 0;
    return Number(state.shown) - Number(state.key);
  });
  expect(delay).toBeGreaterThanOrEqual(299);
  expect(await page.evaluate(() => window.__simplemdHarness.editorViewConstructions())).toBe(views);
  // Gravações: só o autosave da nota e a escolha em `config.json` (a prévia não grava nada).
  await expect.poll(() => writes(page)).toContain('rich.md');
  expect(new Set(await writes(page))).toEqual(new Set(['rich.md', CONFIG]));
});

test('E3 (AC-R38-2): divisor só pelo teclado e pelo ponteiro; a proporção volta ao reabrir', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openNote(page, 'FX-RICH', 'rich.md');
  await page.locator('.cm-content').click();
  await togglePreview(page);
  await page.locator('.cm-content').click();
  // Tab sai do editor (a "Tecla Tab no editor" vem desligada) e chega ao divisor.
  await page.keyboard.press('Tab');
  await expect(separator(page)).toBeFocused();
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '50');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '60');
  await expect(separator(page)).toHaveAttribute('aria-valuetext', 'Editor 60%, prévia 40%');
  const min = await separator(page).getAttribute('aria-valuemin');
  const max = await separator(page).getAttribute('aria-valuemax');
  await page.keyboard.press('Home');
  await expect(separator(page)).toHaveAttribute('aria-valuenow', min ?? '');
  // 320 px de cada lado: o editor nunca fica menor.
  const editorAtMin = await page.locator('#editor-split-start').boundingBox();
  expect(Math.round(editorAtMin?.width ?? 0)).toBeGreaterThanOrEqual(320);
  await page.keyboard.press('End');
  await expect(separator(page)).toHaveAttribute('aria-valuenow', max ?? '');
  const previewAtMax = await page.getByTestId('preview-pane').boundingBox();
  expect(Math.round(previewAtMax?.width ?? 0)).toBeGreaterThanOrEqual(320);

  // Ponteiro: arrastar 100 px para a esquerda grava uma vez, ao soltar; duplo clique = 50 %.
  const grip = await separator(page).boundingBox();
  if (!grip) throw new Error('divisor sem caixa');
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 50, y, { steps: 3 });
  await page.mouse.move(x - 100, y, { steps: 3 });
  await page.mouse.up();
  const dragged = Number(await separator(page).getAttribute('aria-valuenow'));
  expect(dragged).toBeLessThan(Number(max));
  expect(dragged).toBeGreaterThan(Number(max) - 15);
  await page.mouse.dblclick(x - 100, y);
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '50');
  await page.keyboard.press('End');
  await expect(separator(page)).toHaveAttribute('aria-valuenow', max ?? '');

  // `config.json`: a escolha (aberta, proporção) persiste; reabrir a pasta a restaura.
  await expect
    .poll(async () => {
      const text = await page.evaluate((path) => window.__simplemdHarness.readText(path), CONFIG);
      const preview = text ? JSON.parse(text).layout?.preview : null;
      return preview?.open === true && Math.round(preview.ratio * 100) === Number(max);
    })
    .toBe(true);
  await page.evaluate(() => window.__simplemdHarness.reopenVault());
  await page.getByRole('treeitem', { name: /rich\.md/ }).click();
  await expect(separator(page)).toHaveAttribute('aria-valuenow', max ?? '');
  await expect(page.getByRole('region', { name: 'Prévia — rich.md' })).toBeVisible();
});

test('E4 (AC-R38-3): html.md do FX-R7 — nada executa; imagens `blob:`; link pelo serviço único', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openNote(page, 'FX-R7', 'html.md');
  await page.locator('.cm-content').click();
  await togglePreview(page);
  // `<details>`/`<summary>` passam (o `ontoggle` do 2º não).
  await expect(host(page).locator('details summary')).toHaveText(['Resumo', 'toggle']);
  await expect(host(page).locator('img[src^="blob:"]').first()).toBeAttached();
  const scan = await host(page).evaluate((el) => ({
    active: el.querySelectorAll(
      'script, iframe, object, embed, form, input, style, link, meta, base, video, audio, foreignObject',
    ).length,
    handlers: [...el.querySelectorAll('*')].flatMap((node) =>
      [...node.attributes].filter((attr) => /^on/i.test(attr.name)).map((attr) => attr.name),
    ),
    remote: [...el.querySelectorAll('img')].filter((img) => !img.src.startsWith('blob:')).length,
    schemes: [...el.querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href') ?? '')
      .filter((href) => /^\s*(javascript|vbscript|data):/i.test(href)),
    xss: Reflect.get(window, '__xss'),
  }));
  expect(scan).toEqual({ active: 0, handlers: [], remote: 0, schemes: [], xss: undefined });

  // Link externo: a webview não navega; o pedido vai ao "abrir URL" do app com a URL igual.
  const url = page.url();
  await host(page).getByRole('link', { name: 'link HTML' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__simplemdHarness.opener.calls().map((call) => call.url)),
    )
    .toEqual(['https://exemplo.org/html']);
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => Reflect.get(window, '__xss'))).toBeUndefined();
});

test('E5: abaixo de 900 px a prévia fica indisponível, com o motivo e o anúncio', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 800 });
  await openNote(page, 'FX-RICH', 'rich.md');
  await page.locator('.cm-content').click();
  await page.keyboard.press(`${MOD}+Shift+D`);
  await expect(page.getByTestId('notice').last()).toContainText(
    'Precisa de 900 px no editor (agora 560 px). Feche o painel lateral ou aumente a janela.',
  );
  await expect(page.getByTestId('preview-pane')).toHaveCount(0);

  // 1280 com o painel lateral aberto: 720 px no editor.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('.cm-content').click();
  await page.keyboard.press(`${MOD}+Shift+D`);
  await expect(page.getByTestId('preview-pane')).toBeVisible();
  await page.locator('.cm-content').click();
  await page.keyboard.press(`${MOD}+Shift+L`);
  await expect(page.getByTestId('preview-pane')).toHaveCount(0);
  await expect(page.locator('.cm-announced')).toHaveText(
    'Prévia lado a lado escondida: o editor tem 720 px (mínimo 900).',
  );
  // A escolha continua; fechar o painel lateral devolve a prévia.
  await page.keyboard.press(`${MOD}+Shift+L`);
  await expect(page.getByTestId('preview-pane')).toBeVisible();
});

test('E6: a rolagem segue o último painel com gesto, nos dois sentidos (≤ 40 px)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto('/?vault=FX-TOC');
  const sections = Array.from({ length: 40 }, (_, i) => {
    const paragraphs = Array.from(
      { length: 6 },
      (_, k) => `Parágrafo ${i + 1}.${k + 1} com texto que ocupa uma linha.`,
    );
    return [`## Seção ${i + 1}`, ...paragraphs].join('\n\n');
  });
  await page.evaluate(
    (text) => window.__simplemdHarness.externalWrite('longo.md', text),
    `# Longo\n\n${sections.join('\n\n')}\n`,
  );
  await page.getByRole('treeitem', { name: /longo\.md/ }).click();
  await page.locator('.cm-content').waitFor();
  await page.locator('.cm-content').click();
  await togglePreview(page);
  // Sumário no painel lateral (1920: o editor continua com mais de 900 px).
  await page.keyboard.press(`${MOD}+Shift+L`);
  await page.getByRole('tab', { name: 'Sumário' }).click();

  const offsetOf = (selector: string, text: string, scroller: string) =>
    page.evaluate(
      ({ selector, text, scroller }) => {
        const box = document.querySelector(scroller)!.getBoundingClientRect();
        const el = [...document.querySelectorAll(selector)].find(
          (node) => node.textContent === text,
        );
        return el ? Math.round(el.getBoundingClientRect().top - box.top) : null;
      },
      { selector, text, scroller },
    );

  // Editor → prévia: o Sumário leva o editor ao título 20; a prévia o acompanha.
  await page
    .getByRole('navigation', { name: 'Sumário da nota' })
    .getByText('Seção 20', { exact: true })
    .click();
  await expect
    .poll(async () =>
      Math.abs((await offsetOf('h2', 'Seção 20', '[data-testid="preview-host"]')) ?? 999),
    )
    .toBeLessThanOrEqual(40);

  // Prévia → editor: um gesto na prévia e a rolagem até o título 30; o editor o acompanha.
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="preview-host"]')!;
    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    const h2 = [...el.querySelectorAll('h2')].find((h) => h.textContent === 'Seção 30')!;
    el.scrollTop += h2.getBoundingClientRect().top - el.getBoundingClientRect().top;
  });
  await expect
    .poll(async () => Math.abs((await offsetOf('.cm-line', '## Seção 30', '.cm-scroller')) ?? 999))
    .toBeLessThanOrEqual(40);
});
