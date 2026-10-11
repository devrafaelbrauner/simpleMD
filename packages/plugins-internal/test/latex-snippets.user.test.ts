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
import {
  FILE_REGEX_COST_LIMIT,
  REGEX_COST_LIMIT,
  regexCost,
} from '../src/latex-snippets/regex-cost';
import { ignoredNotice, parseUserSnippets } from '../src/latex-snippets/user-snippets';
import { PERF_GATE } from '../../core/test/helpers/perf';
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

  // A recusa é estática: a regex do usuário nunca roda (espião em `RegExp.prototype.exec`, por onde
  // passam também `test`/`match`/`replace`). O tempo de relógio só vale com SIMPLEMD_PERF=1.
  test.each([...REVIEWER, ...NO_NESTING])('%s → regex-budget, sem exec', (trigger) => {
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
    if (PERF_GATE) expect(elapsed).toBeLessThan(25);
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

  test('gatilhos regex do conjunto padrão pela validação do usuário (sempre com u)', () => {
    const regex = (defaultSnippetData as { trigger: string; options: string }[]).filter((raw) =>
      raw.options.includes('r'),
    );
    expect(regex).toHaveLength(35);
    const rejected = regex.filter((raw) => !('snippet' in validateUserSnippet(raw)));
    // Com `u`, `{` solto é erro de sintaxe: o usuário escreve `\{`/`\}` (documentado).
    expect(rejected.map((raw) => raw.trigger)).toEqual([
      '\\\\hat{([A-Za-z])}(\\d)',
      '\\\\vec{([A-Za-z])}(\\d)',
      '\\\\mathbf{([A-Za-z])}(\\d)',
    ]);
    for (const raw of rejected) {
      expect(validateUserSnippet(raw)).toEqual({ reason: 'regex-invalid' });
      const escaped = { ...raw, trigger: raw.trigger.replace('{', '\\{').replace('}', '\\}') };
      expect('snippet' in validateUserSnippet(escaped)).toBe(true);
    }
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
    // O que mantém a tecla rápida é estrutural (só a forma de custo aceito entrou, acima); o
    // tempo de relógio só vale com SIMPLEMD_PERF=1.
    let worst = 0;
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      expect(findSnippets(view.state, ctx, 'y', settings)).toBeNull();
      worst = Math.max(worst, performance.now() - started);
    }
    if (PERF_GATE) expect(worst).toBeLessThan(100);
  });

  test('orçamento total do arquivo (3,5 × 10⁶): só 3 \\w*\\w*b. cabem (CR-S6-11)', () => {
    const trigger = '\\w*\\w*b.';
    expect(FILE_REGEX_COST_LIMIT).toBe(3_500_000);
    expect(Math.floor(FILE_REGEX_COST_LIMIT / regexCost(trigger, 'u'))).toBe(3);
    const user = parseUserSnippets(JSON.stringify(Array.from({ length: 5 }, () => entry(trigger))));
    expect(user.snippets).toHaveLength(3);
    expect(user.reasons).toEqual(['regex-budget', 'regex-budget']);
  });

  test('o custo estático entende classes, escapes, grupos nomeados e lookaround', () => {
    expect(regexCost('[a-z\\]]\\u{1F600}\\p{L}(?<n>a)\\k<n>(?=b)(?<!c)', 'u')).toBe(101);
    expect(regexCost('a{2,4}?b{3}', 'u')).toBe(3 * 101);
    expect(regexCost('(?:ab){2,}', 'u')).toBe(100 * 101);
    expect(regexCost('(a{2})+', 'u')).toBe(101 * 101);
    expect(regexCost('(a{2,3})+', 'u')).toBe(Infinity);
    expect(regexCost('a{0}(b|c)?', 'u')).toBe(Infinity);
    expect(regexCost('[abc', 'u')).toBe(Infinity);
    expect(regexCost('(a', 'u')).toBe(Infinity);
    expect(regexCost('a)', 'u')).toBe(Infinity);
    expect(regexCost('\\', 'u')).toBe(Infinity);
  });
});

describe('CR-S6-10 escapes do Anexo B: a regex do usuário sempre compila com u', () => {
  /** Padrões do revisor (`/tmp/s6probe/probe3.ts`, `e2e2.ts`): sem `u` congelavam a tecla. */
  const ANNEX_B = [
    '(?:\\u{1,})+',
    '(\\p{1,})+',
    '(?:\\P{0,})+',
    `${'\\u{1,}'.repeat(8)}b.`,
    '(?:\\k<|(?:a|aa)+|>)+',
    '(?:\\k<|(?:\\w|\\w\\w)+|>)+',
  ];
  const entry = (trigger: string, flags?: string) => ({
    trigger,
    replacement: 'R',
    options: 'rmA',
    ...(flags === undefined ? {} : { flags }),
  });

  // Recusa sem executar a regex (espião em `exec`); o tempo de relógio só vale com SIMPLEMD_PERF=1
  // (no CI do Windows chegou a 6,39 ms contra o antigo teto de 5 ms).
  test.each(ANNEX_B)('%s → regex-invalid, sem exec', (trigger) => {
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
    expect(result).toEqual({ reason: 'regex-invalid' });
    if (PERF_GATE) expect(elapsed).toBeLessThan(25);
    const userRegexRuns = exec.mock.contexts.filter(
      (re) => re instanceof RegExp && re.source === `${trigger}$`,
    );
    expect(userRegexRuns).toHaveLength(0);
  });

  test.each(ANNEX_B)('%s sem u: o custo estático segue o Anexo B e passa do limite', (trigger) => {
    expect(regexCost(trigger, '')).toBeGreaterThan(REGEX_COST_LIMIT);
  });

  test('com u, \\u{1F600}, \\p{L} e \\k<nome> continuam aceitos; a regex compilada leva u', () => {
    for (const trigger of ['\\u{1F600}x', '(\\p{L})x', '(?<n>a)\\k<n>x']) {
      const result = validateUserSnippet(entry(trigger, 'i'));
      if (!('snippet' in result)) throw new Error(`${trigger}: ${result.reason}`);
      expect((result.snippet.trigger as RegExp).flags).toBe('iu');
      expect(result.cost).toBe(101);
    }
  });
});

describe('NFR-56 casamento com 500 snippets do usuário', () => {
  // O orçamento (p95 ≤ 2 ms) é de tempo de relógio: só vale com SIMPLEMD_PERF=1. Sempre, o que o
  // sustenta: os 500 entram e cada tecla só testa os snippets cujo gatilho termina nela (índice
  // pelo último caractere do catálogo), nunca os 500.
  test('p95 do casamento por tecla ≤ 2 ms (janela de 100 caracteres)', () => {
    const entries = Array.from({ length: 500 }, (_, i) =>
      i % 2 === 0
        ? { trigger: `u${i}([a-z])x`, replacement: `\\op${i}{[[0]]}`, options: 'rmA' }
        : { trigger: `w${i}q`, replacement: `\\w${i}`, options: 'mA' },
    );
    const user = parseUserSnippets(JSON.stringify(entries));
    expect(user.ignored).toBe(0);
    const catalog = new SnippetCatalog([...defaultSnippets(), ...user.snippets]);
    const mine = new Set(user.snippets);
    const ownCandidates = (key: string) => catalog.candidates(key).filter((s) => mine.has(s));
    for (const key of 'abcyz+-') expect(ownCandidates(key), key).toHaveLength(0);
    expect(ownCandidates('x')).toHaveLength(250);
    expect(ownCandidates('q')).toHaveLength(250);
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
    if (PERF_GATE) expect(times[Math.floor(times.length * 0.95)]).toBeLessThanOrEqual(2);
  });
});
