import { undo } from '@codemirror/commands';
import { forEachDiagnostic, type Diagnostic } from '@codemirror/lint';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LT_TIMING, NOT_FOUND_NOTICE } from '../src/languagetool/checker';
import { ltField } from '../src/languagetool/field';
import { CHECK_NOW_ID, CHECK_NOW_TITLE } from '../src/languagetool/index';
import { openProblemCard, problemInfo } from '../src/shared/diagnostics-ui';
import { destroyViews } from './helpers';
import { FakeTransport, fixture, flush, mountLt, type Mounted } from './lt-harness';

/**
 * Plugin "Ortografia e gramática (LanguageTool)" (r7 S8, I-8) — VT de AC-I8.1, I8.3…I8.11 com
 * relógio e transporte falsos e as respostas gravadas do LT 6.8 real (`fixtures/lt/`).
 */

let mounted: Mounted[] = [];
function mount(...args: Parameters<typeof mountLt>): Mounted {
  const m = mountLt(...args);
  mounted.push(m);
  return m;
}

afterEach(() => {
  for (const m of mounted) m.dispose();
  mounted = [];
  destroyViews();
  vi.restoreAllMocks();
});

const PT = fixture('pt-BR-check.md');
const EN = fixture('en-US-check.md');

/** Diagnósticos publicados no `@codemirror/lint` (o que o editor sublinha). */
function lintDiagnostics(m: Mounted): Diagnostic[] {
  const out: Diagnostic[] = [];
  forEachDiagnostic(m.view.state, (d, from, to) => out.push({ ...d, from, to }));
  return out;
}

function type(m: Mounted, pos: number, text: string): void {
  m.view.dispatch({ changes: { from: pos, insert: text }, userEvent: 'input.type' });
}

/** Sobe a sonda e responde a verificação inicial do viewport. */
async function ready(m: Mounted): Promise<void> {
  await m.clock.advance(0);
  await flush();
}

describe('AC-I8.1 plugin desligado/ligado', () => {
  test('depois de desligar: 0 chamadas ao transporte em 60 s de digitação', async () => {
    const m = mount(PT);
    await ready(m);
    const before = m.transport.calls.length;
    m.dispose();
    mounted = mounted.filter((x) => x !== m);
    for (let i = 0; i < 60; i++) await m.clock.advance(1_000);
    expect(m.transport.calls.length).toBe(before);
    expect(m.clock.pending()).toBe(0);
  });

  test('ligado: sonda + verificação; comando de paleta com o título exato', async () => {
    const m = mount(PT);
    await ready(m);
    expect(m.transport.count('languages')).toBe(1);
    expect(m.transport.count('check')).toBe(1);
    expect(m.commands.map((c) => [c.id, c.title, c.hotkey])).toEqual([
      [CHECK_NOW_ID, CHECK_NOW_TITLE, 'Mod-Shift-o'],
    ]);
  });
});

describe('AC-I8.3 corpo do pedido', () => {
  test('front matter lang: en-US → en-US; sem lang → pt-BR; Automático → auto + variantes', async () => {
    const en = mount(EN);
    await ready(en);
    expect(en.transport.checks()[0]?.request?.language).toBe('en-US');
    const pt = mount(PT);
    await ready(pt);
    expect(pt.transport.checks()[0]?.request?.language).toBe('pt-BR');
    expect(pt.transport.checks()[0]?.request?.preferredVariants).toBeUndefined();
    const auto = mount(PT, { options: { language: 'auto' } });
    await ready(auto);
    const req = auto.transport.checks()[0]?.request;
    expect([req?.language, req?.preferredVariants]).toEqual(['auto', ['pt-BR', 'en-US']]);
  });

  test('markup: front matter, código, matemática, URL, destinos de link/wikilink e HTML; deslocamentos preservados', async () => {
    const doc = [
      '---',
      'lang: pt-BR',
      '---',
      'Texto com `código` e $x^2$ e https://exemplo.org e [rótulo](https://a.b/c) e [[Nota|apelido]] e <kbd>K</kbd>.',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      '$$',
      'a+b',
      '$$',
      '',
      '<div>',
      'bloco html',
      '</div>',
      '',
      'Fim do texto.',
      '',
    ].join('\n');
    const m = mount(doc);
    await ready(m);
    const req = m.transport.checks()[0]?.request;
    if (!req) throw new Error('sem pedido');
    const joined = req.annotation.map((s) => ('text' in s ? s.text : s.markup)).join('');
    // Deslocamentos preservados: o pedido é o documento a partir de 0 até o fim da última unidade.
    expect(joined).toBe(doc.slice(0, joined.length));
    expect(joined.endsWith('Fim do texto.')).toBe(true);
    const markup = req.annotation.flatMap((s) => ('markup' in s ? [s.markup] : []));
    const text = req.annotation.flatMap((s) => ('text' in s ? [s.text] : [])).join('');
    for (const piece of [
      '---\nlang: pt-BR\n---',
      '`código` ',
      '$x^2$ ',
      'https://exemplo.org ',
      '(https://a.b/c)',
      'Nota|',
      '<kbd>',
      '```js\nconst x = 1;\n```',
      '$$\na+b\n$$',
      '<div>\nbloco html\n</div>',
    ])
      expect(markup.some((x) => x.includes(piece))).toBe(true);
    for (const hidden of [
      'código',
      'x^2',
      'exemplo.org',
      'a.b/c',
      'Nota',
      'const x',
      'a+b',
      'bloco html',
      'kbd',
    ])
      expect(text).not.toContain(hidden);
    for (const visible of ['Texto com', 'rótulo', 'apelido', 'K', 'Fim do texto.'])
      expect(text).toContain(visible);
    // Front matter (antes da 1ª unidade) e o trecho código + `$$` + HTML (entre as duas unidades).
    const blocks = req.annotation.flatMap((s) =>
      'markup' in s && s.interpretAs === '\n\n' ? [s.markup] : [],
    );
    expect(blocks).toEqual([
      '---\nlang: pt-BR\n---\n',
      '\n\n```js\nconst x = 1;\n```\n\n$$\na+b\n$$\n\n<div>\nbloco html\n</div>\n\n',
    ]);
  });
});

describe('AC-I8.4 agendamento (relógio falso)', () => {
  test('1 pedido 1.000 ms depois da última edição; digitação contínua não pede', async () => {
    const m = mount(PT);
    await ready(m);
    const base = m.transport.count('check');
    for (let i = 0; i < 10; i++) {
      type(m, 0, 'a');
      await m.clock.advance(500);
    }
    expect(m.transport.count('check')).toBe(base);
    await m.clock.advance(499);
    expect(m.transport.count('check')).toBe(base);
    await m.clock.advance(1);
    expect(m.transport.count('check')).toBe(base + 1);
  });

  test('nunca 2 em voo; edição durante o pedido o cancela e o próximo o substitui', async () => {
    const m = mount(PT);
    m.transport.checkReply = 'hang';
    await ready(m);
    const first = m.transport.checks()[0];
    expect(m.transport.inFlight).toBe(1);
    type(m, 0, 'x');
    await flush();
    expect(m.transport.calls.some((c) => c.op === 'cancel' && c.id === first?.id)).toBe(true);
    expect(m.transport.inFlight).toBe(0);
    await m.clock.advance(LT_TIMING.debounceMs);
    expect(m.transport.count('check')).toBe(2);
    expect(m.transport.maxInFlight).toBe(1);
  });

  test('> 20.000 caracteres: dividido por parágrafos, cada pedido ≤ 20.000 unidades', async () => {
    const paragraph = `${'Palavra '.repeat(150).trim()}.`; // ~1.200 caracteres
    const doc = Array.from({ length: 40 }, () => paragraph).join('\n\n');
    expect(doc.length).toBeGreaterThan(40_000);
    const m = mount(doc, { options: { mode: 'manual' } });
    await ready(m);
    m.commands[0]?.run(m.view);
    for (let i = 0; i < 5; i++) await m.clock.advance(0);
    const checks = m.transport.checks();
    expect(checks.length).toBeGreaterThanOrEqual(3);
    let covered = 0;
    for (const c of checks) {
      const parts = c.request?.annotation ?? [];
      const units = parts.reduce((n, s) => n + ('text' in s ? s.text : s.markup).length, 0);
      expect(units).toBeLessThanOrEqual(20_000);
      const text = parts.map((s) => ('text' in s ? s.text : s.markup)).join('');
      expect(text.startsWith('Palavra')).toBe(true);
      expect(text.endsWith('.')).toBe(true);
      covered += text.length;
    }
    expect(covered).toBeGreaterThanOrEqual(doc.length - 2 * checks.length);
    expect(m.transport.maxInFlight).toBe(1);
  });
});

describe('AC-I8.5 resposta gravada vira diagnósticos; remapeamento', () => {
  test('pt-BR-check.json: 3 diagnósticos nos intervalos certos, ortografia × gramática', async () => {
    const m = mount(PT);
    m.transport.checkReply = { body: fixture('pt-BR-check.json') };
    await ready(m);
    const diags = lintDiagnostics(m)
      .map((d) => [PT.slice(d.from, d.to), d.markClass])
      .sort();
    expect(diags).toEqual(
      [
        ['Eu vai', 'cm-lintRange-grammar'],
        ['em [o', 'cm-lintRange-grammar'],
        ['excessão', 'cm-lintRange-spelling'],
      ].sort(),
    );
    expect(m.status()).toEqual({ state: 'issues', count: 3 });
  });

  test('50 edições aleatórias (semente fixa) durante o pedido: 0 sublinhados fora do lugar', async () => {
    const m = mount(PT, { options: { mode: 'manual' } });
    await ready(m);
    m.transport.checkReply = 'hang';
    m.commands[0]?.run(m.view);
    await flush();
    let seed = 0x5eed;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 50; i++) {
      const len = m.view.state.doc.length;
      const from = Math.floor(random() * len);
      const del = random() < 0.4 ? Math.min(len - from, Math.floor(random() * 4)) : 0;
      m.view.dispatch({ changes: { from, to: from + del, insert: random() < 0.5 ? 'zé ' : '' } });
    }
    m.transport.resolvePending(fixture('pt-BR-check.json'));
    await flush();
    const { diags } = m.view.state.field(ltField);
    for (const d of diags) expect(m.view.state.sliceDoc(d.from, d.to)).toBe(d.expected);
    // Mais edições depois da resposta: o que é tocado sai, o resto continua no lugar.
    for (let i = 0; i < 20; i++) {
      const pos = Math.floor(random() * m.view.state.doc.length);
      m.view.dispatch({ changes: { from: pos, insert: 'q' } });
      for (const d of m.view.state.field(ltField).diags)
        expect(m.view.state.sliceDoc(d.from, d.to)).toBe(d.expected);
    }
  });

  test('sem edições: a resposta remapeada é igual à original (nada descartado)', async () => {
    const m = mount(PT, { options: { mode: 'manual' } });
    await ready(m);
    m.transport.checkReply = 'hang';
    m.commands[0]?.run(m.view);
    await flush();
    type(m, PT.length, '\nNova linha.');
    m.transport.resolvePending(fixture('pt-BR-check.json'));
    await flush();
    expect(m.view.state.field(ltField).diags.map((d) => d.expected)).toEqual([
      'Eu vai',
      'em [o',
      'excessão',
    ]);
  });
});

describe('AC-I8.6 servidor ausente', () => {
  const refused = { error: { code: 'CONNECTION_REFUSED', message: 'recusado' } };

  test('"não encontrado" na hora, 1 aviso por sessão, novas sondas em 30/60/120/300/300 s', async () => {
    const transport = new FakeTransport();
    transport.languagesReply = refused;
    const m = mount(PT, { transport });
    await m.clock.advance(0);
    expect(m.status()).toEqual({ state: 'not-found' });
    expect(m.clock.now()).toBeLessThanOrEqual(2_500);
    const probesAt: number[] = [];
    const count = () => transport.count('languages');
    let seen = count();
    for (let t = 0; t < 900_000; t += 1_000) {
      await m.clock.advance(1_000);
      if (count() > seen) {
        probesAt.push(m.clock.now());
        seen = count();
      }
    }
    expect(probesAt.slice(0, 5)).toEqual([30_000, 90_000, 210_000, 510_000, 810_000]);
    expect(m.notices).toEqual([{ text: NOT_FOUND_NOTICE, level: 'warn' }]);
    expect(lintDiagnostics(m)).toEqual([]);
  });

  test('sonda que não responde: "não encontrado" em 2 s', async () => {
    const transport = new FakeTransport();
    transport.languagesReply = 'hang';
    const m = mount(PT, { transport });
    await m.clock.advance(1_999);
    expect(m.status()).toEqual({ state: 'checking' });
    await m.clock.advance(1);
    expect(m.status()).toEqual({ state: 'not-found' });
  });

  test('"Tentar de novo" e foco da janela sondam na hora; volta a "N problemas"', async () => {
    const transport = new FakeTransport();
    transport.languagesReply = refused;
    const m = mount(PT, { transport });
    await m.clock.advance(0);
    const probes = transport.count('languages');
    m.menu('retry');
    await flush();
    expect(transport.count('languages')).toBe(probes + 1);
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(transport.count('languages')).toBe(probes + 2);
    transport.languagesReply = { body: fixture('languages.json') };
    transport.checkReply = { body: fixture('pt-BR-check.json') };
    m.menu('retry');
    await m.clock.advance(0);
    expect(m.status()).toEqual({ state: 'issues', count: 3 });
    expect(m.notices.length).toBe(1);
  });

  test('digitação nunca espera o servidor (update síncrono, sem pedido)', async () => {
    const transport = new FakeTransport();
    transport.languagesReply = 'hang';
    const m = mount(PT, { transport });
    const started = performance.now();
    for (let i = 0; i < 200; i++) type(m, 0, 'a');
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(transport.count('check')).toBe(0);
  });

  test('servidor some no meio da sessão: conexão recusada na verificação → "não encontrado"', async () => {
    const m = mount(PT);
    m.transport.checkReply = { body: fixture('pt-BR-check.json') };
    await ready(m);
    expect(lintDiagnostics(m).length).toBe(3);
    m.transport.checkReply = refused;
    type(m, 0, 'a');
    await m.clock.advance(LT_TIMING.debounceMs);
    expect(m.status()).toEqual({ state: 'not-found' });
    expect(m.view.state.field(ltField).diags).toEqual([]);
  });
});

describe('AC-I8.7 servidor lento', () => {
  test('resposta em 16 s: cancelado em 15 s, "sem resposta", só os alterados saem', async () => {
    const m = mount(PT);
    m.transport.checkReply = { body: fixture('pt-BR-check.json') };
    await ready(m);
    expect(m.view.state.field(ltField).diags.length).toBe(3);
    m.transport.checkReply = 'hang';
    // Edição no parágrafo de "excessão" (o último), longe dos outros dois.
    const pos = PT.indexOf('Isso é');
    type(m, pos, 'Hoje ');
    await m.clock.advance(LT_TIMING.debounceMs);
    const id = m.transport.checks().at(-1)?.id;
    await m.clock.advance(LT_TIMING.checkMs - 1);
    expect(m.status()).toEqual({ state: 'checking' });
    await m.clock.advance(1);
    expect(m.transport.calls.some((c) => c.op === 'cancel' && c.id === id)).toBe(true);
    expect(m.status()).toEqual({ state: 'timeout' });
    expect(m.view.state.field(ltField).diags.map((d) => d.expected)).toEqual(['Eu vai', 'em [o']);
    // Nova tentativa em 30 s sem edição.
    const checks = m.transport.count('check');
    await m.clock.advance(LT_TIMING.timeoutRetryMs);
    expect(m.transport.count('check')).toBe(checks + 1);
  });

  test('TIMEOUT do transporte (Rust) tem o mesmo efeito', async () => {
    const m = mount(PT);
    m.transport.checkReply = { error: { code: 'TIMEOUT', message: 't', detail: { seconds: 15 } } };
    await ready(m);
    expect(m.status()).toEqual({ state: 'timeout' });
  });
});

describe('AC-I8.8 erros: resposta descartada, "erro <código>", 1 aviso por tipo', () => {
  const big = `{"matches":[],"pad":"${'x'.repeat(2 * 1024 * 1024)}"}`;
  test.each([
    [
      'HTTP 500',
      { error: { code: 'LT_HTTP_STATUS', message: 'e', detail: { status: 500 } } },
      '500',
    ],
    [
      'HTTP 413',
      { error: { code: 'LT_HTTP_STATUS', message: 'e', detail: { status: 413 } } },
      '413',
    ],
    ['JSON inválido', { body: '{"matches": [' }, 'resposta inválida'],
    ['offset fora do texto', { body: fixture('err-offset.json') }, 'resposta inválida'],
    ['matches ausente', { body: fixture('err-missing-matches.json') }, 'resposta inválida'],
    ['2 MiB + 1 no corpo', { body: big }, 'resposta grande demais'],
    [
      '2 MiB + 1 no Rust',
      { error: { code: 'RESPONSE_TOO_LARGE', message: 'g' } },
      'resposta grande demais',
    ],
  ])('%s', async (_name, reply, code) => {
    const m = mount(PT);
    m.transport.checkReply = { body: fixture('pt-BR-check.json') };
    await ready(m);
    const before = m.view.state.field(ltField).diags;
    m.transport.checkReply = reply as never;
    type(m, PT.length, ' fim');
    await m.clock.advance(LT_TIMING.debounceMs);
    expect(m.status()).toEqual({ state: 'error', code });
    expect(m.view.state.field(ltField).diags).toEqual(before);
    type(m, PT.length, ' de novo');
    await m.clock.advance(LT_TIMING.debounceMs);
    expect(m.notices).toEqual([
      { text: `Ortografia e gramática: o servidor respondeu com erro ${code}.`, level: 'error' },
    ]);
  });

  test('mensagem com <img src=x onerror> aparece como texto no cartão', async () => {
    const recorded = JSON.parse(fixture('pt-BR-check.json')) as { matches: { message: string }[] };
    for (const match of recorded.matches) match.message = '<img src=x onerror="window.__pwned=1">';
    const m = mount(PT);
    m.transport.checkReply = { body: JSON.stringify(recorded) };
    await ready(m);
    const target = m.view.state.field(ltField).diags[0];
    if (!target) throw new Error('sem diagnóstico');
    expect(openProblemCard(m.view, target.from)).toBe(true);
    const card = document.querySelector('[data-testid="problem-card"]');
    expect(card?.textContent).toContain('<img src=x onerror="window.__pwned=1">');
    expect(card?.querySelector('img')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });
});

describe('AC-I8.9 ações do cartão (VT; teclado e AXE no PW)', () => {
  async function withIssues(settings: Record<string, unknown> = {}) {
    const m = mount(PT, { settings });
    m.transport.checkReply = { body: fixture('pt-BR-check.json') };
    await ready(m);
    return m;
  }
  const info = (m: Mounted, expected: string) => {
    let found: { diag: Diagnostic; from: number; to: number } | undefined;
    forEachDiagnostic(m.view.state, (diag, from, to) => {
      if (m.view.state.sliceDoc(from, to) === expected) found = { diag, from, to };
    });
    const data = found && problemInfo(found.diag);
    if (!found || !data) throw new Error(`sem diagnóstico para ${expected}`);
    return { diag: { from: found.from, to: found.to }, data };
  };

  test('cartão: título da categoria, até 5 trocas, rodapé com a regra; ortografia tem dicionário', async () => {
    const m = await withIssues();
    const spelling = info(m, 'excessão').data;
    expect(spelling.title).toBe('Ortografia');
    expect(spelling.footer).toBe('Regra MORFOLOGIK_RULE_PT_BR');
    expect(spelling.actions.map((a) => a.label)).toEqual([
      'Trocar por “exceção”',
      'Trocar por “excesso”',
      'Trocar por “acessam”',
      'Trocar por “acessão”',
      'Trocar por “excelsam”',
      'Ignorar',
      'Adicionar ao dicionário',
      'Desativar regra',
    ]);
    expect(spelling.actions.at(-1)?.name).toBe('Desativar regra MORFOLOGIK_RULE_PT_BR');
    const grammar = info(m, 'Eu vai').data;
    expect(grammar.title).toBe('Gramática');
    expect(grammar.actions.map((a) => a.action)).toEqual(['replace', 'ignore', 'disable-rule']);
  });

  test('troca: o trecho muda num passo de desfazer, anúncio e o sublinhado sai', async () => {
    const m = await withIssues();
    const { diag, data } = info(m, 'excessão');
    data.actions[0]?.run(m.view, diag.from, diag.to);
    expect(m.view.state.doc.toString()).toBe(PT.replace('excessão', 'exceção'));
    expect(m.announcements).toContain('Trocado por “exceção”.');
    expect(m.view.state.field(ltField).diags.map((d) => d.expected)).not.toContain('excessão');
    undo(m.view);
    expect(m.view.state.doc.toString()).toBe(PT);
  });

  test('Ignorar: some e continua ignorado quando a mesma resposta volta', async () => {
    const m = await withIssues();
    const { diag, data } = info(m, 'Eu vai');
    data.actions.find((a) => a.action === 'ignore')?.run(m.view, diag.from, diag.to);
    expect(m.view.state.field(ltField).diags.map((d) => d.expected)).toEqual(['em [o', 'excessão']);
    m.commands[0]?.run(m.view);
    await m.clock.advance(0);
    expect(m.view.state.field(ltField).diags.map((d) => d.expected)).toEqual(['em [o', 'excessão']);
    expect(m.announcements).toContain('Problema ignorado nesta sessão.');
  });

  test('Adicionar ao dicionário: gravado no data.json e filtra as próximas respostas (reabrir)', async () => {
    const m = await withIssues();
    const { diag, data } = info(m, 'excessão');
    data.actions.find((a) => a.action === 'dictionary')?.run(m.view, diag.from, diag.to);
    await flush();
    expect(m.settings.get('dictionary')).toEqual(['excessão']);
    expect(m.announcements).toContain('“excessão” adicionada ao dicionário.');
    // "Reabrir o vault": nova ativação com o mesmo data.json.
    const again = await withIssues({ dictionary: m.settings.get('dictionary') });
    expect(again.view.state.field(ltField).diags.map((d) => d.expected)).toEqual([
      'Eu vai',
      'em [o',
    ]);
  });

  test('Desativar regra: entra em disabledRules (persistido), sai da tela e vai no próximo pedido', async () => {
    const m = await withIssues();
    const { diag, data } = info(m, 'Eu vai');
    data.actions.find((a) => a.action === 'disable-rule')?.run(m.view, diag.from, diag.to);
    await flush();
    expect(m.settings.get('disabledRules')).toEqual(['GENERAL_VERB_AGREEMENT_ERRORS']);
    expect(m.view.state.field(ltField).diags.map((d) => d.expected)).toEqual(['em [o', 'excessão']);
    m.commands[0]?.run(m.view);
    await m.clock.advance(0);
    expect(m.transport.checks().at(-1)?.request?.disabledRules).toEqual([
      'GENERAL_VERB_AGREEMENT_ERRORS',
    ]);
    expect(m.view.state.field(ltField).diags.map((d) => d.expected)).toEqual(['em [o', 'excessão']);
    expect(m.announcements).toContain(
      'Regra GENERAL_VERB_AGREEMENT_ERRORS desativada. Reative em Configurações → Plugins.',
    );
  });

  test('"Reativar" nas Opções (opção muda) reverifica o viewport sem a regra', async () => {
    const m = await withIssues({ disabledRules: ['X_RULE'] });
    expect(m.transport.checks()[0]?.request?.disabledRules).toEqual(['X_RULE']);
    m.settings.set('disabledRules', []);
    m.setOption('disabledRules', []);
    await m.clock.advance(0);
    expect(m.transport.checks().at(-1)?.request?.disabledRules).toBeUndefined();
  });
});

describe('AC-I8.10 modo manual', () => {
  test('0 pedidos ao digitar; o comando "Verificar … agora" faz 1 pedido', async () => {
    const m = mount(PT, { options: { mode: 'manual' } });
    await ready(m);
    expect(m.status()).toEqual({ state: 'manual' });
    for (let i = 0; i < 60; i++) {
      type(m, 0, 'b');
      await m.clock.advance(1_000);
    }
    expect(m.transport.count('check')).toBe(0);
    m.commands[0]?.run(m.view);
    await m.clock.advance(0);
    expect(m.transport.count('check')).toBe(1);
    expect(m.status()).toEqual({ state: 'issues', count: 0 });
    type(m, 0, 'c');
    expect(m.status()).toEqual({ state: 'manual' });
  });

  test('item "Verificar agora" do menu M2 e troca de modo pelas Opções', async () => {
    const m = mount(PT, { options: { mode: 'manual' } });
    await ready(m);
    m.menu('check-now');
    await m.clock.advance(0);
    expect(m.transport.count('check')).toBe(1);
    m.setOption('mode', 'auto');
    await m.clock.advance(0);
    expect(m.transport.count('check')).toBe(2);
    m.setOption('mode', 'manual');
    type(m, 0, 'z');
    await m.clock.advance(5_000);
    expect(m.transport.count('check')).toBe(2);
  });
});

describe('AC-I8.11 privacidade: o log só tem contagens e tempos', () => {
  test('5 min de uso com o plugin ligado: 0 trechos da nota no console', async () => {
    const logged: unknown[] = [];
    for (const level of ['log', 'debug', 'info', 'warn', 'error'] as const)
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => logged.push(args));
    const secret = 'Segredo confidencial da Ana sobre o projeto Tucano.';
    const m = mount(`${PT}\n\n${secret}\n`);
    m.transport.checkReply = { body: fixture('pt-BR-check.json') };
    await ready(m);
    const replies = [
      { body: fixture('pt-BR-check.json') },
      { error: { code: 'LT_HTTP_STATUS', message: 'e', detail: { status: 500 } } },
      'hang' as const,
      { error: { code: 'CONNECTION_REFUSED', message: 'r' } },
      { body: '{' },
    ];
    for (let s = 0; s < 300; s += 10) {
      m.transport.checkReply = replies[(s / 10) % replies.length] as never;
      type(m, m.view.state.doc.length, ` Tucano${s}`);
      await m.clock.advance(10_000);
      if (s % 60 === 0) m.menu('retry');
    }
    expect(logged.length).toBeGreaterThan(0);
    // Forma: "[simplemd] languagetool <evento>" + objeto só com números.
    for (const entry of logged as unknown[][]) {
      expect(entry[0]).toMatch(/^\[simplemd\] languagetool (probe|check|result|error|timeout)$/);
      for (const value of Object.values(entry[1] as Record<string, unknown>))
        expect(typeof value).toBe('number');
    }
    // Nenhum valor é texto: as palavras da nota (≥ 4 letras) não aparecem nos valores registrados.
    const values = JSON.stringify(
      (logged as unknown[][]).map((entry) => Object.values(entry[1] as Record<string, unknown>)),
    );
    const words = `${PT} ${secret}`.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
    for (const word of words) expect(values).not.toContain(word);
  });
});
