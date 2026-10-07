import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  compactValue,
  extractNoteMeta,
  FRONT_MATTER_MAX_CONTENT,
  FRONT_MATTER_WARNINGS,
  isValidDateText,
  normalizeTags,
  parseFrontMatterYaml,
  readNoteProperties,
  validateFrontMatter,
} from '../src';

const fm = (yaml: string, body = '# Corpo\n') => `---\n${yaml}---\n${body}`;
const props = (doc: string) => readNoteProperties(EditorState.create({ doc }));

describe('AC-9.1 detecção (índice e painel)', () => {
  it('offset 0, também com BOM e CRLF; `---` na linha 3 não é front matter', () => {
    expect(extractNoteMeta(fm('title: Lf\n'), 'a.md').title).toBe('Lf');
    expect(
      extractNoteMeta('\uFEFF---\r\ntitle: Crlf\r\ntags: a\r\n---\r\n# H\r\n', 'a.md'),
    ).toEqual({
      title: 'Crlf',
      tags: ['a'],
      date: null,
      fmError: false,
    });
    const late = 'texto\n\n---\ntitle: não\n---\n';
    expect(extractNoteMeta(late, 'pasta/tardio.md').title).toBe('tardio');
    expect(props(late)).toEqual({ kind: 'none' });
  });

  it('257 KB não é lido: o painel avisa e o índice fica com o título de fallback, sem erro', () => {
    const big = `---\nx: "${'a'.repeat(FRONT_MATTER_MAX_CONTENT + 1024)}"\ntitle: Não lido\n---\n# Corpo grande\n`;
    expect(props(big)).toEqual({ kind: 'too-large' });
    expect(extractNoteMeta(big, 'g.md')).toEqual({
      title: 'Corpo grande',
      tags: [],
      date: null,
      fmError: false,
    });
  });
});

describe('AC-9.2 tabela de validação', () => {
  it('erro de sintaxe com a linha do arquivo; raiz lista = erro', () => {
    // Linha 1 é o `---`; o YAML quebrado (`b: c: d`) está na linha 3 do arquivo.
    const syntax = parseFrontMatterYaml('a: 1\nb: c: d\ne: 2\n');
    expect(syntax).toEqual({ ok: false, line: 3, message: 'mapa aninhado numa chave em linha' });
    expect(parseFrontMatterYaml('title: ok\n\tcom tab: 1\n')).toEqual({
      ok: false,
      line: 3,
      message: 'tabulação usada como indentação',
    });
    expect(extractNoteMeta(fm('a: 1\nb: c: d\n'), 'n.md')).toMatchObject({
      fmError: true,
      fmErrorLine: 3,
      title: 'Corpo',
    });
    expect(parseFrontMatterYaml('- a\n- b\n')).toEqual({
      ok: false,
      line: 1,
      message: 'o bloco precisa ser um mapa de chaves.',
    });
    expect(props(fm('- a\n'))).toEqual({
      kind: 'error',
      line: 1,
      message: 'o bloco precisa ser um mapa de chaves.',
    });
    expect(parseFrontMatterYaml('a: 1\na: 2\n')).toEqual({
      ok: false,
      line: 3,
      message: 'chave repetida',
    });
    expect(parseFrontMatterYaml('a: [1, 2\n')).toMatchObject({ ok: false, line: 3 });
    expect(parseFrontMatterYaml('just text\n')).toMatchObject({ ok: false, line: 1 });
  });

  it('title: 5 → aviso; tags normalizadas; tags: 3 → aviso; datas', () => {
    expect(validateFrontMatter({ title: 5 })).toMatchObject({
      title: null,
      warnings: { title: FRONT_MATTER_WARNINGS.title },
    });
    expect(validateFrontMatter({ tags: 'a, #b' }).tags).toEqual(['a', 'b']);
    expect(validateFrontMatter({ tags: ['A', 'a'] }).tags).toEqual(['A']);
    expect(validateFrontMatter({ tags: ['  #x ', '', 'y/z', 'X'] }).tags).toEqual(['x', 'y/z']);
    expect(validateFrontMatter({ tags: 3 }).warnings).toEqual({ tags: FRONT_MATTER_WARNINGS.tags });
    expect(validateFrontMatter({ tags: ['a', 3] }).warnings).toEqual({
      tags: FRONT_MATTER_WARNINGS.tags,
    });
    expect(validateFrontMatter({ tags: null, date: null })).toEqual({
      title: null,
      tags: [],
      date: null,
      warnings: {},
    });
    expect(validateFrontMatter({ date: '2026-10-07' })).toMatchObject({
      date: '2026-10-07',
      warnings: {},
    });
    expect(validateFrontMatter({ date: '07/10/2026' }).warnings).toEqual({
      date: FRONT_MATTER_WARNINGS.date,
    });
    expect(validateFrontMatter({ date: 20261007 }).warnings).toEqual({
      date: FRONT_MATTER_WARNINGS.date,
    });
    const asDate = validateFrontMatter({ date: new Date(Date.UTC(2026, 9, 7)) });
    expect(asDate.date).toBe('2026-10-07T00:00:00.000Z');
    expect(validateFrontMatter({ title: '   ' }).title).toBeNull();
  });

  it('datas ISO 8601 e calendário', () => {
    for (const ok of [
      '2026-10-07',
      '2026-10-07T10:20',
      '2026-10-07T10:20:30Z',
      '2026-10-07 10:20:30.5+03:00',
      '2024-02-29',
    ])
      expect(isValidDateText(ok), ok).toBe(true);
    for (const bad of [
      '2026-13-01',
      '2026-02-30',
      '2025-02-29',
      '2026-10-07T24:00',
      '2026-1-7',
      'ontem',
    ])
      expect(isValidDateText(bad), bad).toBe(false);
  });

  it('chave desconhecida é mantida e exibida; avisos por linha', () => {
    const parsed = parseFrontMatterYaml('title: 5\nautor: Ana\nextra:\n  a: 1\n  b: [x, y]\n');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.properties.map((p) => p.key)).toEqual(['title', 'autor', 'extra']);
    expect(parsed.properties[0]?.warning).toBe(FRONT_MATTER_WARNINGS.title);
    expect(compactValue(parsed.properties[2]?.value)).toBe('{a: 1, b: [x, y]}');
  });

  it('1.000 aliases são recusados em ≤ 100 ms', () => {
    let yaml = 'a: &x valor\nlista:\n';
    for (let i = 0; i < 1000; i++) yaml += '  - *x\n';
    const started = performance.now();
    const parsed = parseFrontMatterYaml(yaml);
    const elapsed = performance.now() - started;
    expect(parsed).toEqual({ ok: false, line: 2, message: 'aliases demais' });
    expect(elapsed).toBeLessThanOrEqual(100);
    expect(extractNoteMeta(fm(yaml), 'bomba.md').fmError).toBe(true);
  });

  it('`!!js/function` não é executado: vira valor comum', () => {
    const marker = { called: false };
    (globalThis as Record<string, unknown>).__smdYamlProbe = marker;
    const parsed = parseFrontMatterYaml(
      'f: !!js/function "function () { globalThis.__smdYamlProbe.called = true }"\n',
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(typeof parsed.properties[0]?.value).toBe('string');
    expect(marker.called).toBe(false);
    delete (globalThis as Record<string, unknown>).__smdYamlProbe;
  });

  it('front matter vazio é um mapa vazio; normalizeTags puro', () => {
    expect(parseFrontMatterYaml('')).toEqual({
      ok: true,
      properties: [],
      title: null,
      tags: [],
      date: null,
    });
    expect(normalizeTags(['Ação', 'ação', '#', ' '])).toEqual(['Ação']);
  });
});

describe('AC-9.6 regra do título', () => {
  it('title do front matter > primeiro H1 > nome do arquivo', () => {
    expect(extractNoteMeta(fm('title: Do YAML\n', '# H1\n'), 'p/n.md').title).toBe('Do YAML');
    expect(extractNoteMeta(fm('autor: x\n', '## h2\n\n# Primeiro H1 #\n'), 'p/n.md').title).toBe(
      'Primeiro H1',
    );
    expect(extractNoteMeta('Setext\n===\n\n# depois\n', 'n.md').title).toBe('Setext');
    expect(
      extractNoteMeta('```\n# falso\n```\n\n    # indentado\n\ntexto\n', 'p/Nota Final.md').title,
    ).toBe('Nota Final');
    // title que não é texto cai para o H1 (e o aviso fica no painel).
    expect(extractNoteMeta(fm('title: 5\n', '# Do corpo\n'), 'n.md').title).toBe('Do corpo');
    expect(extractNoteMeta('', 'pasta/vazia.MD').title).toBe('vazia');
  });
});

describe('painel de propriedades (R-9.4)', () => {
  it('linhas, chips de tags, posição da linha da chave, corte em 200 com o texto inteiro', () => {
    const long = 'x'.repeat(300);
    const doc = fm(
      `title: Bolo\ntags: [doce, "#forno"]\ndate: 2026-10-07\nautor: Ana\nnota: ${long}\n`,
    );
    const result = props(doc);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.rows.map((r) => r.key)).toEqual(['title', 'tags', 'date', 'autor', 'nota']);
    const tags = result.rows[1];
    expect(tags?.chips).toEqual(['doce', 'forno']);
    expect(doc.slice(tags?.pos, (tags?.pos ?? 0) + 5)).toBe('tags:');
    const nota = result.rows[4];
    expect(nota?.display).toBe(`${'x'.repeat(200)}…`);
    expect(nota?.full).toBe(long);
    expect(result.rows[2]?.display).toBe('2026-10-07');
  });

  it('aviso de tipo fica na linha; erro sem linhas', () => {
    const warn = props(fm('title: 5\ntags: 3\ndate: 07/10/2026\n'));
    expect(warn.kind === 'ok' && warn.rows.map((r) => r.warning)).toEqual([
      FRONT_MATTER_WARNINGS.title,
      FRONT_MATTER_WARNINGS.tags,
      FRONT_MATTER_WARNINGS.date,
    ]);
    expect(props(fm('a: "aberto\n'))).toMatchObject({ kind: 'error', line: 3 });
    expect(props('# sem front matter\n')).toEqual({ kind: 'none' });
    expect(props('---\nsem fechamento\n')).toEqual({ kind: 'none' });
    expect(compactValue(null)).toBe('');
    expect(compactValue(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
    expect(compactValue(true)).toBe('true');
  });
});
