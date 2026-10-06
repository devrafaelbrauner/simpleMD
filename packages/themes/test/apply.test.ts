// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import { applyTheme, resolveTokens, simplemdDark, validateTheme, withThemeWindow } from '../src';
import cases from './fixtures/precedence-cases.json';

const validated = validateTheme(cases.customFira);
if (!validated.ok) throw new Error('fixture customFira inválida');
const themeA = validated.theme;

const inlineKeys = (el: HTMLElement) =>
  Array.from({ length: el.style.length }, (_, i) => el.style.item(i)).filter((k) =>
    k.startsWith('--'),
  );

describe('applyTheme (R-4.3, AC-4.3, DESIGN §10)', () => {
  test('A e depois B: as propriedades da raiz são as de B sobre a base de B, sem sobras de A', () => {
    const root = document.documentElement;
    const raf = vi.fn((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const a = resolveTokens(themeA);
    const prev = applyTheme(root, a, undefined, { raf, base: 'dark' });
    expect(root.style.getPropertyValue('--color-extra')).toBe(themeA.tokens['--color-extra']);

    const b = resolveTokens(simplemdDark);
    const keys = applyTheme(root, b, prev, { raf, base: 'dark' });
    expect(new Set(inlineKeys(root))).toEqual(new Set(Object.keys(b)));
    expect(keys).toEqual(new Set(Object.keys(b)));
    for (const [name, value] of Object.entries(b))
      expect(root.style.getPropertyValue(name)).toBe(value);
    expect(root.style.getPropertyValue('--color-extra')).toBe('');
    expect(root.dataset.themeBase).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
  });

  test('a escrita acontece com data-theme-applying, que sai só no quadro seguinte', () => {
    const el = document.createElement('div');
    const frames: FrameRequestCallback[] = [];
    const seen: Array<string | null> = [];
    withThemeWindow(
      el,
      () => {
        seen.push(el.getAttribute('data-theme-applying'));
        el.style.setProperty('--color-bg', simplemdDark.tokens['--color-bg'] ?? null);
      },
      { raf: (cb) => frames.push(cb) },
    );
    expect(seen).toEqual(['']);
    expect(el.hasAttribute('data-theme-applying')).toBe(true);
    frames[0]?.(0);
    expect(el.hasAttribute('data-theme-applying')).toBe(false);
  });
});
