import { undo } from '@codemirror/commands';
import { forEachDiagnostic, type Diagnostic } from '@codemirror/lint';
import type { EditorState, Extension, TransactionSpec } from '@codemirror/state';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import { contextAction, escapeHandler, interactFacet, problemsCommandsFacet } from '@simplemd/core';
import type { PluginAPI } from '@simplemd/plugin-api';
import type { InternalHostContext } from '@simplemd/plugin-api/internal/host';
import { ESLint } from 'eslint';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { openProblemCard, problemInfo } from '../src/shared/diagnostics-ui';
import { SPELL_LIMITS, SPELL_TIMING, SpellChecker, type SpellEngine } from '../src/spell/checker';
import { createSpellPlugin, type SpellPluginDeps } from '../src/spell/index';
import { insertable, spellField } from '../src/spell/present';
import { tokensIn } from '../src/spell/tokenize';
import { destroyViews, mountView, pluginState } from './helpers';
import { FakeClock, FakeDictionary, FakeSpellCoverage, fixture, flush } from './lt-harness';

/**
 * Plugin "Ortografia offline" (`simplemd.spell`, r35c; design-r35 §1 e §5): tokenizador com as
 * exclusões compartilhadas, agendador com relógio falso (400/150 ms, cache, ≤ 20.000 palavras, uma
 * chamada por vez, `CANCELLED` e `TIMEOUT` sem rajada), cartão (trocar num passo de desfazer,
 * ignorar na sessão, adicionar ao dicionário), língua da nota e a trava da ESLint em `spell/**`
 * (code-review r35a N3). AC-R35-1 no plugin; o app e o LanguageTool juntos ficam em
 * `apps/desktop/test/spell-plugin.test.tsx`.
 */

const PT = fixture('pt-BR-check.md');

type Reply = 'answer' | 'hang' | { readonly error: string };

/** Motor falso: "excessão" é o erro (como o falso do harness); respostas controláveis por fila. */
class FakeEngine implements SpellEngine {
  readonly calls: Array<{
    readonly op: 'check' | 'suggest';
    readonly lang: string;
    readonly words?: readonly string[];
    readonly word?: string;
  }> = [];
  readonly misspelled = new Map<string, readonly string[]>([
    ['excessão', ['exceção', 'excesso']],
    ['Excessão', ['Exceção']],
  ]);
  /** Próximas respostas, em ordem; vazia = responde na hora. */
  readonly replies: Reply[] = [];
  inFlight = 0;
  maxInFlight = 0;
  #pending: { resolve: () => void; reject: (error: unknown) => void } | null = null;

  check(lang: string, words: readonly string[]): Promise<readonly number[]> {
    this.calls.push({ op: 'check', lang, words: [...words] });
    if (words.length === 0) {
      // `[]` só cancela o pedido em voo (contrato da r34).
      this.#pending?.reject({ code: 'CANCELLED', message: 'falso' });
      this.#pending = null;
      return Promise.resolve([]);
    }
    return this.#reply(() => words.flatMap((w, i) => (this.misspelled.has(w) ? [i] : [])));
  }

  suggest(lang: string, word: string): Promise<readonly string[]> {
    this.calls.push({ op: 'suggest', lang, word });
    return this.#reply(() => this.misspelled.get(word) ?? []);
  }

  of(op: 'check' | 'suggest') {
    return this.calls.filter((c) => c.op === op);
  }

  resolvePending(): void {
    const pending = this.#pending;
    this.#pending = null;
    pending?.resolve();
  }

  #reply<T>(value: () => T): Promise<T> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const reply = this.replies.shift() ?? 'answer';
    let answer: Promise<T>;
    if (reply === 'answer') answer = Promise.resolve(value());
    else if (reply === 'hang') {
      const { promise, resolve, reject } = Promise.withResolvers<T>();
      this.#pending = { resolve: () => resolve(value()), reject };
      answer = promise;
    } else answer = Promise.reject({ code: reply.error, message: 'falso' });
    return answer.finally(() => {
      this.inFlight--;
    });
  }
}

interface Mounted {
  readonly view: EditorView;
  readonly engine: FakeEngine;
  readonly clock: FakeClock;
  readonly dictionary: FakeDictionary;
  readonly coverage: FakeSpellCoverage;
  readonly ignored: Set<string>;
  readonly notices: { text: string; level: string }[];
  readonly announcements: string[];
  readonly options: Map<string, unknown>;
  /** O LanguageTool ligado com outro "Idioma padrão" (D-R35B-01); `null` = desligado. */
  setNoteLanguage(lang: string | null): void;
  /** O registro avisa que o motor recarregou. */
  reloaded(): void;
  dispose(): void;
}

let mounted: Mounted[] = [];

afterEach(() => {
  for (const m of mounted) m.dispose();
  mounted = [];
  destroyViews();
});

/** A cobertura com o pt-BR (o registro já recarregou o motor). */
function covered(): FakeSpellCoverage {
  const coverage = new FakeSpellCoverage();
  coverage.set(['pt-BR']);
  return coverage;
}

function mount(
  doc: string,
  opts: {
    anchor?: number;
    coverage?: FakeSpellCoverage;
    engine?: FakeEngine;
    ignored?: Set<string>;
    noteLanguage?: string | null;
  } = {},
): Mounted {
  const engine = opts.engine ?? new FakeEngine();
  const clock = new FakeClock();
  const dictionary = new FakeDictionary();
  const coverage = opts.coverage ?? covered();
  const ignored = opts.ignored ?? new Set<string>();
  const notices: { text: string; level: string }[] = [];
  const announcements: string[] = [];
  const options = new Map<string, unknown>([['addTo', 'global']]);
  const reloads = new Set<() => void>();
  const noteListeners = new Set<() => void>();
  let noteLanguage = opts.noteLanguage ?? null;
  const host: InternalHostContext = {
    pluginId: 'simplemd.spell',
    platform: 'mac',
    editor: {
      contextAction: (slot, action) => contextAction(slot, action),
      interact: (run) => interactFacet.of({ order: 10, run }),
      escape: (owner, run) => escapeHandler(owner, run),
      problems: (commands) => problemsCommandsFacet.of(commands),
      announce: (text) => announcements.push(text),
    },
    options: {
      get: <T>(key: string) => options.get(key) as T,
      subscribe: () => () => undefined,
    },
    links: { openExternal: () => undefined },
  };
  const deps: SpellPluginDeps = {
    engine,
    coverage,
    dictionary,
    noteLanguage: {
      get: () => noteLanguage,
      subscribe: (listener) => {
        noteListeners.add(listener);
        return () => noteListeners.delete(listener);
      },
    },
    ignored,
    onReload: (listener) => {
      reloads.add(listener);
      return () => reloads.delete(listener);
    },
  };
  const extensions: Extension[] = [];
  const api = {
    registerEditorExtension: (ext: { source?: Extension }) => {
      if (ext.source) extensions.push(ext.source);
    },
    ui: { notify: (text: string, level = 'info') => notices.push({ text, level }) },
  } as unknown as PluginAPI;
  const dispose = createSpellPlugin(host, deps, clock)(api);
  const view = mountView(doc, extensions, { anchor: opts.anchor ?? 0 });
  const m: Mounted = {
    view,
    engine,
    clock,
    dictionary,
    coverage,
    ignored,
    notices,
    announcements,
    options,
    setNoteLanguage(lang) {
      noteLanguage = lang;
      for (const listener of [...noteListeners]) listener();
    },
    reloaded() {
      for (const listener of [...reloads]) listener();
    },
    dispose() {
      dispose();
      view.destroy();
    },
  };
  mounted.push(m);
  return m;
}

/** Deixa o agendador rodar o que já venceu (verificação, sugestões) e o lint pintar. */
async function settle(m: Mounted, ms = 0): Promise<void> {
  await m.clock.advance(ms);
  for (let i = 0; i < 5; i++) await flush();
}

/** O texto sublinhado (o que o `@codemirror/lint` publicou). */
function underlined(m: Mounted): string[] {
  const out: string[] = [];
  forEachDiagnostic(m.view.state, (_d, from, to) => out.push(m.view.state.sliceDoc(from, to)));
  return out;
}

function cardOf(m: Mounted, expected: string) {
  let found: { diag: Diagnostic; from: number; to: number } | undefined;
  forEachDiagnostic(m.view.state, (diag, from, to) => {
    if (m.view.state.sliceDoc(from, to) === expected) found = { diag, from, to };
  });
  const data = found && problemInfo(found.diag);
  if (!found || !data) throw new Error(`sem sublinhado em ${expected}`);
  return { from: found.from, to: found.to, data };
}

function type(m: Mounted, pos: number, text: string): void {
  m.view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'input.type',
  });
}

const words = (state: EditorState, from = 0, to = state.doc.length) =>
  tokensIn(state, from, to).map((t) => t.word);

/** Uma palavra diferente para cada `n`, só de letras (`pa`, `pb`, … `paa`, …). */
function letters(n: number): string {
  let out = '';
  for (let v = n; ; v = Math.floor(v / 26) - 1) {
    out = String.fromCharCode(97 + (v % 26)) + out;
    if (v < 26) break;
  }
  return `p${out}`;
}

/**
 * O agendador sozinho num view sem DOM, com a área visível que o teste escolhe (o do jsdom mostra só
 * o começo da nota); o motor falso responde na hora.
 */
function headless(doc: string, visible: () => readonly { from: number; to: number }[]) {
  let state = pluginState(doc, spellField);
  const view = {
    get state() {
      return state;
    },
    get visibleRanges() {
      return visible();
    },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
  } as unknown as EditorView;
  const engine = new FakeEngine();
  const clock = new FakeClock();
  const checker = new SpellChecker({
    engine,
    clock,
    language: () => 'pt-BR',
    known: () => false,
    ignored: () => false,
    log: () => undefined,
  });
  const settle = async (ms = 0) => {
    await clock.advance(ms);
    for (let i = 0; i < 10; i++) await flush();
  };
  /** Rolar: o visível de agora é verificado 150 ms depois. */
  const scroll = async () => {
    const update = { view, state, docChanged: false, viewportChanged: true, selectionSet: false };
    checker.update(update as unknown as ViewUpdate);
    await settle(SPELL_TIMING.scrollMs);
  };
  return { view, engine, checker, settle, scroll };
}

describe('tokenizador: as exclusões do LanguageTool (shared/prose.ts)', () => {
  test('pt-BR-check.md: código, URL, destino de link, cerca, matemática e alvo de wikilink ficam de fora', () => {
    const state = pluginState(PT, []);
    expect(words(state)).toEqual([
      'Notas',
      'da',
      'semana',
      'Eu',
      'vai',
      'para',
      'casa',
      'amanhã',
      'código',
      'roda',
      'em',
      'site',
      'sem',
      'erro',
      'Isso',
      'uma',
      'excessão',
      'fórmula',
      'link',
      'apelido',
      'ficam',
      'como',
      'estão',
    ]);
  });

  test('hífen e apóstrofo dentro da palavra; NFD vai em NFC; ’ vai como apóstrofo', () => {
    const nfd = 'excessão'.normalize('NFD');
    const state = pluginState(`Guarda-chuva d’água fazê-lo ${nfd} -fim- 'aspas'\n`, []);
    expect(words(state)).toEqual(['Guarda-chuva', "d'água", 'fazê-lo', 'excessão', 'fim', 'aspas']);
    const token = tokensIn(state, 0, state.doc.length).find((t) => t.word === 'excessão');
    expect(state.sliceDoc(token?.from, token?.to)).toBe(nfd);
  });

  test('fora: uma letra, sigla, colada a dígito/_/@/#, mais de 64 caracteres, front matter', () => {
    const long = 'a'.repeat(65);
    const doc = `---\nlang: pt-BR\ntitulo: ignorado\n---\n\nO é a ONU e o IBGE, abc1 2abc ab_cd _xy eu@mail #tag ${long} casa.\n`;
    expect(words(pluginState(doc, []))).toEqual(['casa']);
  });

  test('code-review r35c NB-2: _ênfase_ e __negrito__ são verificadas; o `_` no próprio texto (snake_case) cola', async () => {
    const state = pluginState('Uma _excessão_ e __outra__ aqui; snake_case e *mais* também.\n', []);
    expect(words(state)).toEqual(['Uma', 'excessão', 'outra', 'aqui', 'mais', 'também']);
    const m = mount('Uma _excessão_ e uma __excessão__.\n');
    await settle(m);
    expect(underlined(m)).toEqual(['excessão', 'excessão']);
  });

  test('recorta pelas linhas pedidas: só as palavras das linhas do trecho', () => {
    const state = pluginState('Primeira linha.\n\nSegunda frase aqui.\n', []);
    const second = state.doc.line(3);
    expect(words(state, second.from, second.to)).toEqual(['Segunda', 'frase', 'aqui']);
  });
});

describe('AC-R35-1: "excessão" sublinhada sem rede, pelo motor offline', () => {
  test('a nota aberta: uma verificação com as palavras únicas, um sublinhado ondulado (spell)', async () => {
    const m = mount(PT);
    await settle(m);
    expect(m.engine.of('check')).toHaveLength(1);
    const sent = m.engine.of('check')[0]?.words ?? [];
    expect(new Set(sent).size).toBe(sent.length);
    expect(sent).toContain('excessão');
    expect(sent).not.toContain('excessao');
    expect(underlined(m)).toEqual(['excessão']);
    const { data } = cardOf(m, 'excessão');
    expect([data.source, data.kind, data.title, data.label]).toEqual([
      'spell',
      'spelling',
      'Ortografia',
      'Ortografia',
    ]);
    expect(data.body).toBe('“excessão” não está no dicionário (Português do Brasil).');
  });

  test('cartão: até 5 trocas, "Ignorar" e "Adicionar ao dicionário"; data-source=spell', async () => {
    const m = mount(PT);
    m.engine.misspelled.set('excessão', [
      'exceção',
      'excesso',
      'a\nb',
      'x\u200By',
      'exceção',
      '',
      '<img/src/onerror=alert(1)>',
    ]);
    await settle(m);
    // A sugestão chega depois da verificação (uma chamada por vez).
    expect(m.engine.calls.map((c) => c.op)).toEqual(['check', 'suggest']);
    const { from, data } = cardOf(m, 'excessão');
    expect(data.actions.map((a) => [a.action, a.label])).toEqual([
      ['replace', 'Trocar por “exceção”'],
      ['replace', 'Trocar por “excesso”'],
      ['ignore', 'Ignorar'],
      ['dictionary', 'Adicionar ao dicionário'],
    ]);
    expect(openProblemCard(m.view, from + 1)).toBe(true);
    const card = document.querySelector<HTMLElement>('[data-testid="problem-card"]');
    expect(card?.dataset.source).toBe('spell');
    expect(card?.textContent).toContain('“excessão” não está no dicionário (Português do Brasil).');
  });

  test('AppSec r35c N4: só palavras viram "Trocar por" — marcação do Markdown/HTML, link e entidade, não', () => {
    const real = ['guarda-chuva', "d'água", 'd’água', 'de mais', 'Exceção'];
    expect(insertable(real)).toEqual(real);
    const markup = [
      '<img/src/onerror=alert(1)>',
      'a>b',
      '[x](y)',
      'x]',
      '**x**',
      '_x_',
      '`x`',
      '# x',
      '#x',
      '&#x202E;',
      'https://x.y',
      'www.x.y',
      'Sr.',
      'a|b',
      '$x$',
      '~~x~~',
      'a\\b',
      'x1',
      ' x',
      'x ',
      'x  y',
      '-x',
      'x-',
    ];
    for (const value of markup) expect(insertable([value]), value).toEqual([]);
  });

  test('aceitar a sugestão corrige num passo de desfazer, com anúncio; desfazer sublinha de novo', async () => {
    const m = mount(PT);
    await settle(m);
    const { from, to, data } = cardOf(m, 'excessão');
    // O cursor na palavra, como quem abre o cartão pelo teclado.
    m.view.dispatch({ selection: { anchor: from + 2 } });
    data.actions[0]?.run(m.view, from, to);
    expect(m.view.state.doc.toString()).toBe(PT.replace('excessão', 'exceção'));
    expect(m.announcements).toContain('Trocado por “exceção”.');
    expect(m.view.state.field(spellField)).toEqual([]);
    undo(m.view);
    expect(m.view.state.doc.toString()).toBe(PT);
    expect(m.view.state.selection.main.head).toBe(from + 2);
    // Desfazer não é digitação: a palavra volta a ser sublinhada com o cursor nela.
    await settle(m, SPELL_TIMING.editMs);
    expect(underlined(m)).toEqual(['excessão']);
    expect(m.engine.of('check')).toHaveLength(1);
  });

  test('a troca não sai se o texto sob o sublinhado já não é o que o motor viu', async () => {
    const m = mount(PT);
    await settle(m);
    const { from, data } = cardOf(m, 'excessão');
    data.actions[0]?.run(m.view, from, from + 3);
    expect(m.view.state.doc.toString()).toBe(PT);
  });
});

describe('agendador (relógio falso)', () => {
  test('rajada de teclas: 0 chamadas durante, 1 verificação 400 ms depois da última', async () => {
    const m = mount('Texto inicial.\n', { anchor: 15 });
    await settle(m);
    const before = m.engine.of('check').length;
    for (const ch of ' palavra nova') {
      type(m, m.view.state.doc.length - 1, ch);
      await settle(m, 100);
    }
    expect(m.engine.of('check').length).toBe(before);
    await settle(m, SPELL_TIMING.editMs - 100);
    expect(m.engine.of('check').length).toBe(before + 1);
  });

  test('cache: palavras já respondidas não vão de novo; recarga do motor esvazia o cache', async () => {
    const m = mount('Isso é uma excessão.\n');
    await settle(m);
    expect(m.engine.of('check')).toHaveLength(1);
    type(m, m.view.state.doc.length, 'Isso é uma excessão.\n');
    await settle(m, SPELL_TIMING.editMs);
    expect(m.engine.of('check')).toHaveLength(1);
    expect(underlined(m)).toEqual(['excessão', 'excessão']);
    // O dicionário mudou e o motor recarregou: a próxima verificação pergunta tudo de novo, mas
    // o sublinhado só volta nela (D-R32-6).
    m.reloaded();
    type(m, m.view.state.doc.length, 'Mais.\n');
    await settle(m, SPELL_TIMING.editMs);
    expect(m.engine.of('check')).toHaveLength(2);
    expect(m.engine.of('check')[1]?.words).toEqual(expect.arrayContaining(['Isso', 'Mais']));
  });

  test('só a área visível (D-R35-4): numa nota longa, só as palavras da tela vão ao motor', async () => {
    const lines = Array.from({ length: 2_000 }, (_, i) => `Linha ${letters(i)} aqui.`);
    const m = mount(`${lines.join('\n')}\n`);
    await settle(m);
    const sent = m.engine.of('check').flatMap((c) => c.words ?? []);
    expect(sent.length).toBeGreaterThan(2);
    expect(sent.length).toBeLessThan(500);
    expect(sent).toContain(letters(0));
    expect(sent).not.toContain(letters(1_999));
  });

  test('20.001 palavras novas: duas verificações (20.000 + 1), nunca duas em voo', async () => {
    const doc = `${Array.from({ length: 20_001 }, (_, i) => letters(i)).join('\n')}\n`;
    const { view, engine, checker, settle } = headless(doc, () => [{ from: 0, to: doc.length }]);
    checker.attach(view);
    await settle();
    expect(engine.of('check').map((c) => c.words?.length)).toEqual([SPELL_LIMITS.maxWords, 1]);
    expect(engine.maxInFlight).toBe(1);
    checker.destroy();
  });

  test('AppSec r35c B1: mais de 50.000 palavras distintas numa linha só — a rodada termina, e rolar não a refaz', async () => {
    // Uma nota hostil: "excessão" e 60.000 palavras distintas numa linha só (`wholeLines` leva a
    // linha inteira); na linha seguinte, 10.000 outras.
    const first = ['excessão', ...Array.from({ length: 60_000 }, (_, i) => letters(i))].join(' ');
    const second = Array.from({ length: 10_000 }, (_, i) => letters(60_000 + i)).join(' ');
    let visible = [{ from: 0, to: 2_000 }];
    const { view, engine, checker, settle, scroll } = headless(
      `${first}\n${second}\n`,
      () => visible,
    );
    const sizes = () => engine.of('check').map((c) => c.words?.length);
    try {
      checker.attach(view);
      await settle();
      // As primeiras 50.000 distintas (o cache inteiro), em 3 pedidos; o resto da linha fica de fora.
      expect(sizes()).toEqual([20_000, 20_000, 10_000]);
      expect(view.state.field(spellField).map((d) => d.word)).toEqual(['excessão']);
      await scroll();
      expect(sizes()).toHaveLength(3);
      // A outra linha passa o cache do teto: saem as 10.000 mais antigas da primeira. De volta, só
      // elas vão de novo, num pedido — as que a rodada já tinha não saem enquanto ela pergunta.
      visible = [{ from: first.length + 1, to: first.length + 2_001 }];
      await scroll();
      expect(sizes()).toEqual([20_000, 20_000, 10_000, 10_000]);
      visible = [{ from: 0, to: 2_000 }];
      await scroll();
      await scroll();
      expect(sizes()).toEqual([20_000, 20_000, 10_000, 10_000, 10_000]);
      expect(view.state.field(spellField).map((d) => d.word)).toEqual(['excessão']);
      expect(engine.maxInFlight).toBe(1);
    } finally {
      checker.destroy();
    }
  }, 60_000);

  test('a palavra que o cursor está escrevendo espera ele sair (150 ms depois)', async () => {
    const m = mount('Começo.\n', { anchor: 7 });
    await settle(m);
    type(m, 7, ' excessão');
    await settle(m, SPELL_TIMING.editMs);
    expect(underlined(m)).toEqual([]);
    expect(m.engine.calls.flatMap((c) => c.words ?? [])).not.toContain('excessão');
    m.view.dispatch({ selection: { anchor: 0 } });
    await settle(m, SPELL_TIMING.scrollMs);
    expect(underlined(m)).toEqual(['excessão']);
  });

  test('uma edição larga em volta do cursor: o sublinhado que já estava sob ele fica', async () => {
    const doc = 'Isso é uma excessão.\n';
    const m = mount(doc);
    await settle(m);
    // Uma transação com duas mudanças (antes e depois da palavra) e o cursor dentro dela.
    m.view.dispatch({
      changes: [
        { from: 0, insert: 'Ah. ' },
        { from: doc.length, insert: 'Fim.\n' },
      ],
      selection: { anchor: 'Ah. Isso é uma exces'.length },
      userEvent: 'input.type',
    });
    await settle(m, SPELL_TIMING.editMs);
    expect(underlined(m)).toEqual(['excessão']);
    expect(m.engine.calls.flatMap((c) => c.words ?? [])).toEqual([
      'Isso',
      'uma',
      'excessão',
      'Ah',
      'Fim',
    ]);
  });

  test('o cursor só parado numa palavra não a segura: ela é verificada (a cobertura chegou depois)', async () => {
    const coverage = new FakeSpellCoverage();
    const m = mount('Isso é uma excessão.\n', { coverage, anchor: 'Isso é uma exces'.length });
    await settle(m);
    expect(m.engine.calls).toEqual([]);
    coverage.set(['pt-BR']);
    await settle(m);
    expect(underlined(m)).toEqual(['excessão']);
  });

  test('CANCELLED (outro pedido venceu): tenta de novo na espera da edição, sem rajada', async () => {
    const m = mount('Isso é uma excessão.\n');
    m.engine.replies.push({ error: 'CANCELLED' }, { error: 'CANCELLED' });
    await settle(m);
    expect(m.engine.of('check')).toHaveLength(1);
    await settle(m, SPELL_TIMING.editMs - 1);
    expect(m.engine.of('check')).toHaveLength(1);
    await settle(m, 1);
    expect(m.engine.of('check')).toHaveLength(2);
    await settle(m, SPELL_TIMING.editMs);
    expect(m.engine.of('check')).toHaveLength(3);
    expect(underlined(m)).toEqual(['excessão']);
  });

  test('TIMEOUT (fila do motor ocupada): nada antes de 2 s, nem com edição; depois verifica', async () => {
    const m = mount('Isso é uma excessão.\n', { anchor: 0 });
    m.engine.replies.push({ error: 'TIMEOUT' });
    await settle(m);
    expect(m.engine.of('check')).toHaveLength(1);
    type(m, 0, 'Sim. ');
    m.view.dispatch({ selection: { anchor: 0 } });
    await settle(m, SPELL_TIMING.editMs);
    expect(m.engine.of('check')).toHaveLength(1);
    await settle(m, SPELL_TIMING.retryMs);
    expect(m.engine.of('check')).toHaveLength(2);
    expect(underlined(m)).toEqual(['excessão']);
  });

  test('sugestões: uma por vez, a mais perto do cursor primeiro; TIMEOUT na sugestão espera', async () => {
    const m = mount('Excessão aqui.\n\nOutra linha com excessão.\n', { anchor: 30 });
    m.engine.replies.push('answer', { error: 'TIMEOUT' });
    await settle(m);
    expect(m.engine.calls.map((c) => [c.op, c.word ?? null])).toEqual([
      ['check', null],
      ['suggest', 'excessão'],
    ]);
    await settle(m, SPELL_TIMING.retryMs);
    expect(m.engine.calls.map((c) => [c.op, c.word ?? null])).toEqual([
      ['check', null],
      ['suggest', 'excessão'],
      ['suggest', 'excessão'],
      ['suggest', 'Excessão'],
    ]);
    expect(m.engine.maxInFlight).toBe(1);
    expect(cardOf(m, 'Excessão').data.actions[0]?.label).toBe('Trocar por “Exceção”');
  });

  test('desligar com a verificação em voo: check([]) cancela no motor; nada mais roda', async () => {
    const m = mount('Isso é uma excessão.\n');
    m.engine.replies.push('hang');
    await settle(m);
    expect(m.engine.inFlight).toBe(1);
    m.dispose();
    mounted = mounted.filter((x) => x !== m);
    await settle(m, 10_000);
    expect(m.engine.of('check').map((c) => c.words?.length)).toEqual([3, 0]);
    expect(m.engine.inFlight).toBe(0);
    expect(m.clock.pending()).toBe(0);
  });
});

describe('ignorar, adicionar e o dicionário do usuário', () => {
  test('Ignorar: some em todo lugar, novas ocorrências não sublinham; o registro guarda na sessão', async () => {
    const m = mount('Isso é uma excessão.\n\nOutra excessão.\n');
    await settle(m);
    expect(underlined(m)).toEqual(['excessão', 'excessão']);
    const { from, to, data } = cardOf(m, 'excessão');
    data.actions.find((a) => a.action === 'ignore')?.run(m.view, from, to);
    await settle(m);
    expect(underlined(m)).toEqual([]);
    expect([...m.ignored]).toEqual(['excessão']);
    expect(m.announcements).toContain('“excessão” ignorada nesta sessão.');
    type(m, m.view.state.doc.length, '\nMais uma excessão.\n');
    m.view.dispatch({ selection: { anchor: 0 } });
    await settle(m, SPELL_TIMING.editMs);
    expect(underlined(m)).toEqual([]);
    // Outra ativação na mesma sessão (o registro entrega o mesmo conjunto): continua escondida.
    const again = mount('Isso é uma excessão.\n', { ignored: m.ignored });
    await settle(again);
    expect(underlined(again)).toEqual([]);
  });

  test('Adicionar ao dicionário: grava na camada da opção e o sublinhado sai depois de gravado', async () => {
    const m = mount('Isso é uma excessão.\n');
    m.options.set('addTo', 'folder');
    await settle(m);
    const { from, to, data } = cardOf(m, 'excessão');
    data.actions.find((a) => a.action === 'dictionary')?.run(m.view, from, to);
    await settle(m);
    expect(m.dictionary.calls).toEqual([{ op: 'add', layer: 'folder', words: ['excessão'] }]);
    expect(underlined(m)).toEqual([]);
    expect(m.announcements).toContain('“excessão” adicionada ao dicionário desta pasta.');
  });

  test('Adicionar que não grava: o sublinhado fica e o aviso diz por quê', async () => {
    const m = mount('Isso é uma excessão.\n');
    await settle(m);
    m.dictionary.failNext({ status: 'full' });
    const { from, to, data } = cardOf(m, 'excessão');
    data.actions.find((a) => a.action === 'dictionary')?.run(m.view, from, to);
    await settle(m);
    expect(underlined(m)).toEqual(['excessão']);
    expect(m.notices).toEqual([
      {
        text: 'o dicionário deste computador chegou ao limite (200.000 palavras ou 10 MiB no pessoal.txt).',
        level: 'warn',
      },
    ]);
  });

  test('o dicionário do usuário muda por fora: o sublinhado sai sem nova verificação', async () => {
    const m = mount('Isso é uma excessão.\n');
    await settle(m);
    const checks = m.engine.calls.length;
    m.dictionary.put('global', ['excessão']);
    await settle(m);
    expect(underlined(m)).toEqual([]);
    expect(m.engine.calls.length).toBe(checks);
  });
});

describe('língua da nota (cobertura, lang: e D-R35B-01)', () => {
  test('sem cobertura (motor não recarregado ou desligado): nada vai ao motor', async () => {
    const m = mount(PT, { coverage: new FakeSpellCoverage() });
    await settle(m, 5_000);
    expect(m.engine.calls).toEqual([]);
    expect(underlined(m)).toEqual([]);
    m.coverage.set(['pt-BR']);
    await settle(m);
    expect(underlined(m)).toEqual(['excessão']);
    m.coverage.set([]);
    await settle(m);
    expect(underlined(m)).toEqual([]);
  });

  test('lang: en-US → nada; trocar o lang: para pt-BR verifica, e de volta tira', async () => {
    const doc = '---\nlang: en-US\n---\n\nIsso é uma excessão.\n';
    const m = mount(doc, { anchor: doc.length });
    await settle(m, 1_000);
    expect(m.engine.calls).toEqual([]);
    const at = doc.indexOf('en-US');
    m.view.dispatch({ changes: { from: at, to: at + 5, insert: 'pt-BR' } });
    await settle(m, SPELL_TIMING.editMs);
    expect(underlined(m)).toEqual(['excessão']);
    m.view.dispatch({ changes: { from: at, to: at + 5, insert: 'en-US' } });
    await settle(m, SPELL_TIMING.editMs);
    expect(underlined(m)).toEqual([]);
  });

  test('D-R35B-01: com o LanguageTool ligado em inglês, a nota sem lang: fica com ele; com lang: pt-BR, conosco', async () => {
    const m = mount('Isso é uma excessão.\n', { noteLanguage: 'en-US' });
    await settle(m, 1_000);
    expect(m.engine.calls).toEqual([]);
    m.setNoteLanguage('pt-BR');
    await settle(m);
    expect(underlined(m)).toEqual(['excessão']);
    m.setNoteLanguage('en-US');
    await settle(m);
    expect(underlined(m)).toEqual([]);
    const pt = mount('---\nlang: pt-BR\n---\n\nIsso é uma excessão.\n', { noteLanguage: 'en-US' });
    await settle(pt);
    expect(underlined(pt)).toEqual(['excessão']);
  });
});

describe('code-review r35a N3: o plugin só verifica e sugere (ESLint em spell/**)', () => {
  const ROOT = join(__dirname, '../../..');
  const eslint = new ESLint({ cwd: ROOT });
  const errors = async (code: string) => {
    const [result] = await eslint.lintText(code, {
      filePath: join(ROOT, 'packages/plugins-internal/src/spell/probe.ts'),
    });
    return (result?.messages ?? [])
      .filter((m) => m.ruleId === 'no-restricted-syntax')
      .map((m) => m.line);
  };

  test('tipos com recarga ou escrita, `.reload` e `{ reload }` reprovam; os de leitura passam', async () => {
    const banned = [
      "import type { SpellTransport } from '@simplemd/plugin-api/internal/spell';",
      "import { type SpellCoverageSlot } from '@simplemd/plugin-api/internal/spell';",
      "export type { SpellReloaded } from '@simplemd/plugin-api/internal/spell';",
      'export const a = (e: { reload(): void }) => e.reload();',
      'export const b = ({ reload }: { reload(): void }) => reload;',
      '',
    ].join('\n');
    expect(await errors(banned)).toEqual([1, 2, 3, 4, 5]);
    const allowed = [
      "import type { SpellCoverage, SpellErrorCode } from '@simplemd/plugin-api/internal/spell';",
      'export const c = (x: SpellCoverage, y: SpellErrorCode) => [x, y];',
      '',
    ].join('\n');
    expect(await errors(allowed)).toEqual([]);
  }, 30_000);

  test('code-review r35c NB-4 / AppSec r35c N1: também por índice, Reflect, a string, namespace, export * e import(); eslint-disable não vale', async () => {
    const banned = [
      "import type * as S from '@simplemd/plugin-api/internal/spell';",
      "export * from '@simplemd/plugin-api/internal/spell';",
      "export type T = import('@simplemd/plugin-api/internal/spell').SpellTransport;",
      "export const d = (t: Record<string, () => void>) => t['reload'];",
      "export const e = ({ ['reload']: r }: Record<string, () => void>) => r;",
      "export const f = (t: object) => Reflect.get(t, 'reload');",
      'export const g = (t: Record<string, () => void>) => t[`reload`];',
      '// eslint-disable-next-line no-restricted-syntax',
      'export const h = (t: { reload(): void }) => t.reload();',
      '',
    ].join('\n');
    expect(await errors(banned)).toEqual([1, 2, 3, 4, 5, 6, 7, 9]);
  }, 30_000);
});
