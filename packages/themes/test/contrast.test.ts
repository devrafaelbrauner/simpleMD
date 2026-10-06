import { describe, expect, test } from 'vitest';
import { BUILTIN_THEMES } from '../src';

/** Luminância relativa WCAG 2.x de uma cor `#rgb`/`#rrggbb` (alfa ignorado: cores opacas). */
function luminance(hex: string): number {
  const digits = hex.slice(1);
  const full = digits.length <= 4 ? [...digits.slice(0, 3)].map((c) => c + c).join('') : digits;
  const channels = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** AC-4.12: pares e mínimos. As cores vêm dos objetos de tema, nunca de literais. */
const PAIRS = [
  ['--color-fg', '--color-bg', 4.5],
  ['--color-muted', '--color-bg', 4.5],
  ['--color-accent', '--color-bg', 3],
  ['--color-fg', '--color-code-bg', 4.5],
  ['--color-fg', '--color-sidebar-bg', 4.5],
] as const;

describe('contraste dos temas embutidos (AC-4.12)', () => {
  test.each(BUILTIN_THEMES.flatMap((t) => PAIRS.map((p) => [t.id, ...p] as const)))(
    '%s: %s sobre %s ≥ %d:1',
    (id, fg, bg, min) => {
      const theme = BUILTIN_THEMES.find((t) => t.id === id);
      const a = theme?.tokens[fg];
      const b = theme?.tokens[bg];
      expect(a).toMatch(/^#[0-9a-f]{6}$/i);
      expect(b).toMatch(/^#[0-9a-f]{6}$/i);
      // Truncado em 2 casas (DESIGN §4: 2,999 reprova).
      expect(Math.floor(ratio(a ?? '', b ?? '') * 100) / 100).toBeGreaterThanOrEqual(min);
    },
  );

  test('o destaque também passa 4,5:1 sobre o fundo (links como texto, C-4)', () => {
    for (const theme of BUILTIN_THEMES) {
      const accent = theme.tokens['--color-accent'] ?? '';
      const bg = theme.tokens['--color-bg'] ?? '';
      expect(ratio(accent, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
