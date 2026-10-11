import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { planRequests, unitsIn } from '../src/languagetool/annotate';
import { frontMatterLang, requestLanguage } from '../src/languagetool/language';
import { parseCheckResponse, parseLanguages } from '../src/languagetool/response';
import { pluginState } from './helpers';

/**
 * Grava as respostas de `test/fixtures/lt/` contra um LanguageTool REAL em localhost:8081 (fora da
 * suíte padrão: só com `SIMPLEMD_LT_RECORD=1`; r7 sprint §7.7, C-2). O pedido é montado pelo
 * MESMO código do plugin (`planRequests`), então os deslocamentos das respostas gravadas valem
 * para a nota de origem (`<nome>.md`). Os erros sintéticos (`err-*.json`) derivam das gravadas.
 */
const dir = join(__dirname, 'fixtures/lt');
const SERVER = 'http://127.0.0.1:8081';

async function check(name: string, option: string): Promise<void> {
  const doc = readFileSync(join(dir, `${name}.md`), 'utf8');
  const state = pluginState(doc, []);
  const languages = parseLanguages(readFileSync(join(dir, 'languages.json'), 'utf8')) ?? [];
  const [plan] = planRequests(state, unitsIn(state, 0, doc.length));
  if (!plan) throw new Error(`${name}: nada a verificar`);
  const language = requestLanguage(option, frontMatterLang(state), languages);
  const form = new URLSearchParams({ language: language.language });
  if (language.preferredVariants)
    form.set('preferredVariants', language.preferredVariants.join(','));
  form.set('data', JSON.stringify({ annotation: plan.annotation }));
  const response = await fetch(`${SERVER}/v2/check`, { method: 'POST', body: form });
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(parseCheckResponse(body, plan.to - plan.from).ok).toBe(true);
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(JSON.parse(body), null, 2)}\n`);
}

describe.skipIf(process.env.SIMPLEMD_LT_RECORD !== '1')('gravação das respostas do LT real', () => {
  test('languages.json', async () => {
    const response = await fetch(`${SERVER}/v2/languages`);
    const body = await response.text();
    expect(parseLanguages(body)?.length).toBeGreaterThan(10);
    writeFileSync(join(dir, 'languages.json'), `${JSON.stringify(JSON.parse(body), null, 2)}\n`);
  });

  test('pt-BR-check / en-US-check / pt-BR-auto', async () => {
    await check('pt-BR-check', 'pt-BR');
    await check('en-US-check', 'pt-BR');
    await check('pt-BR-auto', 'auto');
  });

  test('err-offset / err-missing-matches (derivados de pt-BR-check)', () => {
    const recorded = JSON.parse(readFileSync(join(dir, 'pt-BR-check.json'), 'utf8')) as {
      matches: { offset: number }[];
    };
    const offset = structuredClone(recorded);
    const first = offset.matches[0];
    if (!first) throw new Error('pt-BR-check.json sem correspondências');
    first.offset = 100_000;
    writeFileSync(join(dir, 'err-offset.json'), `${JSON.stringify(offset, null, 2)}\n`);
    const missing: Partial<typeof recorded> = structuredClone(recorded);
    delete missing.matches;
    writeFileSync(join(dir, 'err-missing-matches.json'), `${JSON.stringify(missing, null, 2)}\n`);
  });
});
