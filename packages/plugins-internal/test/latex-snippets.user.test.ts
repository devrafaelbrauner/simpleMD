import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { PluginAPI } from '@simplemd/plugin-api';
import {
  defaultSnippets,
  hasNestedQuantifier,
  SnippetCatalog,
  validateUserSnippet,
} from '../src/latex-snippets/catalog';
import { activate, describeUserSnippets } from '../src/latex-snippets/index';
import { findSnippets } from '../src/latex-snippets/features/run-snippets';
import { contextAt } from '../src/latex-snippets/context';
import { ignoredNotice, parseUserSnippets } from '../src/latex-snippets/user-snippets';
import { fakeHost, mountLatex, show, type } from './latex';

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
    expect(hasNestedQuantifier('([A-Za-z])(\\d)')).toBe(false);
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
