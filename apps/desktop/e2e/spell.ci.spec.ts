import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * r35c (design-r35 §4 E1–E5, E7; AC-R35-1/2): o corretor offline "Ortografia offline", ligado por
 * padrão, no harness de produção e no Chromium real (no CI, também no Edge do Windows). O motor é o
 * falso do harness (`__simplemdHarness.spell`, as regras do Rust; "excessão" → "exceção"): nada sai
 * pela rede e o LanguageTool fica desligado. Toda espera é por estado visível (sublinhado, cartão,
 * texto, chamadas do falso), nunca por tempo.
 */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
/** A nota do LT (`pt-BR-check.md`): código, URL, matemática e wikilink em volta de "excessão". */
const NOTE = readFileSync(
  fileURLToPath(
    new URL('../../../packages/plugins-internal/test/fixtures/lt/pt-BR-check.md', import.meta.url),
  ),
  'utf8',
);

const editor = (page: Page) => page.locator('.cm-content');
const spelling = (page: Page) => page.locator('.cm-content .cm-lintRange-spelling');
const card = (page: Page) => page.locator('[data-testid="problem-card"]');
const spellCalls = (page: Page) =>
  page.evaluate(() =>
    window.__simplemdHarness.spell.calls().map((call) => `${call.op}:${call.outcome}`),
  );
const announced = (page: Page) =>
  page.evaluate(() => window.__simplemdHarness.announcements.list().map((entry) => entry.text));

/** FX-SMALL com a nota do LT criada "por fora" e aberta; espera o sublinhado e a sugestão. */
async function openSpellNote(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?vault=FX-SMALL');
  await page.evaluate(
    (text) => window.__simplemdHarness.externalWrite('pt-BR-check.md', text),
    NOTE,
  );
  await page.getByRole('treeitem', { name: 'pt-BR-check.md', exact: true }).click();
  await expect(editor(page)).toContainText('Isso é uma excessão.');
  await expect(spelling(page)).toHaveText(['excessão']);
  // A sugestão chega depois da verificação (uma chamada por vez ao motor).
  await expect.poll(() => spellCalls(page)).toContain('suggest:ok');
}

/** Cursor dentro de "excessão" e o cartão pelo teclado (⌘⇧Enter), com o foco no 1º botão. */
async function openCard(page: Page): Promise<void> {
  await spelling(page).click();
  await page.mouse.move(0, 0);
  await page.keyboard.press(`${MOD}+Shift+Enter`);
  await expect(card(page)).toBeVisible();
}

test('E1/E2/E3 (AC-R35-1): "excessão" sublinhada sem LanguageTool; trocar pela sugestão e desfazer num passo', async ({
  page,
}) => {
  await openSpellNote(page);
  // Só a prosa: o "excessao" do bloco de código, o código em linha, a URL e o alvo do wikilink não.
  await expect(spelling(page)).toHaveCount(1);
  expect(await page.evaluate(() => window.__simplemdHarness.lt.calls().length)).toBe(0);
  // O motor recarregou pelo caminho único do app (a pasta aberta e a ativação), sem falha.
  const reloads = (await spellCalls(page)).filter((call) => call.startsWith('reload:'));
  expect(reloads.length).toBeGreaterThan(0);
  expect(reloads.every((call) => call === 'reload:ok')).toBe(true);

  await openCard(page);
  await expect(card(page)).toHaveAttribute('data-source', 'spell');
  await expect(card(page)).toContainText('Ortografia');
  await expect(card(page)).toContainText(
    '“excessão” não está no dicionário (Português do Brasil).',
  );
  await expect(card(page).getByRole('button')).toHaveText([
    'Trocar por “exceção”',
    'Ignorar',
    'Adicionar ao dicionário',
  ]);
  await expect(card(page).getByRole('button', { name: 'Trocar por “exceção”' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card(page)).toHaveCount(0);
  await expect(editor(page)).toContainText('Isso é uma exceção.');
  await expect(spelling(page)).toHaveCount(0);
  await expect.poll(() => announced(page)).toContain('Trocado por “exceção”.');
  await expect(editor(page)).toBeFocused();

  // Um passo de desfazer volta a palavra; ela é sublinhada de novo (desfazer não é digitação).
  await page.keyboard.press(`${MOD}+z`);
  await expect(editor(page)).toContainText('Isso é uma excessão.');
  await expect(spelling(page)).toHaveText(['excessão']);
});

test('E7/E5: Ignorar some nesta sessão e volta na próxima; Adicionar ao dicionário grava no pessoal.txt deste computador', async ({
  page,
}) => {
  await openSpellNote(page);
  await openCard(page);
  await card(page).getByRole('button', { name: 'Ignorar' }).click();
  await expect(spelling(page)).toHaveCount(0);
  await expect.poll(() => announced(page)).toContain('“excessão” ignorada nesta sessão.');

  // Outra sessão (a página carregada de novo, a nota criada de novo): a palavra volta.
  await openSpellNote(page);
  await openCard(page);
  await card(page).getByRole('button', { name: 'Adicionar ao dicionário' }).click();
  await expect(spelling(page)).toHaveCount(0);
  await expect
    .poll(() => announced(page))
    .toContain('“excessão” adicionada ao dicionário deste computador.');
  await expect
    .poll(() => page.evaluate(() => window.__simplemdHarness.dictionaries.text('pessoal.txt')))
    .toBe('excessão\n');
});

test('E4 (AC-R35-2): com o LanguageTool ligado, "excessão" aparece uma vez só (do corretor) e a gramática fica', async ({
  page,
}) => {
  await openSpellNote(page);
  await page.evaluate(() => {
    window.__simplemdHarness.lt.mode = { kind: 'recorded', name: 'pt-BR-check' };
  });
  await page.keyboard.press(`${MOD}+Comma`);
  await page.getByRole('tab', { name: 'Plugins' }).click();
  const lt = page.getByRole('switch', { name: 'Ativar “Ortografia e gramática (LanguageTool)”' });
  await lt.click();
  await expect(lt).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('status-lt')).toHaveText('LanguageTool: 2 problemas');
  await expect(page.locator('.cm-content .cm-lintRange-grammar')).toHaveCount(2);
  await expect(spelling(page)).toHaveText(['excessão']);
  await openCard(page);
  await expect(card(page)).toHaveAttribute('data-source', 'spell');
});
