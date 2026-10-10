import { describe, expect, test } from 'vitest';
import { planRequests, splitUnit, unitSegments, unitsIn } from '../src/languagetool/annotate';
import { transportError } from '../src/languagetool/checker';
import {
  frontMatterLang,
  normalizeLanguage,
  requestLanguage,
  supportedLanguage,
} from '../src/languagetool/language';
import {
  MAX_RESPONSE_BYTES,
  categoryLabel,
  isSpelling,
  parseCheckResponse,
  parseLanguages,
  utf8BytesOver,
} from '../src/languagetool/response';
import { pluginState } from './helpers';
import { fixture } from './lt-harness';

/** Validador da resposta (R-I8.9; NFR-59 ramos ≥ 90 %), língua do pedido e anotação. */

const match = (patch: Record<string, unknown> = {}) => ({
  offset: 0,
  length: 3,
  message: 'Mensagem',
  replacements: [{ value: 'abc' }],
  rule: { id: 'RULE_A', issueType: 'grammar', category: { id: 'GRAMMAR' } },
  ...patch,
});
const body = (...matches: unknown[]) => JSON.stringify({ matches });

describe('parseCheckResponse', () => {
  test('respostas gravadas do LT 6.8 real são aceitas', () => {
    for (const [name, md] of [
      ['pt-BR-check', 'pt-BR-check.md'],
      ['en-US-check', 'en-US-check.md'],
      ['pt-BR-auto', 'pt-BR-auto.md'],
    ] as const) {
      const result = parseCheckResponse(fixture(`${name}.json`), fixture(md).length);
      expect(result.ok).toBe(true);
    }
    expect(
      parseCheckResponse(fixture('err-offset.json'), fixture('pt-BR-check.md').length),
    ).toEqual({ ok: false, error: 'resposta inválida' });
    expect(parseCheckResponse(fixture('err-missing-matches.json'), 10_000)).toEqual({
      ok: false,
      error: 'resposta inválida',
    });
  });

  test.each([
    ['JSON inválido', '{'],
    ['não objeto', '[]'],
    ['null', 'null'],
    ['matches não lista', '{"matches":{}}'],
    ['match não objeto', body(1)],
    ['match null', body(null)],
    ['offset negativo', body(match({ offset: -1 }))],
    ['offset fracionário', body(match({ offset: 1.5 }))],
    ['offset texto', body(match({ offset: '1' }))],
    ['length ausente', body(match({ length: undefined }))],
    ['fora do texto', body(match({ offset: 8, length: 3 }))],
    ['mensagem ausente', body(match({ message: 3 }))],
    ['substituições não lista', body(match({ replacements: 'x' }))],
    ['substituição sem value', body(match({ replacements: [{}] }))],
    ['substituição null', body(match({ replacements: [null] }))],
    ['regra ausente', body(match({ rule: undefined }))],
    ['regra null', body(match({ rule: null }))],
    ['id de regra com espaço', body(match({ rule: { id: 'A B', category: { id: 'X' } } }))],
    ['id de regra longo', body(match({ rule: { id: 'A'.repeat(129), category: { id: 'X' } } }))],
    ['categoria ausente', body(match({ rule: { id: 'A' } }))],
    ['categoria sem id', body(match({ rule: { id: 'A', category: {} } }))],
    ['issueType número', body(match({ rule: { id: 'A', issueType: 1, category: { id: 'X' } } }))],
  ])('%s → resposta inválida', (_name, text) => {
    expect(parseCheckResponse(text, 10)).toEqual({ ok: false, error: 'resposta inválida' });
  });

  test('limites de exibição: mensagem ≤ 500 com "…", ≤ 5 substituições de ≤ 200', () => {
    const long = 'm'.repeat(600);
    const result = parseCheckResponse(
      body(
        match({
          message: long,
          replacements: [
            { value: 'a' },
            { value: 'x'.repeat(201) },
            { value: 'b' },
            { value: 'c' },
            { value: 'd' },
            { value: 'e' },
            { value: 'f' },
          ],
          rule: { id: 'R', category: { id: 'TYPOS' } },
        }),
      ),
      10,
    );
    if (!result.ok) throw new Error('rejeitada');
    const [m] = result.matches;
    expect(m?.message.length).toBe(500);
    expect(m?.message.endsWith('…')).toBe(true);
    expect(m?.replacements).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(m?.issueType).toBeNull();
  });

  test('texto do LT fica texto (sem interpretação)', () => {
    const result = parseCheckResponse(body(match({ message: '<img src=x onerror=alert(1)>' })), 10);
    expect(result.ok && result.matches[0]?.message).toBe('<img src=x onerror=alert(1)>');
  });

  test('2 MiB: no limite passa, + 1 byte é "resposta grande demais" (UTF-8)', () => {
    const at = (n: number) => `{"matches":[],"p":"${'x'.repeat(n - 21)}"}`;
    expect(at(MAX_RESPONSE_BYTES).length).toBe(MAX_RESPONSE_BYTES);
    expect(parseCheckResponse(at(MAX_RESPONSE_BYTES), 0).ok).toBe(true);
    expect(parseCheckResponse(at(MAX_RESPONSE_BYTES + 1), 0)).toEqual({
      ok: false,
      error: 'resposta grande demais',
    });
  });

  test('utf8BytesOver conta 1/2/3/4 bytes', () => {
    expect(utf8BytesOver('a', 1)).toBe(false);
    expect(utf8BytesOver('é', 1)).toBe(true);
    expect(utf8BytesOver('é', 2)).toBe(false);
    expect(utf8BytesOver('€', 2)).toBe(true);
    expect(utf8BytesOver('€', 3)).toBe(false);
    expect(utf8BytesOver('😀', 3)).toBe(true);
    expect(utf8BytesOver('😀', 4)).toBe(false);
    expect(utf8BytesOver('abc', 2)).toBe(true);
  });

  test('ortografia × categorias (STR-168)', () => {
    const k = (categoryId: string, ruleId = 'R', issueType: string | null = null) => ({
      categoryId,
      ruleId,
      issueType,
    });
    expect(isSpelling(k('TYPOS'))).toBe(true);
    expect(isSpelling(k('X', 'MORFOLOGIK_RULE_PT_BR'))).toBe(true);
    expect(isSpelling(k('X', 'R', 'misspelling'))).toBe(true);
    expect(isSpelling(k('GRAMMAR'))).toBe(false);
    expect(categoryLabel(k('TYPOS'))).toBe('Ortografia');
    expect(categoryLabel(k('GRAMMAR'))).toBe('Gramática');
    expect(categoryLabel(k('PUNCTUATION'))).toBe('Pontuação');
    expect(categoryLabel(k('STYLE'))).toBe('Estilo');
    expect(categoryLabel(k('REDUNDANCY'))).toBe('Estilo');
    expect(categoryLabel(k('CASING'))).toBe('Revisão');
  });
});

describe('parseLanguages', () => {
  test('lista gravada e formas inválidas', () => {
    expect(parseLanguages(fixture('languages.json'))?.some((l) => l.longCode === 'pt-BR')).toBe(
      true,
    );
    expect(parseLanguages('{')).toBeNull();
    expect(parseLanguages('{}')).toBeNull();
    expect(parseLanguages('[1]')).toBeNull();
    expect(parseLanguages('[{"code":"pt"}]')).toBeNull();
  });
});

describe('língua do pedido', () => {
  const languages = parseLanguages(fixture('languages.json')) ?? [];
  test('normalizeLanguage', () => {
    expect(normalizeLanguage('pt_br')).toBe('pt-BR');
    expect(normalizeLanguage(' EN-us ')).toBe('en-US');
    expect(normalizeLanguage('de-DE-x-simple')).toBe('de-DE-x-simple');
    expect(normalizeLanguage('pt BR')).toBeNull();
    expect(normalizeLanguage('')).toBeNull();
    expect(normalizeLanguage('português')).toBeNull();
  });

  test('frontMatterLang: aspas, comentário, ausente, sem front matter, inválido', () => {
    const lang = (doc: string) => frontMatterLang(pluginState(doc, []));
    expect(lang('---\nlang: en-US\n---\nx\n')).toBe('en-US');
    expect(lang('---\ntitle: a\nlang: "pt_br" # nota\n---\nx\n')).toBe('pt-BR');
    expect(lang("---\nlang: 'es'\n---\nx\n")).toBe('es');
    expect(lang('---\ntitle: a\n---\nx\n')).toBeNull();
    expect(lang('lang: en-US\n')).toBeNull();
    expect(lang('---\nlang: português\n---\nx\n')).toBeNull();
  });

  test('supportedLanguage e requestLanguage', () => {
    expect(supportedLanguage('en-us', languages)).toBe('en-US');
    expect(supportedLanguage('de-CH-x', languages)).toBe('de');
    expect(supportedLanguage('xx-YY', languages)).toBeNull();
    expect(requestLanguage('pt-BR', 'en-US', languages)).toEqual({ language: 'en-US' });
    expect(requestLanguage('pt-BR', 'xx-YY', languages)).toEqual({ language: 'pt-BR' });
    expect(requestLanguage('es', null, languages)).toEqual({ language: 'es' });
    expect(requestLanguage('qq', null, languages)).toEqual({ language: 'pt-BR' });
    expect(requestLanguage('auto', null, languages)).toEqual({
      language: 'auto',
      preferredVariants: ['pt-BR', 'en-US'],
    });
  });
});

describe('anotação', () => {
  test('markup entre espaços leva o espaço seguinte (sem espaço duplo para o LT)', () => {
    const doc = 'Use `x` aqui e **negrito** e fim\n';
    const state = pluginState(doc, []);
    const segments = unitSegments(state, 0, doc.length - 1);
    expect(segments.map((s) => ('text' in s ? s.text : s.markup)).join('')).toBe(doc.slice(0, -1));
    expect(segments.flatMap((s) => ('text' in s ? [s.text] : [])).join('')).toBe(
      'Use aqui e negrito e fim',
    );
  });

  test('unidades: títulos, tarefa, tabela, citação; blocos $$ e código ficam de fora', () => {
    const doc =
      '# Título\n\n- [ ] tarefa\n\n| a | b |\n|---|---|\n| c | d |\n\n> citação\n\n$$\nx\n$$\n\n```\nc\n```\n';
    const state = pluginState(doc, []);
    expect(unitsIn(state, 0, doc.length).map((u) => doc.slice(u.from, u.to))).toEqual([
      '# Título',
      '[ ] tarefa',
      '| a | b |\n|---|---|\n| c | d |',
      'citação',
    ]);
    // Ponto (apagamento) dentro de uma unidade.
    expect(unitsIn(state, 3, 3).map((u) => doc.slice(u.from, u.to))).toEqual(['# Título']);
  });

  test('unidade maior que o teto: por linhas; linha enorme: por posição, sem partir emoji', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `linha ${i} ${'x'.repeat(30)}`).join('\n');
    const state = pluginState(`${lines}\n`, []);
    const [unit] = unitsIn(state, 0, lines.length);
    if (!unit) throw new Error('sem unidade');
    const pieces = splitUnit(state, unit, 100);
    expect(pieces.every((p) => p.to - p.from <= 100)).toBe(true);
    expect(pieces.every((p) => state.sliceDoc(p.from, p.to).startsWith('linha'))).toBe(true);
    const giant = `${'a'.repeat(99)}😀${'b'.repeat(150)}`;
    const s2 = pluginState(`${giant}\n`, []);
    const parts = splitUnit(s2, { from: 0, to: giant.length }, 100);
    expect(parts.map((p) => s2.sliceDoc(p.from, p.to)).join('')).toBe(giant);
    for (const p of parts) {
      const first = s2.sliceDoc(p.from, p.from + 1).charCodeAt(0);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    }
    const spaced = `${'palavra '.repeat(40)}`;
    const s3 = pluginState(`${spaced}\n`, []);
    const words = splitUnit(s3, { from: 0, to: spaced.length }, 100);
    expect(words.every((p) => s3.sliceDoc(p.from, p.to).startsWith('palavra'))).toBe(true);
  });

  test('planRequests: grupos contíguos ≤ teto, front matter só no primeiro', () => {
    const doc = `---\na: 1\n---\n${Array.from({ length: 6 }, (_, i) => `Parágrafo ${i} ${'z'.repeat(40)}.`).join('\n\n')}\n`;
    const state = pluginState(doc, []);
    const plans = planRequests(state, unitsIn(state, 0, doc.length), 120);
    expect(plans.length).toBeGreaterThan(1);
    // O front matter (13 unidades) só entra quando o grupo inteiro cabe no teto a partir de 0.
    expect(plans[0]?.from).toBe(doc.indexOf('Parágrafo 0'));
    expect(planRequests(state, unitsIn(state, 0, doc.length))[0]?.from).toBe(0);
    for (const plan of plans) {
      const joined = plan.annotation.map((s) => ('text' in s ? s.text : s.markup)).join('');
      expect(joined).toBe(doc.slice(plan.from, plan.to));
      expect(plan.to - plan.from).toBeLessThanOrEqual(120);
    }
  });
});

describe('erros do transporte', () => {
  test('transportError lê code e detail.status só quando têm o tipo certo', () => {
    expect(transportError('x')).toEqual({ code: null, status: null });
    expect(transportError(null)).toEqual({ code: null, status: null });
    expect(transportError({ code: 1 })).toEqual({ code: null, status: null });
    expect(transportError({ code: 'LT_HTTP_STATUS', detail: { status: 500 } })).toEqual({
      code: 'LT_HTTP_STATUS',
      status: 500,
    });
    expect(transportError({ code: 'LT_HTTP_STATUS', detail: { status: '500' } })).toEqual({
      code: 'LT_HTTP_STATUS',
      status: null,
    });
    expect(transportError({ code: 'X', detail: null })).toEqual({ code: 'X', status: null });
  });
});
