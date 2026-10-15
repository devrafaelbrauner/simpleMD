import { describe, expect, test } from 'vitest';
import {
  DEFAULT_EXPLORER_APPEARANCE,
  FOLDER_COLOR_IDS,
  effectiveExplorer,
  explorerRowColor,
  normalizeExplorerPatch,
  parseExplorerAppearance,
  rainbowColors,
  type FolderColorId,
} from '../src';

/**
 * r13 S1 — `appearance.explorer` (arch-backend r13 §1–§5; D-R13-B1..B4): validação campo a campo,
 * arco-íris por posição nas pastas do topo e cor da linha de pasta com herança.
 */
const dir = (path: string) => ({
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  kind: 'dir' as const,
});
const file = (path: string) => ({
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  kind: 'file' as const,
});
const parse = (json: string) =>
  parseExplorerAppearance(JSON.parse(json) as Record<string, unknown>);

describe('parseExplorerAppearance (AC-13.7, D-R13-B4)', () => {
  test('sem config, sem appearance, sem explorer ou sem campos: padrão (= r12), sem aviso', () => {
    expect(DEFAULT_EXPLORER_APPEARANCE).toEqual({
      style: 'dot',
      auto: 'off',
      intensity: 'medium',
      scope: 'own',
    });
    expect(Object.isFrozen(DEFAULT_EXPLORER_APPEARANCE)).toBe(true);
    for (const config of [null, {}, { appearance: {} }, { appearance: { explorer: {} } }]) {
      expect(parseExplorerAppearance(config)).toEqual({
        appearance: DEFAULT_EXPLORER_APPEARANCE,
        warnings: [],
      });
    }
  });

  test('os 4 campos válidos são lidos', () => {
    const json =
      '{"appearance":{"explorer":{"style":"card","auto":"rainbow","intensity":"strong","scope":"inherit"}}}';
    expect(parse(json)).toEqual({
      appearance: { style: 'card', auto: 'rainbow', intensity: 'strong', scope: 'inherit' },
      warnings: [],
    });
  });

  test('appearance ou explorer que não são objeto: padrão + 1 aviso que nomeia o campo', () => {
    expect(parse('{"appearance":3}')).toEqual({
      appearance: DEFAULT_EXPLORER_APPEARANCE,
      warnings: [{ field: 'appearance', reason: 'deve ser um objeto' }],
    });
    expect(parse('{"appearance":{"explorer":[]}}')).toEqual({
      appearance: DEFAULT_EXPLORER_APPEARANCE,
      warnings: [{ field: 'appearance.explorer', reason: 'deve ser um objeto' }],
    });
  });

  test.each([
    ['style', 'use dot, stripe, card ou gradient'],
    ['auto', 'use off ou rainbow'],
    ['intensity', 'use subtle, medium ou strong'],
    ['scope', 'use own ou inherit'],
  ] as const)(
    '%s inválido (número, null, maiúscula, desconhecido): só ele vira padrão',
    (field, reason) => {
      const valid = {
        style: 'gradient',
        auto: 'rainbow',
        intensity: 'subtle',
        scope: 'inherit',
      } as const;
      for (const bad of [3, null, 'Card', 'x', true, {}]) {
        const explorer = { ...valid, [field]: bad };
        const { appearance, warnings } = parseExplorerAppearance({ appearance: { explorer } });
        expect(appearance).toEqual({ ...valid, [field]: DEFAULT_EXPLORER_APPEARANCE[field] });
        // D-R13-B4: o motivo lista os aceitos e nunca ecoa o valor do arquivo.
        expect(warnings).toEqual([{ field: `appearance.explorer.${field}`, reason }]);
      }
    },
  );

  test('vários inválidos: 1 aviso por campo, na ordem style, auto, intensity, scope', () => {
    const { warnings } = parse(
      '{"appearance":{"explorer":{"scope":1,"style":"Card","intensity":3,"auto":"on"}}}',
    );
    expect(warnings.map((w) => w.field)).toEqual([
      'appearance.explorer.style',
      'appearance.explorer.auto',
      'appearance.explorer.intensity',
      'appearance.explorer.scope',
    ]);
  });

  test('chaves extras são ignoradas sem aviso; __proto__ não vira campo', () => {
    expect(parse('{"appearance":{"x":1,"explorer":{"style":"stripe","future":"y"}}}')).toEqual({
      appearance: { ...DEFAULT_EXPLORER_APPEARANCE, style: 'stripe' },
      warnings: [],
    });
    expect(parse('{"appearance":{"explorer":{"__proto__":{"style":"card"}}}}')).toEqual({
      appearance: DEFAULT_EXPLORER_APPEARANCE,
      warnings: [],
    });
    expect(parse('{"__proto__":{"appearance":{"explorer":{"style":"card"}}}}').appearance).toBe(
      DEFAULT_EXPLORER_APPEARANCE,
    );
  });
});

describe('normalizeExplorerPatch e effectiveExplorer (D-R13-B3)', () => {
  test('campo inválido mantém o atual; válido troca; o resultado tem só os 4 campos', () => {
    const current = { ...DEFAULT_EXPLORER_APPEARANCE, style: 'card' } as const;
    const patch = { intensity: 'strong', scope: 'nope', extra: 1 } as unknown as Parameters<
      typeof normalizeExplorerPatch
    >[0];
    expect(normalizeExplorerPatch(patch, current)).toEqual({
      style: 'card',
      auto: 'off',
      intensity: 'strong',
      scope: 'own',
    });
  });

  test('em Bolinha o escopo efetivo é own sem mudar o guardado; fora dela é o próprio', () => {
    const stored = {
      style: 'dot',
      auto: 'rainbow',
      intensity: 'strong',
      scope: 'inherit',
    } as const;
    expect(effectiveExplorer(stored)).toEqual({ ...stored, scope: 'own' });
    expect(stored.scope).toBe('inherit');
    const card = { ...stored, style: 'card' } as const;
    expect(effectiveExplorer(card)).toBe(card);
  });
});

describe('rainbowColors (R-13.3, AC-13.4, AC-13.5, D-R13-P1)', () => {
  const TOP = ['p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'p08', 'p09', 'p10'];

  test('10 pastas no topo: 1ª–8ª nas 8 cores, 9ª red, 10ª orange', () => {
    const map = rainbowColors(TOP.map(dir), new Map());
    expect([...map]).toEqual([
      ...FOLDER_COLOR_IDS.map((id, i) => [TOP[i], id]),
      ['p09', 'red'],
      ['p10', 'orange'],
    ]);
  });

  test('cor própria mantém a sua e ocupa a posição; o resultado só tem as automáticas', () => {
    const own = new Map<string, FolderColorId>([['p02', 'green']]);
    const map = rainbowColors(TOP.map(dir), own);
    expect(map.has('p02')).toBe(false);
    expect(map.get('p01')).toBe('red');
    expect(map.get('p03')).toBe('amber');
    expect(map.size).toBe(9);
  });

  test('só pastas filhas diretas da raiz contam: notas, subpastas e ocultas ficam fora', () => {
    const entries = [
      dir('a'),
      dir('a/sub'),
      file('a/nota.md'),
      dir('.oculta'),
      dir('b'),
      file('raiz.md'),
      dir('c'),
    ];
    expect([...rainbowColors(entries, new Map())]).toEqual([
      ['a', 'red'],
      ['b', 'orange'],
      ['c', 'amber'],
    ]);
  });

  test('pasta nova no meio desloca as seguintes (sem estado guardado)', () => {
    const before = rainbowColors([dir('a'), dir('c')], new Map());
    const after = rainbowColors([dir('a'), dir('b'), dir('c')], new Map());
    expect(before.get('c')).toBe('orange');
    expect(after.get('c')).toBe('amber');
    expect(after.get('b')).toBe('orange');
  });
});

describe('explorerRowColor (R-13.5, AC-13.6, D-R13-B3)', () => {
  const own = new Map<string, FolderColorId>([
    ['a', 'blue'],
    ['a/b/c', 'green'],
  ]);
  const auto = new Map<string, FolderColorId>([['m', 'violet']]);

  test('própria e automática valem em qualquer escopo; herdeira só em inherit', () => {
    expect(explorerRowColor(own, auto, 'a', 'own')).toEqual({ id: 'blue', source: 'own' });
    expect(explorerRowColor(own, auto, 'm', 'own')).toEqual({ id: 'violet', source: 'auto' });
    expect(explorerRowColor(own, auto, 'a/b', 'own')).toBeNull();
    expect(explorerRowColor(own, auto, 'a/b', 'inherit')).toEqual({
      id: 'blue',
      source: 'inherited',
    });
  });

  test('o ancestral mais próximo vence; cor própria numa subpasta corta a herança abaixo', () => {
    expect(explorerRowColor(own, auto, 'a/b/c', 'inherit')).toEqual({ id: 'green', source: 'own' });
    expect(explorerRowColor(own, auto, 'a/b/c/d/e', 'inherit')).toEqual({
      id: 'green',
      source: 'inherited',
    });
    expect(explorerRowColor(own, auto, 'm/x/y', 'inherit')).toEqual({
      id: 'violet',
      source: 'inherited',
    });
  });

  test('sem ancestral colorido: null (a raiz nunca colore)', () => {
    expect(explorerRowColor(own, auto, 'z', 'inherit')).toBeNull();
    expect(explorerRowColor(own, auto, 'z/y', 'inherit')).toBeNull();
    expect(explorerRowColor(new Map(), new Map(), 'a/b', 'inherit')).toBeNull();
  });
});
