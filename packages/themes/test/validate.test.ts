import { describe, expect, test } from 'vitest';
import { THEME_MAX_BYTES, validateTheme } from '../src';
import cases from './fixtures/validator-cases.json';

// Todo par nome+valor de token vive no JSON (design-ack §5.4 T-4): nenhum literal aqui.
describe('validateTheme (AC-4.2, R-5.6)', () => {
  test.each(cases.reject)('rejeita: $case', ({ theme, field }) => {
    const result = validateTheme(theme);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe(field);
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  test.each(cases.accept)('aceita: $case', ({ theme }) => {
    const result = validateTheme(theme);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.theme.tokens).toEqual(theme.tokens);
      expect(result.theme.css).toBe('css' in theme ? theme.css : undefined);
    }
  });

  test('arquivo: JSON malformado, raiz que não é objeto, UTF-8 inválido e > 256 KB', () => {
    const asText = (value: unknown) => JSON.stringify(value);
    expect(validateTheme('{ "name": ')).toEqual({
      ok: false,
      error: { field: 'arquivo', message: 'JSON malformado' },
    });
    expect(validateTheme('[]')).toMatchObject({ ok: false, error: { field: 'arquivo' } });
    expect(validateTheme('null')).toMatchObject({ ok: false, error: { field: 'arquivo' } });
    expect(validateTheme(new Uint8Array([0x7b, 0xff, 0x7d]))).toMatchObject({
      ok: false,
      error: { field: 'arquivo', message: 'JSON malformado' },
    });
    const ok = cases.accept[0]?.theme;
    const padded = asText({ ...ok, name: 'x'.repeat(THEME_MAX_BYTES) });
    expect(padded.length).toBeGreaterThan(THEME_MAX_BYTES);
    expect(validateTheme(padded)).toEqual({
      ok: false,
      error: { field: 'arquivo', message: 'maior que 256 KB' },
    });
    expect(validateTheme(new TextEncoder().encode(asText(ok)))).toMatchObject({ ok: true });
  });

  test('nome é aparado; o tema validado não carrega chaves extras', () => {
    const theme = cases.accept[0]?.theme;
    const result = validateTheme({ ...theme, name: '  Com espaços  ' });
    expect(result).toMatchObject({ ok: true, theme: { name: 'Com espaços' } });
    if (result.ok) expect(Object.keys(result.theme).sort()).toEqual(['base', 'name', 'tokens']);
  });
});
