import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  BUILTIN_THEMES,
  DEFAULT_PREFERENCES,
  FOLDER_COLOR_IDS,
  FONT_OPTIONS,
  REQUIRED_TOKENS,
  darkOverrides,
  lightTokens,
  missingRequiredTokens,
  parseTokensCss,
  serializeTheme,
  simplemdDark,
  simplemdLight,
  validateTheme,
} from '../src';

const SRC = new URL('../src/', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, SRC), 'utf8');

describe('temas embutidos (AC-4.1, D-1)', () => {
  test.each(BUILTIN_THEMES)('$id valida no esquema v1 e define os 11 tokens obrigatórios', (t) => {
    expect(validateTheme({ name: t.name, base: t.base, tokens: t.tokens })).toMatchObject({
      ok: true,
    });
    expect(missingRequiredTokens(t.tokens)).toEqual([]);
    expect(REQUIRED_TOKENS).toHaveLength(11);
  });

  test('o claro é a própria tokens.css (52 tokens, valores idênticos, única fonte)', () => {
    const fromFile = parseTokensCss(read('tokens.css'));
    expect(Object.keys(fromFile)).toHaveLength(52);
    expect(lightTokens).toEqual(fromFile);
    expect(simplemdLight).toMatchObject({
      id: 'simplemd-light',
      name: 'simpleMD Claro',
      base: 'light',
    });
  });

  test('o escuro é simplemd-dark.json composto sobre o claro; o JSON já está serializado', () => {
    const raw = read('builtin/simplemd-dark.json');
    const parsed = validateTheme(raw);
    if (!parsed.ok) throw new Error(`simplemd-dark.json inválido: ${parsed.error.field}`);
    const json = parsed.theme;
    expect(darkOverrides).toEqual(json.tokens);
    expect(simplemdDark).toMatchObject({
      id: 'simplemd-dark',
      name: 'simpleMD Escuro',
      base: 'dark',
    });
    expect(simplemdDark.tokens).toEqual({ ...lightTokens, ...json.tokens });
    expect(serializeTheme(json)).toBe(raw);
    // Só cores e as porcentagens de tingimento do explorador mudam no escuro (DESIGN §3.3; r13 F2).
    expect(
      Object.keys(json.tokens).every(
        (name) => name.startsWith('--color-') || name.startsWith('--dimension-folder-'),
      ),
    ).toBe(true);
  });

  test('r12 (AC-12.10, P6): os 8 --color-folder-<id> existem no claro e no escuro, fora dos obrigatórios', () => {
    const names = FOLDER_COLOR_IDS.map((id) => `--color-folder-${id}`);
    for (const name of names) {
      expect(lightTokens[name]).toMatch(/^#[0-9a-f]{6}$/);
      expect(darkOverrides[name]).toMatch(/^#[0-9a-f]{6}$/);
      expect(darkOverrides[name]).not.toBe(lightTokens[name]);
      expect(REQUIRED_TOKENS as readonly string[]).not.toContain(name);
    }
    // Tema com só os 11 obrigatórios continua válido (tokens de pasta são opcionais).
    const required = Object.fromEntries(REQUIRED_TOKENS.map((name) => [name, lightTokens[name]]));
    expect(
      validateTheme({ name: 'Só obrigatórios', base: 'light', tokens: required }),
    ).toMatchObject({ ok: true });
  });

  test('r13 (R-13.8, D-R13-F2): os 7 --dimension-folder-* são % no claro e no escuro, fora dos obrigatórios', () => {
    const names = [
      '--dimension-folder-tint-subtle',
      '--dimension-folder-tint-medium',
      '--dimension-folder-tint-strong',
      '--dimension-folder-peak-subtle',
      '--dimension-folder-peak-medium',
      '--dimension-folder-peak-strong',
      '--dimension-folder-inherit',
    ];
    expect(
      Object.keys(lightTokens)
        .filter((n) => n.startsWith('--dimension-folder-'))
        .sort(),
    ).toEqual([...names].sort());
    expect(
      Object.keys(darkOverrides)
        .filter((n) => n.startsWith('--dimension-folder-'))
        .sort(),
    ).toEqual([...names].sort());
    const percent = (value: string | undefined) => {
      expect(value).toMatch(/^\d{1,2}%$/);
      return Number.parseInt(value ?? '', 10);
    };
    for (const tokens of [lightTokens, simplemdDark.tokens]) {
      for (const level of ['subtle', 'medium', 'strong']) {
        // A ponta saturada do degradê é sempre mais forte que o cartão (DESIGN §3.3).
        expect(percent(tokens[`--dimension-folder-peak-${level}`])).toBeGreaterThan(
          percent(tokens[`--dimension-folder-tint-${level}`]),
        );
      }
      expect(percent(tokens['--dimension-folder-tint-subtle'])).toBeLessThan(
        percent(tokens['--dimension-folder-tint-medium']),
      );
      expect(percent(tokens['--dimension-folder-tint-medium'])).toBeLessThan(
        percent(tokens['--dimension-folder-tint-strong']),
      );
    }
    for (const name of names) expect(REQUIRED_TOKENS as readonly string[]).not.toContain(name);
  });

  test('nenhum JSON de tema claro escrito à mão no pacote (V-22)', () => {
    const jsonFiles = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.json'),
    );
    const light = jsonFiles.filter((f) => /"base":\s*"light"/.test(read(f)));
    expect(light).toEqual([]);
  });

  test('a pilha da JetBrains Mono em fonts.json é igual a --fontFamily-mono (V-23)', () => {
    expect(FONT_OPTIONS.map((f) => f.label)).toEqual([
      'JetBrains Mono',
      'Fira Code',
      'Cascadia Code',
      'Monospace do sistema',
    ]);
    expect(FONT_OPTIONS[0]?.stack).toBe(lightTokens['--fontFamily-mono']);
    expect(FONT_OPTIONS[3]?.stack.startsWith('ui-monospace')).toBe(true);
  });

  test('preferências padrão reproduzem os valores congelados (design-ack §5.5)', () => {
    expect(DEFAULT_PREFERENCES.fontFamily).toBe('JetBrains Mono');
    expect(`${DEFAULT_PREFERENCES.fontSize}px`).toBe(lightTokens['--dimension-font-size']);
    expect(DEFAULT_PREFERENCES).toMatchObject({ theme: 'simplemd-light', fontLigatures: true });
  });
});

describe('fontes embutidas (AC-4.8, R-4.5)', () => {
  const FONTS = [
    ['jetbrains-mono', 'JetBrainsMono', 'JetBrains Mono'],
    ['fira-code', 'FiraCode', 'Fira Code'],
    ['cascadia-code', 'CascadiaCode', 'Cascadia Code'],
  ] as const;

  test.each(FONTS)('%s: woff2 Regular/Bold, OFL.txt e SOURCE.md', (dir, file, family) => {
    for (const weight of ['Regular', 'Bold']) {
      const bytes = readFileSync(new URL(`fonts/${dir}/${file}-${weight}.woff2`, SRC));
      expect(bytes.subarray(0, 4).toString('latin1')).toBe('wOF2');
    }
    const license = read(`fonts/${dir}/OFL.txt`);
    expect(license).toContain('SIL Open Font License, Version 1.1');
    expect(license).toContain('Copyright');
    expect(read(`fonts/${dir}/SOURCE.md`)).toContain('sha256');
    expect(read('fonts.css')).toMatch(new RegExp(`font-family: ['"]${family}['"];`));
  });

  test('fonts.css só usa arquivos locais (sem local() nem URLs remotas)', () => {
    const css = read('fonts.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const urls = [...css.matchAll(/url\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    expect(urls).toHaveLength(6);
    expect(urls.every((u) => u?.startsWith('./fonts/') && u.endsWith('.woff2'))).toBe(true);
    expect(css).not.toMatch(/local\(|https?:/);
    for (const url of urls) expect(readFileSync(new URL(url ?? '', SRC)).length).toBeGreaterThan(0);
  });
});
