import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diagnosticCount, forEachDiagnostic, type Diagnostic } from '@codemirror/lint';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderCalc, calcTokenSpans } from '../src/calc/render';
import {
  invalidConfigNotice,
  loadLintConfig,
  parseLintConfig,
  rulesInUseText,
  stripJsonc,
} from '../src/lint/config';
import { createLintEngine, READY_TIMEOUT_MS } from '../src/lint/engine';
import { isExcluded } from '../src/lint/exclusions';
import { createLintPlugin, LINT_DELAY_MS, SLOW_LINT_NOTICE } from '../src/lint/index';
import { lintCounters, rulesInUse } from '../src/lint/render';
import { DEFAULT_LINT_CONFIG, RULE_DESCRIPTIONS, ruleDocUrl } from '../src/lint/rules';
import { toDiagnostics } from '../src/lint/source';
import { lintMarkdown, type LintFinding, type LintReply } from '../src/lint/worker';
import { problemInfo } from '../src/shared/diagnostics-ui';
import { destroyViews, mountView, pluginState } from './helpers';
import { fakeApi, fakeLintHost } from './lint-helpers';

const FIXTURE = readFileSync(
  join(__dirname, '../../../apps/desktop/harness/fixtures/r7/vault/lint.md'),
  'utf8',
);

/** (regra, linha) de cada diagnóstico, ordenados. */
function pairs(state: Parameters<typeof toDiagnostics>[0], diagnostics: readonly Diagnostic[]) {
  return diagnostics
    .map((d) => `${problemInfo(d)?.title.split(' · ')[0]}@${state.doc.lineAt(d.from).number}`)
    .sort();
}

function lintState(text: string, config = DEFAULT_LINT_CONFIG) {
  const state = pluginState(text, []);
  return { state, diagnostics: toDiagnostics(state, lintMarkdown(text, config), () => {}) };
}

/** Diagnósticos publicados no estado do view (o que o usuário vê). */
function shown(view: EditorView): string[] {
  const out: string[] = [];
  forEachDiagnostic(view.state, (d, from) => {
    out.push(`${problemInfo(d)?.title.split(' · ')[0]}@${view.state.doc.lineAt(from).number}`);
  });
  return out.sort();
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

afterEach(() => {
  destroyViews();
  vi.useRealTimers();
});

describe('AC-I5.1 fixture e padrões (R-I5.1, R-I5.2)', () => {
  it('o conjunto (regra, linha) do FX-R7/lint.md é exatamente o esperado', () => {
    const { state, diagnostics } = lintState(FIXTURE);
    expect(pairs(state, diagnostics)).toEqual(
      ['MD009@3', 'MD009@24', 'MD010@4', 'MD012@6', 'MD022@8', 'MD026@11'].sort(),
    );
  });

  it('MD013, MD033 e MD041 desligadas no padrão; ligadas quando o padrão não as desliga', () => {
    const text = '<b>x</b> sem título\n\n' + 'palavra '.repeat(20) + '\n';
    const off = lintMarkdown(text, DEFAULT_LINT_CONFIG).map((f) => f.rule);
    for (const rule of ['MD013', 'MD033', 'MD041']) expect(off).not.toContain(rule);
    const on = lintMarkdown(text, { default: true }).map((f) => f.rule);
    for (const rule of ['MD013', 'MD033', 'MD041']) expect(on).toContain(rule);
  });

  it('nada dentro de $…$, $$…$$, mermaid e =calc (achados sintéticos dentro e fora)', () => {
    const text = [
      'Texto $a  b$ fim', // 1: inline math em [6, 12]
      '',
      '$$',
      'x   ', // 4
      '$$',
      '',
      '```mermaid',
      'A-->B   ', // 8
      '```',
      '',
      'Calc =2+3 depois   ', // 11
    ].join('\n');
    const state = pluginState(text, []);
    const finding = (line: number, column: number, length: number): LintFinding => ({
      rule: 'MD009',
      alias: 'no-trailing-spaces',
      line,
      range: [column, length],
    });
    const inside = [finding(1, 8, 2), finding(4, 2, 3), finding(8, 6, 3), finding(11, 6, 4)];
    expect(toDiagnostics(state, inside, () => {})).toEqual([]);
    // O mesmo tipo de achado fora dos trechos excluídos aparece.
    const outside = [finding(1, 13, 4), finding(11, 17, 3)];
    expect(
      pairs(
        state,
        toDiagnostics(state, outside, () => {}),
      ),
    ).toEqual(['MD009@1', 'MD009@11']);
    // Linha inteira (`range: null`) que só ENCOSTA num trecho excluído não é descartada.
    expect(isExcluded(state, state.doc.line(1).from, state.doc.line(1).to)).toBe(false);
  });

  it('a varredura de calc do lint concorda com a do plugin calc (paridade, D-R7-S5-03)', () => {
    const samples = [
      '=2+3',
      '=1/0',
      '=(1+2)*3',
      '=5',
      '=abc',
      '=2+',
      '=-3',
      '=2^3%2',
      'a=2+3',
      '=2+*3',
    ];
    for (const sample of samples) {
      const line = `x ${sample} y`;
      const state = pluginState(line, []);
      const tokens = calcTokenSpans(line).filter((t) => renderCalc(line.slice(t.from, t.to)));
      const excluded = tokens.every((t) => isExcluded(state, t.from, t.to));
      expect(excluded, sample).toBe(true);
      const start = line.indexOf(sample);
      expect(isExcluded(state, start, start + sample.length), sample).toBe(tokens.length > 0);
    }
  });

  it('o front matter é ignorado pela opção do markdownlint', () => {
    const text = '---\ntitle: x   \ntags: [a]\n---\n\n# Nota\n';
    expect(lintMarkdown(text, DEFAULT_LINT_CONFIG).filter((f) => f.line <= 4)).toEqual([]);
  });

  it('achados repetidos do markdownlint (MD022 acima/abaixo) viram um diagnóstico', () => {
    const { diagnostics } = lintState('# A\n## B\ntexto\n');
    const md022 = diagnostics.filter((d) => problemInfo(d)?.title.startsWith('MD022'));
    expect(new Set(md022.map((d) => `${d.from}:${d.to}`)).size).toBe(md022.length);
  });
});

describe('STR-164: descrições pt-BR de todas as regras do markdownlint 0.41.1', () => {
  it('cada regra do schema do markdownlint tem descrição pt-BR e URL da versão fixada', () => {
    const schema = JSON.parse(
      readFileSync(
        join(__dirname, '../node_modules/markdownlint/schema/markdownlint-config-schema.json'),
        'utf8',
      ),
    ) as { properties: Record<string, unknown> };
    const rules = Object.keys(schema.properties).filter((key) => /^MD\d{3}$/.test(key));
    expect(rules.length).toBe(53);
    expect(Object.keys(RULE_DESCRIPTIONS).sort()).toEqual(rules.sort());
    expect(ruleDocUrl('MD009')).toBe(
      'https://github.com/DavidAnson/markdownlint/blob/v0.41.1/doc/md009.md',
    );
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../node_modules/markdownlint/package.json'), 'utf8'),
    ) as { version: string };
    expect(pkg.version).toBe('0.41.1');
  });

  it('a dica nunca mostra o texto em inglês do upstream', () => {
    const { diagnostics } = lintState('texto   \n');
    const info = problemInfo(diagnostics[0] as Diagnostic);
    expect(info?.body).toBe('Espaços no fim da linha.');
    expect(info?.title).toBe('MD009 · no-trailing-spaces');
    expect(JSON.stringify(info)).not.toMatch(/Trailing spaces|Expected/);
  });
});

describe('AC-I5.2 configuração da pasta (R-I5.2)', () => {
  it('.markdownlint.json com "MD013": true → MD013 aparece (o arquivo substitui o padrão)', async () => {
    const files = fakeLintHost({ '.markdownlint.json': '{ "MD013": true }' });
    const loaded = await loadLintConfig((name) => files.host.files!.read(name));
    expect(loaded.origin).toEqual({ kind: 'file', name: '.markdownlint.json' });
    const long = 'palavra '.repeat(15) + '\n';
    expect(lintMarkdown(long, loaded.config).map((f) => f.rule)).toContain('MD013');
    expect(rulesInUseText(loaded.origin)).toBe('Arquivo .markdownlint.json desta pasta');
  });

  it('.jsonc com comentários e vírgula final é lido; vence o .json (D-R7-S5-01)', async () => {
    const jsonc = '{\n  // linhas longas\n  "MD013": { "line_length": 20 }, /* fim */\n}\n';
    const files = fakeLintHost({ '.markdownlint.jsonc': jsonc, '.markdownlint.json': '{}' });
    const loaded = await loadLintConfig((name) => files.host.files!.read(name));
    expect(loaded.origin).toEqual({ kind: 'file', name: '.markdownlint.jsonc' });
    expect(loaded.config).toEqual({ MD013: { line_length: 20 } });
    expect(stripJsonc('{"a": "// não é comentário", "b": "/* nem isto */",}')).toBe(
      '{"a": "// não é comentário", "b": "/* nem isto */"}',
    );
  });

  it('`extends` e `$schema` são ignorados; valores fora do formato → inválido', () => {
    expect(parseLintConfig('{"extends": "./outro.json", "MD009": false}', false)).toEqual({
      MD009: false,
    });
    expect(parseLintConfig('{"$schema": "x", "default": false}', false)).toEqual({
      default: false,
    });
    expect(parseLintConfig('[1]', false)).toBeNull();
    expect(parseLintConfig('{"MD009": 3}', false)).toBeNull();
    expect(parseLintConfig('{"MD009": true // x\n}', false)).toBeNull();
    expect(parseLintConfig('{"MD009": "warning"}', false)).toEqual({ MD009: 'warning' });
  });

  it('JSON inválido → padrão do app + 1 aviso por sessão (mesmo reativando o plugin)', async () => {
    const files = fakeLintHost({ '.markdownlint.json': '{ inválido' });
    const first = fakeApi();
    const dispose = createLintPlugin(files.host).default(first.api);
    await vi.waitFor(() =>
      expect(first.notices).toEqual([invalidConfigNotice('.markdownlint.json')]),
    );
    expect(first.notices[0]).toBe(
      'Lint: .markdownlint.json é inválido; usando as regras padrão do simpleMD.',
    );
    dispose();
    const second = fakeApi();
    createLintPlugin(files.host).default(second.api)();
    // A 2ª ativação releu os 2 nomes; o aviso (se houvesse) sai logo depois da leitura.
    await vi.waitFor(() => expect(files.reads).toHaveLength(4));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(second.notices).toEqual([]);
    const loaded = await loadLintConfig((name) => files.host.files!.read(name));
    expect(loaded.config).toBe(DEFAULT_LINT_CONFIG);
    expect(rulesInUseText(loaded.origin)).toBe(
      'Arquivo .markdownlint.json desta pasta inválido; usando o padrão do simpleMD',
    );
  });

  it('arquivo grande demais conta como inválido; sem arquivo → padrão', async () => {
    const big = fakeLintHost({ '.markdownlint.json': { error: 'too-large' } });
    expect((await loadLintConfig((n) => big.host.files!.read(n))).origin).toEqual({
      kind: 'invalid',
      name: '.markdownlint.json',
    });
    const none = fakeLintHost();
    const loaded = await loadLintConfig((n) => none.host.files!.read(n));
    expect(loaded).toEqual({ config: DEFAULT_LINT_CONFIG, origin: { kind: 'default' } });
    expect(await rulesInUse((n) => none.host.files!.read(n))).toBe(
      'Padrão do simpleMD (MD013, MD033 e MD041 desligadas)',
    );
  });

  it('`.markdownlint.cjs`/`.yaml` presentes nunca são pedidos (só os 2 nomes JSON)', async () => {
    const files = fakeLintHost({
      '.markdownlint.cjs': 'module.exports = { MD013: true }',
      '.markdownlint.yaml': 'MD013: true',
    });
    const { api } = fakeApi();
    const dispose = createLintPlugin(files.host).default(api);
    await vi.waitFor(() => expect(files.reads.length).toBe(2));
    expect(files.reads).toEqual(['.markdownlint.jsonc', '.markdownlint.json']);
    dispose();
  });

  it('mudança no arquivo → reaplicado e o lint roda de novo em ≤ 2 s', async () => {
    const files = fakeLintHost();
    const { api, extensions } = fakeApi();
    const dispose = createLintPlugin(files.host, { engine: { idle: (run) => run() } }).default(api);
    const long = '# T\n\n' + 'palavra '.repeat(15) + '\n';
    const view = mountView(long, extensions);
    await vi.waitFor(() => expect(diagnosticCount(view.state)).toBeGreaterThanOrEqual(0));
    await vi.waitFor(() => expect(lintCounters.runs).toBeGreaterThan(0));
    expect(shown(view)).not.toContain('MD013@3');
    const started = Date.now();
    files.change('.markdownlint.json', '{ "MD013": true }');
    await vi.waitFor(() => expect(shown(view)).toContain('MD013@3'), { timeout: 2000 });
    expect(Date.now() - started).toBeLessThanOrEqual(2000);
    dispose();
  });
});

describe('AC-I5.3 espera de 750 ms (relógio falso)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('0 execuções durante digitação contínua < 750 ms; 1 execução depois', async () => {
    const files = fakeLintHost();
    const { api, extensions } = fakeApi();
    const dispose = createLintPlugin(files.host, { engine: { idle: (run) => run() } }).default(api);
    const view = mountView('# Nota\n\ntexto\n', extensions);
    // Ao abrir: uma passada imediata (R-I5.1).
    await vi.advanceTimersByTimeAsync(1);
    const opened = lintCounters.runs;
    expect(opened).toBeGreaterThan(0);
    // 30 teclas a cada 100 ms (3 s de digitação contínua, sempre < 750 ms entre teclas).
    for (let i = 0; i < 30; i++) {
      view.dispatch({ changes: { from: view.state.doc.length, insert: 'a' } });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(lintCounters.runs - opened).toBe(0);
    await vi.advanceTimersByTimeAsync(LINT_DELAY_MS - 100 - 1);
    expect(lintCounters.runs - opened).toBe(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(lintCounters.runs - opened).toBe(1);
    dispose();
  });
});

describe('AC-I5.4 só diagnóstico (R-I5.4, regra 1)', () => {
  it('sha256 do documento igual após 100 execuções; 0 transações com mudança', async () => {
    const files = fakeLintHost();
    const { api, extensions } = fakeApi();
    const dispose = createLintPlugin(files.host, { engine: { idle: (run) => run() } }).default(api);
    let docChanges = 0;
    const view = mountView(FIXTURE, [
      extensions,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) docChanges++;
      }),
    ]);
    const before = sha256(view.state.doc.toString());
    await vi.waitFor(() => expect(shown(view).length).toBeGreaterThan(0));
    const start = lintCounters.runs;
    for (let i = 1; i <= 100; i++) {
      // Cada mudança da configuração da pasta força uma passada nova sobre o MESMO documento.
      files.change('.markdownlint.json', JSON.stringify({ MD009: { br_spaces: 2 + (i % 2) } }));
      await vi.waitFor(() => expect(lintCounters.runs - start).toBe(i), { interval: 1 });
    }
    await vi.waitFor(() => expect(shown(view).length).toBeGreaterThan(0));
    expect(lintCounters.runs - start).toBe(100);
    expect(sha256(view.state.doc.toString())).toBe(before);
    expect(docChanges).toBe(0);
    dispose();
  });

  it('nenhuma ação "Corrigir": diagnósticos sem `actions`; o cartão só tem "Saiba mais"', () => {
    const { diagnostics } = lintState(FIXTURE);
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const d of diagnostics) {
      expect(d.actions).toBeUndefined();
      expect(problemInfo(d)?.actions.map((a) => a.action)).toEqual(['learn-more']);
      expect(JSON.stringify(problemInfo(d))).not.toMatch(/Corrigir|fix/i);
    }
    // O worker nunca devolve correções (`fixInfo` não sai do motor).
    for (const finding of lintMarkdown(FIXTURE, DEFAULT_LINT_CONFIG))
      expect(Object.keys(finding).sort()).toEqual(['alias', 'line', 'range', 'rule']);
  });
});

describe('motor: worker de módulo → clássico → tempo ocioso (Q-R7-F04)', () => {
  /** Worker falso: `ready` ou `error` ao subir, e resposta pelo `lintMarkdown` real. */
  class FakeWorker extends EventTarget {
    terminated = false;
    constructor(readonly boot: 'ready' | 'error' | 'silent') {
      super();
      queueMicrotask(() => {
        if (boot === 'ready') this.reply({ type: 'ready' });
        if (boot === 'error') this.dispatchEvent(new Event('error'));
      });
    }
    reply(data: LintReply) {
      this.dispatchEvent(new MessageEvent('message', { data }));
    }
    postMessage(request: { seq: number; text: string; config: Record<string, unknown> }) {
      queueMicrotask(() =>
        this.reply({
          type: 'result',
          seq: request.seq,
          results: lintMarkdown(request.text, request.config),
        }),
      );
    }
    terminate() {
      this.terminated = true;
    }
  }

  it('worker de módulo que sobe: usa o de módulo', async () => {
    const kinds: string[] = [];
    const engine = createLintEngine({
      createWorker: (kind) => {
        kinds.push(kind);
        return new FakeWorker('ready') as unknown as Worker;
      },
    });
    const results = await engine.run('x   \n', DEFAULT_LINT_CONFIG);
    expect(results.map((r) => r.rule)).toEqual(['MD009']);
    expect(engine.mode()).toBe('module');
    expect(kinds).toEqual(['module']);
    engine.dispose();
  });

  it('módulo falha (erro ao subir) → clássico; ambos falham → ocioso + aviso em nota > 2.000 linhas', async () => {
    const kinds: string[] = [];
    const classic = createLintEngine({
      createWorker: (kind) => {
        kinds.push(kind);
        return new FakeWorker(kind === 'module' ? 'error' : 'ready') as unknown as Worker;
      },
    });
    await classic.run('x\n', DEFAULT_LINT_CONFIG);
    expect(classic.mode()).toBe('classic');
    expect(kinds).toEqual(['module', 'classic']);
    classic.dispose();

    vi.useFakeTimers();
    let fallbacks = 0;
    const terminated: FakeWorker[] = [];
    const idle = createLintEngine({
      createWorker: (kind) => {
        if (kind === 'module') throw new Error('type module não suportado');
        const silent = new FakeWorker('silent');
        terminated.push(silent);
        return silent as unknown as Worker;
      },
      idle: (run) => setTimeout(run, 0),
      onIdleFallback: () => fallbacks++,
    });
    const pending = idle.run('x   \n', DEFAULT_LINT_CONFIG);
    // O clássico nunca manda `ready`: depois de READY_TIMEOUT_MS (4 s) ele é encerrado.
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS + 1);
    const results = await pending;
    expect(results.map((r) => r.rule)).toEqual(['MD009']);
    expect(idle.mode()).toBe('idle');
    expect(terminated.map((w) => w.terminated)).toEqual([true]);
    expect(fallbacks).toBe(1);
    const again = idle.run('y   \n', DEFAULT_LINT_CONFIG);
    await vi.advanceTimersByTimeAsync(1);
    await again;
    expect(fallbacks).toBe(1);
    idle.dispose();
  });

  it('plano C numa nota > 2.000 linhas mostra o aviso "lint lento" uma vez por sessão', async () => {
    const files = fakeLintHost();
    const { api, extensions, notices } = fakeApi();
    const dispose = createLintPlugin(files.host, {
      engine: {
        createWorker: () => {
          throw new Error('sem worker');
        },
        idle: (run) => run(),
      },
    }).default(api);
    mountView('linha\n'.repeat(2100), extensions);
    await vi.waitFor(() => expect(notices).toContain(SLOW_LINT_NOTICE));
    dispose();
    const again = fakeApi();
    const off = createLintPlugin(files.host, {
      engine: {
        createWorker: () => {
          throw new Error('sem worker');
        },
        idle: (run) => run(),
      },
    }).default(again.api);
    const before = lintCounters.runs;
    mountView('linha\n'.repeat(2100), again.extensions);
    // O aviso do plano C sai antes da passada: depois dela, nada novo apareceu.
    await vi.waitFor(() => expect(lintCounters.runs).toBeGreaterThan(before));
    expect(again.notices).toEqual([]);
    off();
  });

  it('jsdom sem `Worker`: cai direto no plano C', async () => {
    expect(typeof Worker).toBe('undefined');
    const engine = createLintEngine({ idle: (run) => run() });
    await engine.run('x\n', DEFAULT_LINT_CONFIG);
    expect(engine.mode()).toBe('idle');
    engine.dispose();
  });
});
