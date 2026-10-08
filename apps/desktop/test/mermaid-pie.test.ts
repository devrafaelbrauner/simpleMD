// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import '../../../packages/plugins-internal/test/setup-svg';
import {
  loadMermaid,
  renderMermaidMarkup,
  themeVariables,
} from '@simplemd/plugins-internal/mermaid/render';
import { applyTheme, BUILTIN_THEMES, lightTokens, type Theme } from '@simplemd/themes';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { exportHtml } from '../src/export/pipeline';

/**
 * A11Y-R2-01 / F-R2-07: pizzas do Mermaid legíveis (WCAG 1.4.11 e 1.4.1) no editor (claro e escuro)
 * e na exportação/impressão (tokens claros, D-19). Toda cor vem dos tokens CALCULADOS; os mínimos
 * são os do DESIGN §4 (razões truncadas em 2 casas).
 */

/** Canais de `#rgb`/`#rrggbb`(/alfa ignorado) ou `rgb(r, g, b)`. */
function channels(color: string): [number, number, number] {
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (hex) {
    const d = hex[1]!;
    const full = d.length <= 4 ? [...d.slice(0, 3)].map((c) => c + c).join('') : d;
    return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [
      number,
      number,
      number,
    ];
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(color.trim());
  if (!rgb) throw new Error(`cor não reconhecida: ${color}`);
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
}

function luminance(color: string): number {
  const [r, g, b] = channels(color).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Razão WCAG 2.x truncada em 2 casas (DESIGN §4: 2,999 reprova). */
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return Math.floor(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

const norm = (color: string) =>
  `#${channels(color)
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')}`;

const PIE = 'pie title Gastos\n  "a" : 4\n  "b" : 3\n  "c" : 2\n  "d" : 1\n';
const SLICES = 12;

/** Os tokens do tema, lidos como o editor lê: estilo calculado do `documentElement`. */
function computedVars(theme: Theme): Record<string, string> {
  applyTheme(document.documentElement, theme.tokens, new Set(), { raf: () => 0 });
  const style = getComputedStyle(document.documentElement);
  return themeVariables((property) => style.getPropertyValue(property));
}

interface PieDom {
  readonly slices: string[];
  readonly legend: string[];
  readonly css: string;
}

function pieDom(svg: SVGSVGElement | Element): PieDom {
  return {
    slices: [...svg.querySelectorAll('path.pieCircle')].map((p) => norm(p.getAttribute('fill')!)),
    legend: [...svg.querySelectorAll('.legend rect')].map((r) =>
      norm((r as SVGElement).style.fill),
    ),
    css: [...svg.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n'),
  };
}

beforeAll(async () => {
  await loadMermaid();
}, 30_000);

afterEach(() => {
  document.documentElement.removeAttribute('style');
});

describe.each(BUILTIN_THEMES.map((theme) => [theme.id, theme] as const))(
  'pizza do Mermaid, tema %s (tokens calculados)',
  (_id, theme) => {
    test('12 fatias distintas; cada uma ≥ 4,5:1 sobre bg (percentual em bg) e vizinhas diferentes', () => {
      const vars = computedVars(theme);
      const bg = theme.tokens['--color-bg']!;
      const fills = Array.from({ length: SLICES }, (_, i) => vars[`pie${i + 1}`]!);
      expect(fills.every((fill) => /^#[0-9a-f]{6}$/i.test(fill))).toBe(true);
      expect(new Set(fills.map(norm)).size).toBe(SLICES);
      for (const fill of fills) {
        // Fatia e quadradinho da legenda: não texto ≥ 3:1; o percentual (cor do fundo) ≥ 4,5:1.
        expect(ratio(fill, bg)).toBeGreaterThanOrEqual(4.5);
        expect(ratio(vars.pieSectionTextColor!, fill)).toBeGreaterThanOrEqual(4.5);
        // Separador entre fatias vizinhas: ≥ 3:1 contra as duas.
        expect(ratio(vars.pieStrokeColor!, fill)).toBeGreaterThanOrEqual(3);
      }
      fills.forEach((fill, i) => expect(norm(fill)).not.toBe(norm(fills[(i + 1) % SLICES]!)));
    });

    test('G-02 (AC-B15.3, D-C1): par (1,2) ≥ 3:1; mínimo entre vizinhas ≥ o de 765b9c1 (1,14)', () => {
      const vars = computedVars(theme);
      const fills = Array.from({ length: SLICES }, (_, i) => vars[`pie${i + 1}`]!);
      expect(ratio(fills[0]!, fills[1]!)).toBeGreaterThanOrEqual(3);
      const neighbours = fills.slice(1).map((fill, i) => ratio(fills[i]!, fill));
      expect(Math.min(...neighbours)).toBeGreaterThanOrEqual(1.14);
    });

    test('contorno externo ≥ 3:1, legenda e título ≥ 4,5:1 sobre bg; fatias opacas', () => {
      const vars = computedVars(theme);
      const bg = theme.tokens['--color-bg']!;
      expect(ratio(vars.pieOuterStrokeColor!, bg)).toBeGreaterThanOrEqual(3);
      expect(ratio(vars.pieLegendTextColor!, bg)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(vars.pieTitleTextColor!, bg)).toBeGreaterThanOrEqual(4.5);
      expect(vars.pieOpacity).toBe('1');
    });

    test('no SVG do editor: fatias e legenda com as mesmas cores distintas, todas ≥ 3:1', async () => {
      const vars = computedVars(theme);
      const bg = theme.tokens['--color-bg']!;
      const markup = await renderMermaidMarkup(PIE, vars);
      const host = document.createElement('div');
      host.innerHTML = markup!;
      const { slices, legend, css } = pieDom(host.querySelector('svg')!);
      expect(slices).toHaveLength(4);
      expect(new Set(slices).size).toBe(4);
      expect(legend).toEqual(slices);
      for (const swatch of legend) expect(ratio(swatch, bg)).toBeGreaterThanOrEqual(3);
      expect(css).toMatch(new RegExp(`\\.pieCircle\\{[^}]*stroke:${norm(bg)}`, 'i'));
      expect(css).toMatch(/\.pieCircle\{[^}]*opacity:1[;}]/);
    });
  },
);

test('exportação e impressão (tokens claros, D-19): fatias e legenda distintas, ≥ 3:1', async () => {
  const html = await exportHtml(`# Nota\n\n\`\`\`mermaid\n${PIE}\`\`\`\n`, 'nota.md', () => true);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const svg = doc.querySelector('figure.smd-mermaid > svg');
  expect(svg).not.toBeNull();
  const bg = lightTokens['--color-bg']!;
  const { slices, legend, css } = pieDom(svg!);
  expect(new Set(slices).size).toBe(4);
  expect(legend).toEqual(slices);
  for (const swatch of legend) expect(ratio(swatch, bg)).toBeGreaterThanOrEqual(3);
  expect(css).toMatch(new RegExp(`\\.pieCircle\\{[^}]*stroke:${norm(bg)}`, 'i'));
  expect(css).toMatch(
    new RegExp(`\\.pieOuterCircle\\{[^}]*stroke:${norm(lightTokens['--color-muted']!)}`, 'i'),
  );
});

test('A11Y-R2-06 (AC-B15.3): pizza exportada com <title> e <desc> "rótulo: valor", na ordem da fonte', async () => {
  const html = await exportHtml(`# Nota\n\n\`\`\`mermaid\n${PIE}\`\`\`\n`, 'nota.md', () => true);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const svg = doc.querySelector('figure.smd-mermaid > svg')!;
  expect(svg.getAttribute('aria-label')).toBe('Diagrama Mermaid: pie title Gastos');
  expect(svg.firstElementChild?.tagName).toBe('title');
  expect(svg.querySelector(':scope > title')?.textContent).toBe(
    'Diagrama Mermaid: pie title Gastos',
  );
  expect(svg.querySelector(':scope > desc')?.textContent).toBe('a: 4; b: 3; c: 2; d: 1');
  expect(svg.querySelectorAll('title, desc')).toHaveLength(2);
  // Sem mudança no desenho: as mesmas 4 fatias e a legenda com as mesmas cores.
  const { slices, legend } = pieDom(svg);
  expect(slices).toHaveLength(4);
  expect(legend).toEqual(slices);
});

test('CR3-C2: falha na leitura das fatias → pizza exportada sem <title>/<desc>; pizza malformada → código cru', async () => {
  // `mermaidAPI` é congelado: troca-se o objeto inteiro só para a leitura das fatias (o render do
  // Mermaid não passa por esta propriedade).
  const mermaid = await loadMermaid();
  const api = mermaid.mermaidAPI;
  const parse = vi.fn(() => Promise.reject(new Error('pizza malformada')));
  mermaid.mermaidAPI = { ...api, getDiagramFromText: parse };
  try {
    const html = await exportHtml(`# Nota\n\n\`\`\`mermaid\n${PIE}\`\`\`\n`, 'nota.md', () => true);
    expect(parse).toHaveBeenCalledTimes(1);
    const svg = new DOMParser()
      .parseFromString(html, 'text/html')
      .querySelector('figure.smd-mermaid > svg')!;
    expect(svg.getAttribute('aria-label')).toBe('Diagrama Mermaid: pie title Gastos');
    expect(svg.querySelectorAll('title, desc')).toHaveLength(0);
    expect(pieDom(svg).slices).toHaveLength(4);
  } finally {
    mermaid.mermaidAPI = api;
  }
  const broken = 'pie title Gastos\n  "a" : x\n';
  const html = await exportHtml(`\`\`\`mermaid\n${broken}\`\`\`\n`, 'nota.md', () => true);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  expect(doc.querySelector('svg')).toBeNull();
  expect(doc.body.textContent).toContain('"a" : x');
});
