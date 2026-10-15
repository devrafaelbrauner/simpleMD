import { describe, expect, test } from 'vitest';
import {
  FOLDER_COLOR_IDS,
  FONT_OPTIONS,
  clampFontSize,
  darkOverrides,
  isFontFamilyName,
  lightTokens,
  parseTokensCss,
  prefTokens,
  resolveTokens,
  simplemdDark,
  validateTheme,
} from '../src';
import cases from './fixtures/precedence-cases.json';

const validated = validateTheme(cases.customFira);
if (!validated.ok) throw new Error('fixture customFira inválida');
const custom = validated.theme;
const family = cases.prefs.fontFamily;
if (!isFontFamilyName(family)) throw new Error('fixture prefs inválida');
const prefs = { fontFamily: family, fontSize: cases.prefs.fontSize };

describe('resolveTokens (R-4.2, R-4.4, AC-4.13)', () => {
  test('preferência > tema > base: a família e o tamanho do usuário vencem o tema', () => {
    const resolved = resolveTokens(custom, prefs);
    expect(resolved['--fontFamily-mono']?.startsWith(cases.expectedFirstFamily)).toBe(true);
    expect(resolved['--dimension-font-size']).toBe(cases.expectedSize);
    expect(resolved['--color-accent']).toBe(cases.expectedAccent);
  });

  test('sem preferências, o tema vence a base; o que falta vem da base escura (e do claro)', () => {
    const resolved = resolveTokens(custom);
    for (const [name, value] of Object.entries(custom.tokens)) expect(resolved[name]).toBe(value);
    expect(resolved['--color-bg']).toBe(darkOverrides['--color-bg']);
    expect(resolved['--duration-fast']).toBe(lightTokens['--duration-fast']);
    expect(Object.keys(resolved)).toHaveLength(Object.keys(lightTokens).length + 1);
  });

  test('o escuro embutido resolve para os mesmos tokens do objeto composto', () => {
    expect(resolveTokens(simplemdDark)).toEqual(simplemdDark.tokens);
  });

  test('r12 (AC-12.10, P6): tema sem --color-folder-* herda o padrão do tipo; com 1 token, ele vence', () => {
    const light = resolveTokens({ ...custom, base: 'light', tokens: {} });
    const dark = resolveTokens({ ...custom, base: 'dark', tokens: {} });
    for (const id of FOLDER_COLOR_IDS) {
      const name = `--color-folder-${id}`;
      expect(light[name]).toBe(lightTokens[name]);
      expect(dark[name]).toBe(darkOverrides[name]);
    }
    const own = resolveTokens({
      ...custom,
      tokens: { ...custom.tokens, '--color-folder-blue': cases.expectedAccent },
    });
    expect(own['--color-folder-blue']).toBe(cases.expectedAccent);
    expect(own['--color-folder-red']).toBe(darkOverrides['--color-folder-red']);
  });

  test('r13 (R-13.8, AC-13.9): tema sem --dimension-folder-* herda o padrão do tipo; com 1, ele vence', () => {
    const light = resolveTokens({ ...custom, base: 'light', tokens: {} });
    const dark = resolveTokens({ ...custom, base: 'dark', tokens: {} });
    const names = Object.keys(lightTokens).filter((n) => n.startsWith('--dimension-folder-'));
    expect(names).toHaveLength(7);
    for (const name of names) {
      expect(light[name]).toBe(lightTokens[name]);
      expect(dark[name]).toBe(darkOverrides[name]);
    }
    expect(dark['--dimension-folder-tint-medium']).not.toBe(
      light['--dimension-folder-tint-medium'],
    );
    const own = resolveTokens({
      ...custom,
      tokens: { ...custom.tokens, '--dimension-folder-tint-medium': '30%' },
    });
    expect(own['--dimension-folder-tint-medium']).toBe('30%');
    expect(own['--dimension-folder-peak-medium']).toBe(
      darkOverrides['--dimension-folder-peak-medium'],
    );
  });

  test('prefTokens usa a pilha de fonts.json e <n>px', () => {
    for (const font of FONT_OPTIONS) {
      expect(prefTokens({ fontFamily: font.label, fontSize: 12 })).toEqual({
        '--fontFamily-mono': font.stack,
        '--dimension-font-size': `${12}px`,
      });
    }
  });
});

describe('tamanho da fonte (AC-4.6, UX-D17)', () => {
  test('9 → 10, 33 → 32, fracionário arredonda', () => {
    expect(clampFontSize(9)).toBe(10);
    expect(clampFontSize(33)).toBe(32);
    expect(clampFontSize(10)).toBe(10);
    expect(clampFontSize(32)).toBe(32);
    expect(clampFontSize(17.4)).toBe(17);
  });
});

describe('parseTokensCss', () => {
  test('aceita CRLF e comentários; valores ficam como estão (só trim)', () => {
    const css = ':root {\r\n  /* c */ --color-a:  #abc ;\r\n  --fontFamily-x: "A B", c;\r\n}\r\n';
    expect(parseTokensCss(css)).toEqual({ '--color-a': '#abc', '--fontFamily-x': '"A B", c' });
  });
});
