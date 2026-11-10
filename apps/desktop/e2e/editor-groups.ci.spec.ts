import { expect, test, type Page } from '@playwright/test';

/**
 * r39b (design-r39 §4 E1–E8; AC-R39-1/2): os dois grupos do editor no harness de produção, no
 * Chromium real (no CI, também no Edge do Windows). ⌘\ (Ctrl+\) abre o grupo da direita vazio, com
 * o foco, e leva o foco ao explorador; duas notas ficam lado a lado e cada uma grava só o próprio
 * arquivo; trocar de aba no grupo não cria `EditorView`; ⌘\, o ×, ⌘W no grupo vazio e a última aba
 * juntam os grupos; ⌘E e a prévia seguem o grupo com foco; 640 px para dividir, 960 para a prévia.
 */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const SPLIT = `${MOD}+Backslash`;
const JOINED = 'Editor em um grupo só.';

const group = (page: Page, index: 0 | 1) =>
  page.locator(`[data-testid="editor-group"][data-group="${index}"]`);
const editor = (page: Page, index: 0 | 1) => group(page, index).locator('.cm-content');
const groups = (page: Page) => page.locator('[data-testid="editor-group"]');
const tabsOf = (page: Page, index: 0 | 1) => group(page, index).getByRole('tab');
const views = (page: Page) =>
  page.evaluate(() => window.__simplemdHarness.editorViewConstructions());
const text = (page: Page, path: string) =>
  page.evaluate((file) => window.__simplemdHarness.readText(file), path);
const announced = (page: Page) =>
  page.evaluate(() => window.__simplemdHarness.announcements.list().map((entry) => entry.text));
/** Linha do explorador pelo nome exato ("a.md" também casaria com "nota.md"). */
const row = (page: Page, name: string) => page.getByRole('treeitem', { name, exact: true });

async function openNote(page: Page, name: string): Promise<void> {
  await page.goto('/?vault=FX-SMALL');
  await row(page, name).click();
  await expect(editor(page, 0)).toBeVisible();
}

/** Divide pela tecla com o foco no editor da esquerda e espera o grupo novo, vazio. */
async function split(page: Page): Promise<void> {
  await editor(page, 0).click();
  await page.keyboard.press(SPLIT);
  await expect(group(page, 1).getByText('Grupo vazio')).toBeVisible();
}

/** `sub/c.md` pelo explorador (a pasta é aberta antes, se preciso). */
async function openC(page: Page): Promise<void> {
  if (!(await row(page, 'c.md').isVisible())) await row(page, 'sub').click();
  await row(page, 'c.md').click();
}

test('E1/E2 (AC-R39-1): duas notas lado a lado, cada uma grava o seu arquivo; abas no grupo = 0 views', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openNote(page, 'nota.md');
  const before = await views(page);
  await split(page);
  // O grupo novo é o único view novo; o foco vai ao explorador e o canal de anúncios do app (r39c)
  // diz o próximo passo.
  expect(await views(page)).toBe(before + 1);
  await expect(page.getByRole('group', { name: 'Grupo da direita' })).toBeVisible();
  await expect(page.locator('[data-testid="explorer-row"][tabindex="0"]')).toBeFocused();
  await expect
    .poll(() => announced(page))
    .toContain('Editor dividido. Escolha uma nota no explorador para abrir no grupo da direita.');
  await expect(group(page, 0)).toHaveAttribute('data-focus', 'off');

  await row(page, 'a.md').click();
  await expect(editor(page, 1)).toBeFocused();
  await expect(tabsOf(page, 1)).toHaveText(['a.md']);
  await expect(tabsOf(page, 0)).toHaveText(['nota.md']);
  const left = await group(page, 0).boundingBox();
  const right = await group(page, 1).boundingBox();
  expect(left && right && right.x >= left.x + left.width - 1).toBe(true);
  expect(Math.abs((left?.width ?? 0) - (right?.width ?? 0))).toBeLessThanOrEqual(2);

  // Digitar nos dois: cada nota grava só no próprio arquivo. Cada troca de grupo é anunciada.
  await editor(page, 0).click();
  await expect.poll(() => announced(page)).toContain('Foco no grupo da esquerda.');
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type('esquerda');
  await editor(page, 1).click();
  await expect.poll(() => announced(page)).toContain('Foco no grupo da direita.');
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type('direita');
  await expect.poll(() => text(page, 'nota.md')).toContain('esquerda');
  await expect.poll(() => text(page, 'a.md')).toContain('direita');
  expect(await text(page, 'nota.md')).not.toContain('direita');
  expect(await text(page, 'a.md')).not.toContain('esquerda');

  // Trocar de aba dentro do grupo da direita: 0 views novos.
  const split2 = await views(page);
  await openC(page);
  await expect(tabsOf(page, 1)).toHaveText(['a.md', 'c.md']);
  await expect(editor(page, 1)).toContainText('# C');
  await tabsOf(page, 1).first().click();
  await expect(editor(page, 1)).toContainText('direita');
  expect(await views(page)).toBe(split2);
});

test('E3/E5: o explorador foca o grupo da nota; ⌘\\, ×, ⌘W no grupo vazio e a última aba juntam', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openNote(page, 'nota.md');
  await split(page);
  await row(page, 'a.md').click();
  await expect(editor(page, 1)).toBeFocused();
  // E3: com o foco na esquerda, a nota da direita no explorador volta ao grupo dela, sem aba nova.
  await editor(page, 0).click();
  await expect(group(page, 1)).toHaveAttribute('data-focus', 'off');
  await row(page, 'a.md').click();
  await expect(editor(page, 1)).toBeFocused();
  await expect(page.locator('.smd-group [role="tab"]')).toHaveCount(2);

  // ⌘\ com o foco na direita: as abas dela primeiro, a nota com o cursor onde estava.
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type('X');
  const views0 = await views(page);
  await page.keyboard.press(SPLIT);
  await expect(groups(page)).toHaveCount(1);
  await expect(page.getByRole('tablist', { name: 'Arquivos abertos' }).getByRole('tab')).toHaveText(
    ['a.md', 'nota.md'],
  );
  await expect(editor(page, 0)).toBeFocused();
  await page.keyboard.type('Y');
  await expect(editor(page, 0)).toContainText('XY');
  await expect.poll(() => announced(page)).toContain(JOINED);
  expect(await views(page)).toBe(views0);

  // ⌘W no grupo vazio (o foco está no explorador): fecha o grupo.
  await split(page);
  await page.keyboard.press(`${MOD}+w`);
  await expect(groups(page)).toHaveCount(1);
  await expect(tabsOf(page, 0)).toHaveText(['a.md', 'nota.md']);

  // ×: as abas do grupo fechado vão para o fim do outro.
  await split(page);
  await openC(page);
  await expect(tabsOf(page, 1)).toHaveText(['c.md']);
  await page.getByRole('button', { name: 'Fechar grupo da direita' }).click();
  await expect(groups(page)).toHaveCount(1);
  await expect(tabsOf(page, 0)).toHaveText(['a.md', 'nota.md', 'c.md']);

  // A última aba de um grupo: fechar o grupo, com o anúncio.
  await tabsOf(page, 0).filter({ hasText: 'c.md' }).click();
  await page.keyboard.press(`${MOD}+w`);
  await expect(tabsOf(page, 0)).toHaveText(['a.md', 'nota.md']);
  await split(page);
  await openC(page);
  await expect(editor(page, 1)).toBeFocused();
  await page.evaluate(() => window.__simplemdHarness.announcements.clear());
  await page.keyboard.press(`${MOD}+w`);
  await expect(groups(page)).toHaveCount(1);
  await expect(tabsOf(page, 0)).toHaveText(['a.md', 'nota.md']);
  await expect.poll(() => announced(page)).toContain(JOINED);
});

test('E4/E7: ⌘E só no grupo com foco; só pelo teclado, explorador → grupo novo → "Fechar grupo"', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openNote(page, 'nota.md');
  await editor(page, 0).click();
  await page.keyboard.press(SPLIT);
  // Só teclado: o explorador está com o foco; ↑ até a.md e Enter abrem a nota no grupo novo.
  await expect(page.locator('[data-testid="explorer-row"][tabindex="0"]')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(row(page, 'a.md')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(editor(page, 1)).toBeFocused();
  await expect(tabsOf(page, 1)).toHaveText(['a.md']);

  const mode = (index: 0 | 1) => group(page, index).locator('.cm-editor');
  await expect(mode(0)).toHaveAttribute('data-smd-mode', 'source');
  await page.keyboard.press(`${MOD}+e`);
  await expect(mode(1)).toHaveAttribute('data-smd-mode', 'live');
  await expect(mode(0)).toHaveAttribute('data-smd-mode', 'source');
  // A barra de status mostra o modo do grupo com foco.
  await expect(page.getByTestId('status-mode')).toContainText('Prévia');
  await editor(page, 0).click();
  await expect(page.getByTestId('status-mode')).toContainText('Fonte');

  // Shift+Tab do editor da direita chega a "Fechar grupo da direita"; Enter fecha o grupo.
  await editor(page, 1).click();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Fechar grupo da direita' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(groups(page)).toHaveCount(1);
  await expect(tabsOf(page, 0)).toHaveText(['nota.md', 'a.md']);
  await expect(editor(page, 0)).toBeFocused();
});

test('E6: 1024×768 com o painel lateral, dividir fica indisponível com o motivo', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openNote(page, 'nota.md');
  await editor(page, 0).click();
  await page.keyboard.press(`${MOD}+Shift+L`);
  await editor(page, 0).click();
  await page.keyboard.press(SPLIT);
  await expect(page.getByTestId('notice').last()).toContainText(
    /Precisa de 640 px no editor \(agora \d+ px\)\. Feche o painel lateral ou aumente a janela\./,
  );
  await expect(groups(page)).toHaveCount(1);
  // Sem o painel lateral cabe.
  await page.keyboard.press(`${MOD}+Shift+L`);
  await split(page);
  await expect(groups(page)).toHaveCount(2);
});

test('E8: 1440 com ⌘⇧D, a prévia segue o grupo com foco; com menos de 960 px some', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openNote(page, 'nota.md');
  await split(page);
  await row(page, 'a.md').click();
  await expect(editor(page, 1)).toBeFocused();
  await page.keyboard.press(`${MOD}+Shift+D`);
  await expect(page.getByRole('region', { name: 'Prévia — a.md' })).toBeVisible();
  await expect(page.getByTestId('preview-host').locator('h1')).toHaveText('A');
  // Os dois grupos ficam com 640 px ou mais ao lado da prévia.
  const both = await page.locator('.smd-groups').boundingBox();
  expect(Math.round(both?.width ?? 0)).toBeGreaterThanOrEqual(640);
  await editor(page, 0).click();
  await expect(page.getByRole('region', { name: 'Prévia — nota.md' })).toBeVisible();
  await expect(page.getByTestId('preview-host').locator('h1')).toHaveText('Nota');

  // 1180 px de janela: 940 px no editor, menos que os 960 do editor dividido com a prévia.
  await page.setViewportSize({ width: 1180, height: 900 });
  await expect(page.getByTestId('preview-pane')).toHaveCount(0);
  await expect
    .poll(() => announced(page))
    .toContain('Prévia lado a lado escondida: o editor tem 940 px (mínimo 960).');
  // Um grupo só cabe com 900 px: a prévia volta.
  await page.keyboard.press(SPLIT);
  await expect(groups(page)).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Prévia — nota.md' })).toBeVisible();
});
