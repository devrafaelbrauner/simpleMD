import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EditorState } from '@codemirror/state';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { PluginAPI } from '@simplemd/plugin-api';
import {
  defaultSnippets,
  SnippetCatalog,
  validateUserSnippet,
  type UserSnippetResult,
} from '../src/latex-snippets/catalog';
import { getLatexSuiteConfig } from '../src/latex-snippets/cm/config';
import defaultSnippetData from '../src/latex-snippets/data/default-snippets.json';
import { RegexSnippet } from '../src/latex-snippets/engine/snippets';
import { Options } from '../src/latex-snippets/engine/options';
import { activate, describeUserSnippets } from '../src/latex-snippets/index';
import { findSnippets } from '../src/latex-snippets/features/run-snippets';
import { contextAt } from '../src/latex-snippets/context';
import { FILE_REGEX_COST_LIMIT, regexCost } from '../src/latex-snippets/regex-cost';
import { ignoredNotice, parseUserSnippets } from '../src/latex-snippets/user-snippets';
import { destroyLatexViews, fakeHost, mountLatex, show, type } from './latex';

afterEach(destroyLatexViews);

/** AC-I6.5 (snippets do usuário, só dados) e NFR-56 (casamento ≤ 2 ms por tecla com 500). */
const VALID = [
  { trigger: 'qq', replacement: '\\quad ', options: 'mA' },
  { trigger: 'vv(\\w)', replacement: '\\vec{[[0]]}', options: 'rmA', description: 'vetor' },
  { trigger: 'fn', replacement: '(m) => m[1].toUpperCase()', options: 'mA' },
];
const INVALID = [
  { trigger: 'x', replacement: 'y', options: 'mAc' }, // `c` desativado (Q-R7-F09)
  { trigger: 'y', replacement: (m: string) => m, options: 'mA' }, // função: não é texto
  { trigger: `${'a'.repeat(201)}`, replacement: 'z', options: 'rmA' }, // regex > 200
];

describe('AC-I6.5 .simplemd/latex-snippets.json', () => {
  test('válidas valem; 3 inválidas são puladas com o aviso "3 snippets ignorados"', () => {
    const parsed = parseUserSnippets(JSON.stringify([...VALID, ...INVALID]));
    expect(parsed.snippets).toHaveLength(3);
    expect(parsed.ignored).toBe(3);
    expect(parsed.reasons).toEqual(['options', 'shape', 'regex-length']);
    expect(ignoredNotice(parsed.ignored)).toBe(
      '3 snippets ignorados em .simplemd/latex-snippets.json.',
    );
    expect(ignoredNotice(1)).toBe('1 snippet ignorado em .simplemd/latex-snippets.json.');
  });

  test('o snippet do usuário expande no editor; texto com cara de função vira texto literal', () => {
    const user = parseUserSnippets(JSON.stringify(VALID)).snippets;
    const catalog = new SnippetCatalog([...defaultSnippets(), ...user]);
    const { view } = mountLatex('$|$', { catalog });
    type(view, 'fn');
    expect(show(view)).toBe('$(m) => m[1].toUpperCase()|$');
    const vec = mountLatex('$|$', { catalog });
    type(vec.view, 'vvu');
    expect(show(vec.view)).toBe('$\\vec{u}|$');
  });

  test('regex com mais de 200 caracteres, inválida ou fora do orçamento é recusada', () => {
    expect(
      validateUserSnippet({ trigger: 'b'.repeat(201), replacement: '', options: 'r' }),
    ).toEqual({
      reason: 'regex-length',
    });
    expect(validateUserSnippet({ trigger: '(unclosed', replacement: '', options: 'r' })).toEqual({
      reason: 'regex-invalid',
    });
    expect(validateUserSnippet({ trigger: '(a+)+b', replacement: '', options: 'r' })).toEqual({
      reason: 'regex-budget',
    });
    expect(validateUserSnippet({ trigger: '(a|ab)*c', replacement: '', options: 'r' })).toEqual({
      reason: 'regex-budget',
    });
  });

  test('flag m recusada; o casamento da regex tem de terminar no cursor (CR-S6-07)', () => {
    expect(
      validateUserSnippet({ trigger: 'ab', replacement: '', options: 'r', flags: 'm' }),
    ).toEqual({ reason: 'flags' });
    // Mesmo uma RegExp com `m` (nunca vinda do arquivo) não apaga além do gatilho.
    const snippet = new RegexSnippet({
      trigger: /ab$/m,
      replacement: 'X',
      options: Options.fromSource('r'),
    });
    expect(snippet.process({ text: 'ab\ncd', offset: 0 }, 0, '')).toBeNull();
    expect(snippet.process({ text: 'cd ab', offset: 10 }, 0, '')).toEqual({
      triggerPos: 13,
      replacement: 'X',
    });
  });

  test('arquivo inteiro inválido, ausente ou grande demais: aviso próprio e info das opções', () => {
    expect(parseUserSnippets('{').problem).toBe('json');
    expect(parseUserSnippets('{}').problem).toBe('not-array');
    expect(describeUserSnippets({ error: 'missing' })).toBe(
      'Nenhum arquivo .simplemd/latex-snippets.json',
    );
    expect(describeUserSnippets(null)).toBe('Nenhum arquivo .simplemd/latex-snippets.json');
    expect(describeUserSnippets({ error: 'too-large' })).toBe(
      '.simplemd/latex-snippets.json passa de 256 KB e foi ignorado.',
    );
    expect(describeUserSnippets({ text: JSON.stringify([...VALID, ...INVALID]) })).toBe(
      '3 snippets de .simplemd/latex-snippets.json · 3 ignorados',
    );
  });

  test('o plugin lê o arquivo pelo host e avisa quantas entradas pulou', async () => {
    const notify = vi.fn();
    const extensions: unknown[] = [];
    const api = {
      registerEditorExtension: (ext: { source?: unknown }) => extensions.push(ext.source),
      ui: { notify },
    } as unknown as PluginAPI;
    let changed: ((name: string) => void) | undefined;
    const read = vi.fn(async () => ({ text: JSON.stringify([...VALID, ...INVALID]) }));
    const host = {
      ...fakeHost([]),
      files: {
        read,
        onChange: (listener: (name: string) => void) => {
          changed = listener;
          return () => {};
        },
      },
    };
    const dispose = activate(api, host);
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        '3 snippets ignorados em .simplemd/latex-snippets.json.',
        'warn',
      ),
    );
    expect(read).toHaveBeenCalledWith('.simplemd/latex-snippets.json');
    expect(extensions).toHaveLength(1);
    changed?.('.simplemd/latex-snippets.json');
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    dispose();
  });

  test('releituras rápidas: só a leitura mais recente vale (CR-S6-08)', async () => {
    const old = Promise.withResolvers<{ text: string }>();
    const reads = [
      old.promise,
      Promise.resolve({
        text: JSON.stringify([{ trigger: 'novo', replacement: 'N', options: 'mA' }]),
      }),
    ];
    let calls = 0;
    const read = vi.fn(() => reads[calls++] ?? Promise.resolve({ text: '[]' }));
    let changed: ((name: string) => void) | undefined;
    const extensions: unknown[] = [];
    const api = {
      registerEditorExtension: (ext: { source?: unknown }) => extensions.push(ext.source),
      ui: { notify: vi.fn() },
    } as unknown as PluginAPI;
    const dispose = activate(api, {
      ...fakeHost([]),
      files: {
        read,
        onChange: (listener: (name: string) => void) => {
          changed = listener;
          return () => {};
        },
      },
    });
    changed?.('.simplemd/latex-snippets.json');
    const state = EditorState.create({ extensions: extensions as never });
    const triggers = () =>
      getLatexSuiteConfig(state)
        ?.catalog()
        .all.map((snippet) => String(snippet.trigger)) ?? [];
    await vi.waitFor(() => expect(triggers()).toContain('novo'));
    // A primeira leitura (mais antiga) termina depois: não volta ao catálogo velho. Esperar a
    // mesma promessa roda depois da continuação do `load` (fila de microtarefas).
    old.resolve({ text: JSON.stringify([{ trigger: 'velho', replacement: 'V', options: 'mA' }]) });
    await old.promise;
    expect(triggers()).toContain('novo');
    expect(triggers()).not.toContain('velho');
    dispose();
  });

  test('0 eval/Function no código do plugin (nenhuma substituição é executada)', () => {
    const root = join(__dirname, '../src/latex-snippets');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.ts')) files.push(path);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const code = readFileSync(file, 'utf8');
      expect({ file, hits: code.match(/\beval\s*\(|new\s+Function\b|\bFunction\s*\(/g) }).toEqual({
        file,
        hits: null,
      });
    }
  });
});

describe('CR-S6-01/02/05 regex do usuário: recusa estática, sem executar a regex', () => {
  /** Padrões do revisor (`/tmp/s6probe`) e as formas clássicas. */
  const REVIEWER = [
    '(?:qwertyui)?(xx?)+',
    '(xx?)+',
    '(a+)+',
    '(a|a)*',
    '(x?x)*z',
    '(?:qwertyui)?(x?x)*z',
  ];
  /** Exponenciais ou polinomiais altas sem grupo repetido. */
  const NO_NESTING = ['a?'.repeat(30) + 'a'.repeat(30), '(a|a)'.repeat(20), '\\w*\\w*\\w*x'];
  const entry = (trigger: string) => ({ trigger, replacement: 'R', options: 'rmA' });

  test.each([...REVIEWER, ...NO_NESTING])('%s → regex-budget em < 5 ms, sem exec', (trigger) => {
    const exec = vi.spyOn(RegExp.prototype, 'exec');
    let result: UserSnippetResult;
    let elapsed: number;
    try {
      const started = performance.now();
      result = validateUserSnippet(entry(trigger));
      elapsed = performance.now() - started;
    } finally {
      exec.mockRestore();
    }
    expect(result).toEqual({ reason: 'regex-budget' });
    expect(elapsed).toBeLessThan(5);
    const userRegexRuns = exec.mock.contexts.filter(
      (re) => re instanceof RegExp && re.source === `${trigger}$`,
    );
    expect(userRegexRuns).toHaveLength(0);
  });

  test('a checagem vale DEPOIS das variáveis: grupo repetido e teto de 1024 caracteres', () => {
    expect(validateUserSnippet(entry('(${GREEK})+'))).toEqual({ reason: 'regex-budget' });
    expect(validateUserSnippet(entry('(?:\\\\${SYMBOL})*'))).toEqual({ reason: 'regex-budget' });
    expect(validateUserSnippet(entry('${GREEK}'.repeat(6)))).toEqual({ reason: 'regex-length' });
    expect('snippet' in validateUserSnippet(entry('\\\\(${GREEK}),\\.'))).toBe(true);
  });

  test('os 35 gatilhos regex do conjunto padrão passam pela mesma validação', () => {
    const regex = (defaultSnippetData as { trigger: string; options: string }[]).filter((raw) =>
      raw.options.includes('r'),
    );
    expect(regex).toHaveLength(35);
    const rejected = regex.filter((raw) => !('snippet' in validateUserSnippet(raw)));
    expect(rejected).toEqual([]);
  });

  test('arquivo com os padrões do revisor: a tecla depois de $ + 99 x continua rápida', () => {
    // `\w*\w*[xz]` é a forma mais cara aceita (custo ≈ 1,05 × 10⁶, sem último caractere fixo:
    // candidata em toda tecla); o texto de x seguido de `y` é o pior caso dela.
    const user = parseUserSnippets(JSON.stringify([...REVIEWER, '\\w*\\w*[xz]'].map(entry)));
    expect(user.reasons).toEqual(REVIEWER.map(() => 'regex-budget'));
    expect(user.snippets).toHaveLength(1);
    const catalog = new SnippetCatalog([...defaultSnippets(), ...user.snippets]);
    const { view, settings } = mountLatex(`$${'x'.repeat(99)}|`, { catalog });
    const ctx = contextAt(view.state);
    if (!ctx) throw new Error('sem contexto');
    let worst = 0;
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      expect(findSnippets(view.state, ctx, 'y', settings)).toBeNull();
      worst = Math.max(worst, performance.now() - started);
    }
    expect(worst).toBeLessThan(20);
  });

  test('orçamento total do arquivo: a regex que passa da soma é ignorada (regex-budget)', () => {
    const trigger = '\\w*\\w*[xz]';
    const fits = Math.floor(FILE_REGEX_COST_LIMIT / regexCost(trigger));
    expect(fits).toBeGreaterThan(1);
    const user = parseUserSnippets(
      JSON.stringify(Array.from({ length: fits + 2 }, () => entry(trigger))),
    );
    expect(user.snippets).toHaveLength(fits);
    expect(user.reasons).toEqual(['regex-budget', 'regex-budget']);
  });

  test('o custo estático entende classes, escapes, grupos nomeados e lookaround', () => {
    expect(regexCost('[a-z\\]]\\u{1F600}\\p{L}(?<n>a)\\k<n>(?=b)(?<!c)')).toBe(101);
    expect(regexCost('a{2,4}?b{3}')).toBe(3 * 101);
    expect(regexCost('(?:ab){2,}')).toBe(100 * 101);
    expect(regexCost('(a{2})+')).toBe(101 * 101);
    expect(regexCost('(a{2,3})+')).toBe(Infinity);
    expect(regexCost('a{0}(b|c)?')).toBe(Infinity);
    expect(regexCost('[abc')).toBe(Infinity);
    expect(regexCost('(a')).toBe(Infinity);
    expect(regexCost('a)')).toBe(Infinity);
    expect(regexCost('\\')).toBe(Infinity);
  });
});

describe('NFR-56 casamento com 500 snippets do usuário', () => {
  test('p95 do casamento por tecla ≤ 2 ms (janela de 100 caracteres)', () => {
    const entries = Array.from({ length: 500 }, (_, i) =>
      i % 2 === 0
        ? { trigger: `u${i}([a-z])x`, replacement: `\\op${i}{[[0]]}`, options: 'rmA' }
        : { trigger: `w${i}q`, replacement: `\\w${i}`, options: 'mA' },
    );
    const user = parseUserSnippets(JSON.stringify(entries));
    expect(user.ignored).toBe(0);
    const catalog = new SnippetCatalog([...defaultSnippets(), ...user.snippets]);
    const { view, settings } = mountLatex(`$${'a + b '.repeat(20)}|$`, { catalog });
    const ctx = contextAt(view.state);
    if (!ctx) throw new Error('sem contexto');
    const times: number[] = [];
    for (let i = 0; i < 200; i++) {
      const key = 'abcxyz+-q'.charAt(i % 9);
      const started = performance.now();
      findSnippets(view.state, ctx, key, settings);
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]).toBeLessThanOrEqual(2);
  });
});
