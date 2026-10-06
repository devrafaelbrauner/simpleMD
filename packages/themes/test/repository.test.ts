import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { LocalFsProvider } from '@simplemd/vault';
import { MemoryFsPort } from '@simplemd/vault/testing';
import { describe, expect, test } from 'vitest';
import {
  REQUIRED_TOKENS,
  THEME_MAX_BYTES,
  VAULT_READ_LIMITS,
  exportThemeBytes,
  generateThemeJson,
  importTheme,
  lightTokens,
  listUserThemes,
  saveTheme,
  serializeTheme,
  simplemdDark,
  simplemdLight,
  slugify,
  themeFilePath,
  validateTheme,
} from '../src';
import cases from './fixtures/import-cases.json';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const sha = (bytes: Uint8Array | null) =>
  bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
const DARK_JSON = new URL('../src/builtin/simplemd-dark.json', import.meta.url);

async function vault(files: Record<string, string | Uint8Array> = {}) {
  const port = new MemoryFsPort();
  port.seed({ 'nota.md': '# Nota\n', ...files });
  const provider = new LocalFsProvider(port, { readLimits: VAULT_READ_LIMITS });
  const handle = await provider.open();
  const calls = () => port.calls().length;
  const writes = () => port.calls().filter((c) => c.op === 'writeFile');
  return { port, provider, handle, calls, writes };
}

const okTheme = () => {
  const result = validateTheme(cases.ok);
  if (!result.ok) throw new Error('fixture ok inválida');
  return result.theme;
};

describe('gerador (R-5.3, AC-5.3)', () => {
  test('saída igual ao golden byte a byte; valida no esquema v1; sem css', () => {
    const input = validateTheme(fixture('golden-input.json').toString('utf8'));
    if (!input.ok) throw new Error('golden-input inválido');
    // Um rascunho com `css` (ex.: partindo de um tema importado) ainda gera um arquivo sem `css`.
    const draft = { ...input.theme, css: 'ignorado.css' };
    const text = generateThemeJson(draft);
    expect(text).toBe(fixture('golden-theme.json').toString('utf8'));
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).not.toContain('"css"');
    const parsed = validateTheme(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(Object.keys(parsed.theme.tokens).sort()).toEqual([...REQUIRED_TOKENS].sort());
  });

  test('slugify', () => {
    expect(slugify('Meu Tema')).toBe('meu-tema');
    expect(slugify('  Ação & Reação!  ')).toBe('acao-reacao');
    expect(slugify('!!!')).toBe('tema');
    expect(slugify('x'.repeat(100))).toHaveLength(60);
    expect(slugify('simpleMD Escuro')).toBe('simplemd-escuro');
  });
});

describe('salvar (R-5.4, AC-5.6, AC-5.11)', () => {
  test('"Meu Tema" → .simplemd/themes/meu-tema/theme.json; de novo → meu-tema-2 e -3; o original não muda', async () => {
    const v = await vault();
    const theme = okTheme();
    const first = await saveTheme(v.provider, v.handle, theme);
    expect(first.id).toBe('meu-tema');
    expect(v.port.readText(themeFilePath('meu-tema'))).toBe(serializeTheme(theme));
    const before = sha(v.port.readBytes(themeFilePath('meu-tema')));
    expect((await saveTheme(v.provider, v.handle, theme)).id).toBe('meu-tema-2');
    expect((await saveTheme(v.provider, v.handle, theme)).id).toBe('meu-tema-3');
    expect(sha(v.port.readBytes(themeFilePath('meu-tema')))).toBe(before);
    expect(v.writes().every((c) => c.mode === 'create-new')).toBe(true);
  });

  test('ids de embutidos são reservados: "simplemd-dark" vira simplemd-dark-2; embutidos não mudam', async () => {
    const v = await vault();
    const darkBefore = sha(readFileSync(DARK_JSON));
    const { id } = await saveTheme(v.provider, v.handle, { ...okTheme(), name: 'simplemd dark' });
    expect(id).toBe('simplemd-dark-2');
    // AC-5.11: partir de um embutido cria um tema novo; o arquivo embutido segue igual.
    const fromBuiltin = await saveTheme(v.provider, v.handle, {
      name: `${simplemdLight.name} (cópia)`,
      base: 'light',
      tokens: Object.fromEntries(REQUIRED_TOKENS.map((k) => [k, lightTokens[k] ?? ''])),
    });
    expect(fromBuiltin.id).toBe('simplemd-claro-copia');
    expect(sha(readFileSync(DARK_JSON))).toBe(darkBefore);
  });

  test('uma pasta que já existe (mesmo sem theme.json) não é reutilizada', async () => {
    const v = await vault({ [`.simplemd/themes/meu-tema/leia.md`]: 'x' });
    expect((await saveTheme(v.provider, v.handle, okTheme())).id).toBe('meu-tema-2');
  });
});

describe('listar (C-11)', () => {
  test('lista os temas válidos; inválidos viram aviso com id e campo', async () => {
    const v = await vault({
      [themeFilePath('bom')]: serializeTheme(okTheme()),
      [themeFilePath('ruim')]: '{"name":"R","base":"light","tokens":{"--bg":"#fff"}}',
      [themeFilePath('simplemd-dark')]: serializeTheme(okTheme()),
      '.simplemd/themes/Maiusculo/theme.json': serializeTheme(okTheme()),
    });
    const { themes, warnings } = await listUserThemes(v.provider, v.handle);
    expect(themes.map((t) => [t.id, t.name, t.builtin])).toEqual([['bom', 'Meu Tema', false]]);
    expect(warnings).toEqual([expect.objectContaining({ id: 'ruim', field: 'tokens.--bg' })]);
  });

  test('sem pasta de temas: lista vazia', async () => {
    const v = await vault();
    await expect(listUserThemes(v.provider, v.handle)).resolves.toEqual({
      themes: [],
      warnings: [],
    });
  });

  test('theme.json maior que 256 KB: aviso, sem ler o conteúdo', async () => {
    const big = `{"name":"x","base":"light","tokens":{"--color-bg":"#000"},"css":"${'a'.repeat(THEME_MAX_BYTES)}"}`;
    const v = await vault({ [themeFilePath('grande')]: big });
    const { themes, warnings } = await listUserThemes(v.provider, v.handle);
    expect(themes).toEqual([]);
    expect(warnings).toEqual([{ id: 'grande', field: 'arquivo', message: 'maior que 256 KB' }]);
    expect(v.port.calls().some((c) => c.op === 'readFile' && c.abs.includes('grande'))).toBe(false);
  });
});

describe('importar (R-5.6, AC-5.8–5.10)', () => {
  test.each(cases.invalid)(
    'inválido ($case): campo nomeado e 0 chamadas ao provider',
    async (c) => {
      const v = await vault();
      v.port.resetCalls();
      const result = await importTheme(v.provider, v.handle, new TextEncoder().encode(c.text));
      expect(result).toMatchObject({ ok: false, error: { field: c.field } });
      expect(v.calls()).toBe(0);
    },
  );

  test('257 KB: "arquivo" e 0 chamadas', async () => {
    const v = await vault();
    v.port.resetCalls();
    const result = await importTheme(v.provider, v.handle, new Uint8Array(257 * 1024).fill(32));
    expect(result).toEqual({ ok: false, error: { field: 'arquivo', message: 'maior que 256 KB' } });
    expect(v.calls()).toBe(0);
  });

  test('válido: copiado com a regra de slug e reserializado; aparece na listagem', async () => {
    const v = await vault();
    const raw = new TextEncoder().encode(`  ${JSON.stringify(cases.ok)}\r\n`);
    const result = await importTheme(v.provider, v.handle, raw);
    expect(result).toMatchObject({ ok: true, theme: { id: 'meu-tema', name: 'Meu Tema' } });
    expect(v.port.readText(themeFilePath('meu-tema'))).toBe(serializeTheme(okTheme()));
    const again = await importTheme(v.provider, v.handle, raw);
    expect(again).toMatchObject({ ok: true, theme: { id: 'meu-tema-2' } });
    const { themes } = await listUserThemes(v.provider, v.handle);
    expect(themes.map((t) => t.id)).toEqual(['meu-tema', 'meu-tema-2']);
  });

  test('AC-5.10: o campo css passa intacto por importar e exportar; nada é carregado', async () => {
    const v = await vault();
    const imported = await importTheme(
      v.provider,
      v.handle,
      new TextEncoder().encode(JSON.stringify(cases.withCss)),
    );
    if (!imported.ok) throw new Error('import falhou');
    expect(imported.theme.css).toBe('x.css');
    const exported = new TextDecoder().decode(
      await exportThemeBytes(v.provider, v.handle, imported.theme),
    );
    expect(JSON.parse(exported)).toEqual(cases.withCss);
    // Só o theme.json foi gravado: nenhum outro arquivo (nem o x.css) foi lido ou criado.
    expect(v.writes().map((c) => c.abs)).toEqual([`/vault/${themeFilePath('com-css')}`]);
    expect(v.port.calls().some((c) => c.abs.endsWith('x.css'))).toBe(false);
  });
});

describe('exportar (R-5.5, AC-5.7, U-6)', () => {
  test('tema do vault: os bytes gravados, mesmo editados à mão (CRLF + BOM)', async () => {
    const handmade = `\uFEFF{\r\n "name": "A mão", "base": "dark",\r\n "tokens": {"--color-bg": "#123"}\r\n}\r\n`;
    const v = await vault({ [themeFilePath('a-mao')]: handmade });
    const [theme] = (await listUserThemes(v.provider, v.handle)).themes;
    if (!theme) throw new Error('tema não listado');
    const bytes = await exportThemeBytes(v.provider, v.handle, theme);
    expect(sha(bytes)).toBe(sha(v.port.readBytes(themeFilePath('a-mao'))));
  });

  test('embutido: o conjunto completo composto (37 tokens), determinístico', async () => {
    const bytes = await exportThemeBytes(
      new LocalFsProvider(new MemoryFsPort()),
      null,
      simplemdDark,
    );
    const text = new TextDecoder().decode(bytes);
    const parsed = validateTheme(text);
    expect(parsed).toMatchObject({ ok: true, theme: { name: 'simpleMD Escuro', base: 'dark' } });
    if (parsed.ok) expect(parsed.theme.tokens).toEqual(simplemdDark.tokens);
    expect(Object.keys(simplemdDark.tokens)).toHaveLength(37);
    expect(text).toBe(serializeTheme(simplemdDark));
  });
});
