import { describe, expect, test } from 'vitest';
import { newNotePathForWikilink } from '../src/index';

/** Nome de nota nova por wikilink (R-I2.5, AC-I2.4 parte VT; arch-backend r7 §1.6). */
describe('newNotePathForWikilink — caminhos aceitos', () => {
  test.each([
    ['Diário/hoje.md', 'Nova ideia', 'Diário/Nova ideia.md'],
    ['raiz.md', 'Nova ideia', 'Nova ideia.md'],
    ['a/b/c.md', 'x/y/z', 'x/y/z.md'],
    ['a/b.md', '  Espaços nas pontas  ', 'a/Espaços nas pontas.md'],
    ['a/b.md', 'Com extensão.MD', 'a/Com extensão.md'],
    ['a/b.md', '/raiz/nota', 'raiz/nota.md'],
    ['a/b.md', '/nota', 'nota.md'],
    ['a/b.md', 'Cafe\u0301', 'a/Café.md'],
    ['a/b.md', 'console', 'a/console.md'],
    ['a/b.md', 'COM10', 'a/COM10.md'],
  ])('%s + [[%s]] → %s', (from, target, rel) => {
    expect(newNotePathForWikilink(from, target)).toEqual({ ok: true, rel });
  });
});

describe('newNotePathForWikilink — nomes inválidos (≥ 12 casos, 0 gravações no app)', () => {
  test.each([
    ['CON', 'RESERVED_NAME', 'CON'],
    ['con.txt', 'RESERVED_NAME', 'CON'],
    ['pasta/LPT9', 'RESERVED_NAME', 'LPT9'],
    ['nul', 'RESERVED_NAME', 'NUL'],
    ['a:b', 'FORBIDDEN_CHAR', ':'],
    ['a*b', 'FORBIDDEN_CHAR', '*'],
    ['a?b', 'FORBIDDEN_CHAR', '?'],
    ['a"b', 'FORBIDDEN_CHAR', '"'],
    ['a<b', 'FORBIDDEN_CHAR', '<'],
    ['a>b', 'FORBIDDEN_CHAR', '>'],
    ['a\\b', 'FORBIDDEN_CHAR', '\\'],
    ['a\u0007b', 'CONTROL_CHAR', undefined],
    ['abc\u202Edm.exe', 'FORMAT_CHAR', undefined],
    ['a\u200Bb', 'FORMAT_CHAR', undefined],
    ['pasta\u2066/x', 'FORMAT_CHAR', undefined],
    ['.simplemd/x', 'HIDDEN_SEGMENT', undefined],
    ['.oculta', 'HIDDEN_SEGMENT', undefined],
    ['x.', 'TRAILING_DOT_OR_SPACE', undefined],
    ['pasta /x', 'TRAILING_DOT_OR_SPACE', undefined],
    ['a/../b', 'DOT_SEGMENT', undefined],
    ['a/./b', 'DOT_SEGMENT', undefined],
    ['a//b', 'EMPTY', undefined],
    ['   ', 'EMPTY', undefined],
    ['é'.repeat(127), 'SEGMENT_TOO_LONG', undefined],
  ])('[[%s]] → %s', (target, reason, detail) => {
    const result = newNotePathForWikilink('notas/atual.md', target);
    expect(result).toEqual(
      detail === undefined ? { ok: false, reason } : { ok: false, reason, detail },
    );
  });

  test('segmento de pasta pode ter 255 bytes; o último conta com ".md"', () => {
    expect(newNotePathForWikilink('a.md', `${'p'.repeat(255)}/n`).ok).toBe(true);
    expect(newNotePathForWikilink('a.md', 'n'.repeat(252)).ok).toBe(true);
    expect(newNotePathForWikilink('a.md', 'n'.repeat(253))).toEqual({
      ok: false,
      reason: 'SEGMENT_TOO_LONG',
    });
  });

  test('CR-S2-03: `~` no início do caminho na raiz → NOT_ALLOWED (a guarda do vault); dentro de pasta é aceito', () => {
    expect(newNotePathForWikilink('raiz.md', '~x')).toEqual({ ok: false, reason: 'NOT_ALLOWED' });
    expect(newNotePathForWikilink('a.md', '/~x')).toEqual({ ok: false, reason: 'NOT_ALLOWED' });
    expect(newNotePathForWikilink('a.md', 'p/~x')).toEqual({ ok: true, rel: 'p/~x.md' });
  });

  test('caminho final > 1.024 caracteres → PATH_TOO_LONG', () => {
    const deep = Array.from({ length: 6 }, () => 'p'.repeat(200)).join('/');
    expect(newNotePathForWikilink('a.md', deep)).toEqual({ ok: false, reason: 'PATH_TOO_LONG' });
  });
});
