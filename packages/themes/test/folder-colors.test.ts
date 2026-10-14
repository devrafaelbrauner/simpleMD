import { describe, expect, test } from 'vitest';
import {
  FOLDER_COLORS_MAX,
  folderColorField,
  isFolderColorId,
  parseFolderColors,
  resolveFolderColor,
  type FolderColorId,
} from '../src';

const lines = (raw: unknown) =>
  parseFolderColors(raw).warnings.map((w) => `${w.field}: ${w.reason}`);

describe('parseFolderColors (AC-12.7, NFR-12.7; arch-backend r12 §2)', () => {
  test('ausente → mapa vazio, sem aviso', () => {
    expect(parseFolderColors(undefined)).toEqual({ colors: new Map(), warnings: [] });
  });

  test('não é objeto → seção ignorada com 1 aviso', () => {
    for (const raw of [[], 'azul', 3, null]) {
      expect(parseFolderColors(raw).colors.size).toBe(0);
      expect(lines(raw)).toEqual(['folderColors: deve ser um objeto']);
    }
  });

  test('valores: id válido fica; desconhecido, hex e não texto são ignorados com o campo', () => {
    const { colors } = parseFolderColors({
      a: 'blue',
      b: 'roxo',
      c: '#ff0000',
      d: 3,
      e: null,
      f: { id: 'red' },
      g: 'Blue',
    });
    expect([...colors]).toEqual([['a', 'blue']]);
    expect(
      lines({ b: 'roxo', c: '#ff0000', d: 3, e: null, f: { id: 'red' }, g: 'Blue', h: '#f00' }),
    ).toEqual([
      'folderColors["b"]: cor desconhecida “roxo”',
      'folderColors["c"]: use um nome de cor, não hex',
      'folderColors["d"]: deve ser texto',
      'folderColors["e"]: deve ser texto',
      'folderColors["f"]: deve ser texto',
      'folderColors["g"]: cor desconhecida “Blue”',
      'folderColors["h"]: use um nome de cor, não hex',
    ]);
  });

  test('chaves: tira 1 "/" final; raiz, fora do vault, oculta e .simplemd são ignoradas', () => {
    const raw = {
      'a/': 'red',
      '': 'blue',
      '../x': 'blue',
      '/x': 'blue',
      '.simplemd/x': 'blue',
      '.oculta': 'blue',
      'a\\b': 'blue',
      'a//': 'blue',
    };
    expect([...parseFolderColors(raw).colors]).toEqual([['a', 'red']]);
    expect(lines(raw)).toEqual([
      'folderColors[""]: a pasta não existe',
      'folderColors["../x"]: a pasta não existe',
      'folderColors["/x"]: a pasta não existe',
      'folderColors[".simplemd/x"]: a pasta não existe',
      'folderColors[".oculta"]: a pasta não existe',
      'folderColors["a\\b"]: a pasta não existe',
      'folderColors["a//"]: a pasta não existe',
    ]);
  });

  test('chave repetida depois de normalizar: vale a 1ª', () => {
    expect([...parseFolderColors({ a: 'red', 'a/': 'blue' }).colors]).toEqual([['a', 'red']]);
  });

  test('__proto__ e constructor são nomes de pasta comuns, sem poluir o protótipo', () => {
    const raw = JSON.parse('{"__proto__":"teal","constructor":"pink"}') as unknown;
    const { colors } = parseFolderColors(raw);
    expect([...colors]).toEqual([
      ['__proto__', 'teal'],
      ['constructor', 'pink'],
    ]);
    expect(({} as Record<string, unknown>).teal).toBeUndefined();
  });

  test('501 entradas → 500 primeiras (contando inválidas) + 1 aviso de excesso', () => {
    const raw: Record<string, string> = { 'p-bad': 'roxo' };
    for (let i = 0; i < FOLDER_COLORS_MAX; i++) raw[`p${i}`] = 'green';
    const { colors, warnings } = parseFolderColors(raw);
    expect(colors.size).toBe(FOLDER_COLORS_MAX - 1);
    expect(colors.has(`p${FOLDER_COLORS_MAX - 1}`)).toBe(false);
    expect(warnings.map((w) => `${w.field}: ${w.reason}`)).toEqual([
      'folderColors["p-bad"]: cor desconhecida “roxo”',
      'folderColors: mais de 500 entradas; as excedentes foram ignoradas',
    ]);
  });

  test('detalhe do aviso: chave e valor cortados em 64 caracteres com "…", sem controles bidi (N4)', () => {
    const long = 'x'.repeat(200);
    const shown = `${'x'.repeat(63)}…`;
    expect(
      lines({ [`../${long}`]: 'red', a: `r${long}`, 'pa\u202Esta': 'ro\u2066x\u2069o\u202A' }),
    ).toEqual([
      `folderColors["../${'x'.repeat(60)}…"]: a pasta não existe`,
      `folderColors["a"]: cor desconhecida “r${'x'.repeat(62)}…”`,
      'folderColors["pasta"]: cor desconhecida “roxo”',
    ]);
    expect(folderColorField(`d/${long}`)).toBe(`folderColors["d/${shown.slice(2)}"]`);
    expect(folderColorField('curta')).toBe('folderColors["curta"]');
  });

  test('isFolderColorId só aceita os 8 ids', () => {
    expect(['red', 'teal', 'pink'].every(isFolderColorId)).toBe(true);
    expect([undefined, 'Red', '#f00', 'roxo', 1].some(isFolderColorId)).toBe(false);
  });
});

describe('resolveFolderColor (AC-12.4, P2, P3)', () => {
  const map = new Map<string, FolderColorId>([
    ['a', 'blue'],
    ['a/b/c', 'green'],
  ]);

  test('herança da pasta colorida mais próxima; a origem é a pasta que define a cor', () => {
    expect(resolveFolderColor(map, 'a/nota.md')).toEqual({ folder: 'a', id: 'blue' });
    expect(resolveFolderColor(map, 'a/b/nota.md')).toEqual({ folder: 'a', id: 'blue' });
    expect(resolveFolderColor(map, 'a/b/c/nota.md')).toEqual({ folder: 'a/b/c', id: 'green' });
    expect(resolveFolderColor(map, 'a/b/c/d/nota.md')).toEqual({ folder: 'a/b/c', id: 'green' });
  });

  test('nota na raiz e pasta irmã com prefixo igual não colorem', () => {
    expect(resolveFolderColor(map, 'nota.md')).toBeNull();
    expect(resolveFolderColor(map, 'ab/nota.md')).toBeNull();
    expect(resolveFolderColor(new Map(), 'a/nota.md')).toBeNull();
  });
});
