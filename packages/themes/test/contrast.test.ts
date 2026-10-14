import { describe, expect, test } from 'vitest';
import { BUILTIN_THEMES, FOLDER_COLOR_IDS } from '../src';

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

/** Truncado em 2 casas (DESIGN r12 §3.3: 2,999 reprova). */
const truncated = (a: string, b: string) => Math.floor(ratio(a, b) * 100) / 100;

/** Fundos das superfícies coloridas: aba ativa/lista, aba inativa/explorador, hover/opção ativa. */
const SURFACES = ['--color-bg', '--color-sidebar-bg', '--color-hover'] as const;

describe('r12: cores de pasta nos temas embutidos (NFR-12.1, NFR-12.2)', () => {
  test.each(
    BUILTIN_THEMES.flatMap((t) =>
      FOLDER_COLOR_IDS.flatMap((id) => SURFACES.map((bg) => [t.id, id, bg] as const)),
    ),
  )('%s: --color-folder-%s sobre %s ≥ 3:1 (faixa, bolinhas)', (themeId, id, bg) => {
    const theme = BUILTIN_THEMES.find((t) => t.id === themeId);
    const color = theme?.tokens[`--color-folder-${id}`] ?? '';
    const surface = theme?.tokens[bg] ?? '';
    expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(surface).toMatch(/^#[0-9a-f]{6}$/i);
    expect(truncated(color, surface)).toBeGreaterThanOrEqual(3);
  });

  test.each(BUILTIN_THEMES.flatMap((t) => SURFACES.map((bg) => [t.id, bg] as const)))(
    '%s: origem (--color-muted) sobre %s ≥ 4,5:1',
    (themeId, bg) => {
      const theme = BUILTIN_THEMES.find((t) => t.id === themeId);
      expect(
        truncated(theme?.tokens['--color-muted'] ?? '', theme?.tokens[bg] ?? ''),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );
});

type Rgb = readonly [number, number, number];

/** `#rrggbb` → canais sRGB codificados em [0, 1]. */
function rgb(hex: string): Rgb {
  expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map(
    (i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255,
  );
  return [r, g, b];
}

/** `color-mix(in srgb, a p, b)`: interpolação linear por canal no sRGB codificado (DESIGN r13 §3.1). */
const mix = (a: Rgb, p: number, b: Rgb): Rgb => [
  a[0] * p + b[0] * (1 - p),
  a[1] * p + b[1] * (1 - p),
  a[2] * p + b[2] * (1 - p),
];

function rgbRatio(a: Rgb, b: Rgb): number {
  const lum = (c: Rgb) => {
    const [r, g, bl] = c.map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)) as [
      number,
      number,
      number,
    ];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Razão truncada em 2 casas, a menor entre o cálculo exato e o das cores quantizadas em 8 bits
 * (o que a tela pinta; DESIGN r13 §4.1).
 */
function mixedRatio(a: Rgb, b: Rgb): number {
  const q8 = (c: Rgb): Rgb => [
    Math.round(c[0] * 255) / 255,
    Math.round(c[1] * 255) / 255,
    Math.round(c[2] * 255) / 255,
  ];
  return Math.floor(Math.min(rgbRatio(a, b), rgbRatio(q8(a), q8(b))) * 100) / 100;
}

/** Borda em hover: 85 % do tom em direção ao `fg` (D-R13-D02). */
const EDGE_HOVER = 0.85;
const LEVELS = ['subtle', 'medium', 'strong'] as const;

describe('r13: tingimento do explorador nos temas embutidos (NFR-13.1, NFR-13.2, NFR-13.3)', () => {
  test.each(
    BUILTIN_THEMES.flatMap((t) =>
      LEVELS.flatMap((level) => FOLDER_COLOR_IDS.map((id) => [t.id, level, id] as const)),
    ),
  )('%s, %s, %s: texto ≥ 4,5 e anel fg ≥ 3 nas pontas; borda ≥ 3', (themeId, level, id) => {
    const tokens = BUILTIN_THEMES.find((t) => t.id === themeId)?.tokens ?? {};
    const pct = (name: string) => Number.parseFloat(tokens[name] ?? '') / 100;
    const tint = pct(`--dimension-folder-tint-${level}`);
    const peak = pct(`--dimension-folder-peak-${level}`);
    const inherit = pct('--dimension-folder-inherit');
    for (const p of [tint, peak, inherit]) expect(p).toBeGreaterThan(0);
    const color = rgb(tokens[`--color-folder-${id}`] ?? '');
    const sidebar = rgb(tokens['--color-sidebar-bg'] ?? '');
    const hover = rgb(tokens['--color-hover'] ?? '');
    const fg = rgb(tokens['--color-fg'] ?? '');
    for (const source of ['own', 'inherited'] as const) {
      const tone = source === 'own' ? color : mix(color, inherit, sidebar);
      const fillN = mix(tone, tint, sidebar);
      const fillH = mix(tone, tint, hover);
      // K1 (NFR-13.1) no cartão e nas 2 pontas do degradê, normal e hover; o anel é `fg` (F4), então
      // K3 (NFR-13.3, ≥ 3) vale por construção com a mesma conta.
      for (const surface of [fillN, fillH, mix(tone, peak, sidebar), mix(tone, peak, hover)])
        expect(mixedRatio(fg, surface)).toBeGreaterThanOrEqual(4.5);
      expect(mixedRatio(fg, sidebar)).toBeGreaterThanOrEqual(3);
      if (source === 'inherited') continue; // borda da herdeira é decorativa (D-R13-D05)
      // K2 (NFR-13.2): borda × explorador e × cartão; em hover, a borda reforçada.
      const edgeHover = mix(tone, EDGE_HOVER, fg);
      expect(mixedRatio(tone, sidebar)).toBeGreaterThanOrEqual(3);
      expect(mixedRatio(tone, fillN)).toBeGreaterThanOrEqual(3);
      expect(mixedRatio(edgeHover, fillH)).toBeGreaterThanOrEqual(3);
      expect(mixedRatio(edgeHover, hover)).toBeGreaterThanOrEqual(3);
    }
  });
});
