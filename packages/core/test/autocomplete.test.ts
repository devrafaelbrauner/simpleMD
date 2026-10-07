// @vitest-environment jsdom
import {
  CompletionContext,
  completionStatus,
  currentCompletions,
  startCompletion,
  type Completion,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { ensureSyntaxTree, syntaxTreeAvailable } from '@codemirror/language';
import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';
import { COMPLETION_TYPING_DELAY_MS } from '../src/assembly/host';
import {
  appCompletionSources,
  clampMinChars,
  DEFAULT_AUTOCOMPLETE,
  documentWords,
  EditorHost,
  EMPTY_CONTRIBUTIONS,
  normalizeAutocomplete,
  noteLinkTarget,
  type AutocompleteSettings,
  type NoteRef,
  wordIndexField,
} from '../src';

const NOTES: NoteRef[] = [
  { path: 'Receitas/bolo.md', title: 'Bolo de fubá' },
  { path: 'diario/hoje.md', title: 'hoje' },
];
const deps = (notes: readonly NoteRef[] = NOTES) => ({
  notes: () => notes,
  today: () => '2026-10-07',
});

/**
 * Estado com a árvore COMPLETA (R5-02, o mesmo padrão de `b533ba5`/`previewState`): o estado criado
 * guarda a árvore parcial do orçamento de ~20 ms; `ensureSyntaxTree` termina o parse e a transação
 * seguinte o publica em `syntaxTree(state)`. Antes, o parse vinha depois da transação e era
 * ignorado: sob carga, um bloco de código ainda fora da árvore entrava nas sugestões.
 */
function stateOf(doc: string, cursor = doc.length) {
  const base = new EditorHost().createState(doc);
  if (!ensureSyntaxTree(base, base.doc.length, 5000)) throw new Error('parse incompleto');
  const state = base.update({ selection: { anchor: cursor } }).state;
  if (!syntaxTreeAvailable(state, state.doc.length)) throw new Error('árvore parcial publicada');
  return state;
}

async function run(
  source: CompletionSource,
  state: EditorState,
  explicit = false,
): Promise<CompletionResult | null> {
  return source(new CompletionContext(state, state.selection.main.head, explicit));
}

function sources(settings: Partial<AutocompleteSettings> = {}, notes?: readonly NoteRef[]) {
  const [words, snippets, notesSource] = appCompletionSources(
    { ...DEFAULT_AUTOCOMPLETE, ...settings },
    deps(notes),
  );
  return { words: words!, snippets: snippets!, notes: notesSource! };
}

/** Aplica a opção num EditorView real (como o Enter faria). */
function accept(state: EditorState, result: CompletionResult, option: Completion) {
  const parent = document.createElement('div');
  const view = new EditorView({ state, parent });
  const apply = option.apply;
  if (typeof apply === 'function') apply(view, option, result.from, state.selection.main.head);
  else
    view.dispatch({
      changes: { from: result.from, to: state.selection.main.head, insert: apply ?? option.label },
    });
  const out = { doc: view.state.doc.toString(), sel: view.state.selection.main };
  view.destroy();
  return out;
}

describe('AC-8.1 configurações', () => {
  it('padrões = JSON do R-8.2; minChars limitado; prefixo inválido mantém o anterior', () => {
    expect(DEFAULT_AUTOCOMPLETE).toEqual({
      enabled: true,
      mode: 'auto',
      minChars: 3,
      sources: { words: true, snippets: true, notes: true },
      snippetPrefix: '/',
    });
    expect(clampMinChars(1)).toBe(2);
    expect(clampMinChars(9)).toBe(5);
    expect(normalizeAutocomplete({ minChars: 1 }).settings.minChars).toBe(2);
    expect(normalizeAutocomplete({ minChars: 9 }).settings.minChars).toBe(5);
    const previous = { ...DEFAULT_AUTOCOMPLETE, snippetPrefix: ';' as const };
    const bad = normalizeAutocomplete({ snippetPrefix: 'x' }, previous);
    expect(bad.settings.snippetPrefix).toBe(';');
    expect(bad.warnings.map((w) => w.field)).toEqual(['autocomplete.snippetPrefix']);
    const mixed = normalizeAutocomplete({
      enabled: 'sim',
      mode: 'x',
      minChars: 'a',
      sources: { words: false, notes: 2 },
      extra: 1,
    });
    expect(mixed.settings).toMatchObject({ enabled: true, mode: 'auto', minChars: 3 });
    expect(mixed.settings.sources).toEqual({ words: false, snippets: true, notes: true });
    expect(mixed.warnings).toHaveLength(4);
    expect(normalizeAutocomplete([]).warnings).toHaveLength(1);
    expect(normalizeAutocomplete(undefined).warnings).toEqual([]);
    expect(normalizeAutocomplete({ sources: 3 }).warnings).toHaveLength(1);
  });
});

describe('AC-8.2 palavras do documento', () => {
  it('R5-02: com o orçamento do parse inicial esgotado, stateOf ainda publica a árvore completa', async () => {
    // Máquina lenta: cada leitura do relógio avança 50 ms, então o parse da criação para cedo.
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 50));
    const doc = `${'linha comum\n'.repeat(2000)}\n\`\`\`\nparafuso\n\`\`\`\n\npar`;
    try {
      expect(syntaxTreeAvailable(new EditorHost().createState(doc), doc.length)).toBe(false);
      const state = stateOf(doc);
      expect(syntaxTreeAvailable(state, state.doc.length)).toBe(true);
      clock.mockRestore();
      const labels = (await run(sources().words, state, true))?.options.map((o) => o.label) ?? [];
      expect(labels).not.toContain('parafuso');
    } finally {
      clock.mockRestore();
    }
  });

  it('acento mantido, ≥ 3 letras, palavra digitada excluída, sem código, ≤ 50 opções', async () => {
    const doc =
      'paralelepípedo e paralelepípedo no paralelo.\n\n```\nparafuso\n```\n\nPar `parque` ab\n\npar';
    const result = await run(sources().words, stateOf(doc));
    const labels = result?.options.map((o) => o.label);
    expect(labels?.[0]).toBe('paralelepípedo');
    expect(labels).toContain('paralelo');
    expect(labels).not.toContain('parafuso');
    expect(labels).not.toContain('parque');
    expect(labels).not.toContain('par');
    expect(labels).not.toContain('ab');
    const many = Array.from(
      { length: 80 },
      (_, i) =>
        `palavra${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`,
    ).join(' ');
    const big = await run(sources().words, stateOf(`${many}\npal`));
    expect(big?.options.length).toBe(50);
  });

  it('minChars no modo ao digitar; o atalho ignora o mínimo', async () => {
    const state = stateOf('paralelepípedo\npa');
    expect(await run(sources().words, state)).toBeNull();
    expect((await run(sources().words, state, true))?.options[0]?.label).toBe('paralelepípedo');
    expect((await run(sources({ minChars: 2 }).words, state))?.options[0]?.label).toBe(
      'paralelepípedo',
    );
  });

  it('AC-9.11 metade das sugestões: palavras do front matter não entram', async () => {
    const doc = '---\ntitle: frontmatterpalavra\n---\nfro';
    const result = await run(sources().words, stateOf(doc), true);
    expect(result?.options.map((o) => o.label) ?? []).not.toContain('frontmatterpalavra');
  });

  it('índice por blocos: edição longe recontada só no bloco sujo', async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `linha numero ${i} sobre carambola`);
    let state = stateOf(lines.join('\n'));
    state = state.update({
      changes: { from: state.doc.length, insert: '\ncarambolada car' },
      selection: { anchor: state.doc.length + '\ncarambolada car'.length },
    }).state;
    ensureSyntaxTree(state, state.doc.length, 5000);
    const result = await run(sources().words, state);
    expect(result?.options.map((o) => o.label).slice(0, 2)).toEqual(['carambola', 'carambolada']);
  });

  it('CR2-08: bloco contado com a árvore parcial não fica no cache (código abaixo da janela)', async () => {
    const filler = Array.from({ length: 3000 }, (_, i) => `linha comum de texto ${i}`).join('\n');
    const doc = `${filler}\n\n\`\`\`\nsegredocodigo\n\`\`\`\n\nseg`;
    // O campo do índice de palavras é o que o editor monta com o autocompletar ligado.
    const partial = new EditorHost().createState(doc).update({
      selection: { anchor: doc.length },
      effects: StateEffect.appendConfig.of(wordIndexField),
    }).state;
    // Nota grande recém-aberta: a análise inicial ainda não chegou ao fim do documento.
    expect(syntaxTreeAvailable(partial, partial.doc.length)).toBe(false);
    expect(partial.field(wordIndexField, false)).toBeDefined();
    // Contada agora, a palavra do código ainda não reconhecido aparece (árvore parcial)…
    expect(documentWords(partial).has('segredocodigo')).toBe(true);
    ensureSyntaxTree(partial, partial.doc.length, 5000);
    // Transação sem mudança de texto: a árvore completa entra no estado; o índice é o mesmo.
    const parsed = partial.update({ selection: { anchor: doc.length } }).state;
    expect(syntaxTreeAvailable(parsed, parsed.doc.length)).toBe(true);
    expect(documentWords(parsed).has('segredocodigo')).toBe(false);
    const labels = (await run(sources().words, parsed, true))?.options.map((o) => o.label) ?? [];
    expect(labels).not.toContain('segredocodigo');
  });
});

describe('AC-8.3 snippets', () => {
  it('/tab no início da linha oferece "tabela"; aceitar insere a tabela com o primeiro campo selecionado', async () => {
    const state = stateOf('texto\n/tab');
    const result = await run(sources().snippets, state);
    const tabela = result?.options.find((o) => o.label === 'tabela');
    expect(tabela?.detail).toBe('Tabela 3×2');
    const out = accept(state, result!, tabela!);
    expect(out.doc).toBe(
      'texto\n| Coluna 1 | Coluna 2 | Coluna 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n',
    );
    expect(out.doc.slice(out.sel.from, out.sel.to)).toBe('Coluna 1');
  });

  it('prefixo só no início da linha ou depois de espaço; frontmatter só na linha 1 sem front matter', async () => {
    expect(await run(sources().snippets, stateOf('a/tab'))).toBeNull();
    expect(await run(sources().snippets, stateOf('a ;tab'))).toBeNull();
    expect(
      (await run(sources({ snippetPrefix: ';' }).snippets, stateOf('a ;ta')))?.options.length,
    ).toBe(9);
    const first = await run(sources().snippets, stateOf('/front'));
    expect(first?.options.map((o) => o.label)).toContain('frontmatter');
    const second = await run(sources().snippets, stateOf('x\n/front'));
    expect(second?.options.map((o) => o.label)).not.toContain('frontmatter');
    const withFm = await run(sources().snippets, stateOf('---\na: 1\n---\n/f'));
    expect(withFm?.options.map((o) => o.label)).not.toContain('frontmatter');
    const data = first!.options.find((o) => o.label === 'data')!;
    expect(accept(stateOf('/data'), first!, data).doc).toBe('2026-10-07');
    const fm = first!.options.find((o) => o.label === 'frontmatter')!;
    const out = accept(stateOf('/front'), first!, fm);
    expect(out.doc).toBe('---\ntitle: \n---\n');
    expect(out.sel.head).toBe('---\ntitle: '.length);
  });
});

describe('AC-8.4 notas [[', () => {
  it('título com o caminho; sem acento; [[bolo]] único; caminho quando repetido; ]] não dobra', async () => {
    const state = stateOf('Veja [[bol');
    const result = await run(sources().notes, state);
    expect(result?.options.map((o) => [o.label, o.detail])).toEqual([
      ['Bolo de fubá', 'Receitas/bolo.md'],
    ]);
    expect(accept(state, result!, result!.options[0]!).doc).toBe('Veja [[bolo]]');
    expect((await run(sources().notes, stateOf('[[fuba')))?.options[0]?.label).toBe('Bolo de fubá');
    const dup = [...NOTES, { path: 'outra/bolo.md', title: 'Outro bolo' }];
    expect(noteLinkTarget('Receitas/bolo.md', dup)).toBe('Receitas/bolo');
    const closed = stateOf('[[bol]]', 5);
    const r2 = await run(sources({}, dup).notes, closed);
    const bolo = r2!.options.find((o) => o.detail === 'Receitas/bolo.md')!;
    expect(accept(closed, r2!, bolo).doc).toBe('[[Receitas/bolo]]');
    expect(await run(sources().notes, stateOf('[[zzz'))).toBeNull();
    expect(await run(sources().notes, stateOf('sem colchetes'))).toBeNull();
  });
});

describe('F-R2-02: trecho casado marcado (DESIGN §8.17, A-23) também com filter: false', () => {
  it('palavras e notas informam getMatch sem diferenciar acento nem caixa', async () => {
    const words = await run(sources().words, stateOf('paralelepípedo parágrafo\n\nPAR'));
    const ranges = Object.fromEntries(words!.options.map((o) => [o.label, words!.getMatch?.(o)]));
    expect(ranges).toEqual({ paralelepípedo: [0, 3], parágrafo: [0, 3] });
    // Trecho no meio, atravessando a letra acentuada ("ágr" ← "agr").
    const mid = await run(sources().words, stateOf('parágrafo\n\nagr', 14), true);
    expect(mid!.getMatch?.(mid!.options[0]!)).toEqual([3, 6]);

    const notes = await run(sources().notes, stateOf('Veja [[fuba'));
    const [bolo] = notes!.options;
    expect(bolo!.label.slice(...(notes!.getMatch?.(bolo!) as [number, number]))).toBe('fubá');
    // Casou só pelo caminho: nada a marcar no título.
    const byPath = await run(sources().notes, stateOf('[[receitas'));
    expect(byPath!.getMatch?.(byPath!.options[0]!)).toEqual([]);
  });
});

describe('PERF-R2-02 / PERF-R5-01 / NFR-24: popup na tarefa seguinte à tecla', () => {
  it('sem espera ao digitar; teclas da mesma rajada viram uma consulta só', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // 100 ms (padrão) e 20 ms (antes) custavam quadros a mais no NFR-24 (PERF-R5-01).
      expect(COMPLETION_TYPING_DELAY_MS).toBe(0);
      const words = sources().words;
      const source = vi.fn<CompletionSource>((context) => words(context));
      const host = new EditorHost({
        ...EMPTY_CONTRIBUTIONS,
        completion: { enabled: true, activateOnTyping: true, sources: [source] },
      });
      const view = new EditorView({
        state: host.createState('paralelepípedo\n'),
        parent: document.createElement('div'),
      });
      for (const char of 'par') {
        const at = view.state.doc.length;
        view.dispatch({
          changes: { from: at, insert: char },
          selection: { anchor: at + 1 },
          userEvent: 'input.type',
        });
      }
      // Na mesma tarefa das teclas, nenhuma consulta ainda.
      expect(source).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(0);
      expect(source).toHaveBeenCalledTimes(1);
      expect(completionStatus(view.state)).toBe('active');
      expect(currentCompletions(view.state).map((o) => o.label)).toEqual(['paralelepípedo']);
      view.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('R4-02 / arch-ux F16: Enter logo depois de digitar quebra a linha; só aceita depois de ↓', () => {
  const enter = (view: EditorView) =>
    runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'Enter' }), 'editor');
  const down = (view: EditorView) =>
    runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'ArrowDown' }), 'editor');

  /** Digita `word` a cada `gapMs` no fim da nota, com o host e a fonte de palavras do app. */
  async function typed(word: string, gapMs: number): Promise<EditorView> {
    const host = new EditorHost({
      ...EMPTY_CONTRIBUTIONS,
      completion: { enabled: true, activateOnTyping: true, sources: [sources().words] },
    });
    const view = new EditorView({
      state: host.createState('parabéns paralelepípedo\n'),
      parent: document.createElement('div'),
    });
    for (const [i, char] of [...word].entries()) {
      if (i > 0) await vi.advanceTimersByTimeAsync(gapMs);
      const at = view.state.doc.length;
      view.dispatch({
        changes: { from: at, insert: char },
        selection: { anchor: at + 1 },
        userEvent: 'input.type',
      });
    }
    return view;
  }

  // A sequência da revisão de 00e71df: 80 ms por tecla, Enter 50–174 ms depois da última.
  it.each([50, 150, 174])('"para" a 80 ms/tecla + Enter %d ms depois → "para\\n"', async (wait) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const view = await typed('para', 80);
      await vi.advanceTimersByTimeAsync(wait);
      expect(completionStatus(view.state)).toBe('active');
      enter(view);
      expect(view.state.doc.toString()).toBe('parabéns paralelepípedo\npara\n');
      view.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('↓ escolhe a primeira opção e Enter a insere (F16 passo 1)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const view = await typed('para', 80);
      await vi.advanceTimersByTimeAsync(200);
      expect(down(view)).toBe(true);
      expect(enter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('parabéns paralelepípedo\nparabéns');
      view.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AC-8.5/AC-6.13 desligado = compartimento vazio (0 popups, 0 chamadas às fontes)', () => {
  it('com as fontes do plugin e do app, desligado não chama ninguém; Tab nunca é ligado', async () => {
    const plugin = vi.fn<CompletionSource>((ctx) => ({
      from: ctx.pos - 3,
      options: [{ label: 'paralelo' }],
    }));
    const host = new EditorHost({
      ...EMPTY_CONTRIBUTIONS,
      completion: { enabled: false, activateOnTyping: true, sources: [plugin, sources().words] },
    });
    const parent = document.createElement('div');
    const view = new EditorView({ state: host.createState('paralelo\npar'), parent });
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(startCompletion(view)).toBe(false);
    expect(completionStatus(view.state)).toBeNull();
    expect(plugin).not.toHaveBeenCalled();

    view.dispatch({
      effects: host.update({
        completion: { enabled: true, activateOnTyping: false, sources: [plugin] },
      }),
    });
    expect(startCompletion(view)).toBe(true);
    await vi.waitFor(() => expect(currentCompletions(view.state).length).toBe(1));
    expect(plugin).toHaveBeenCalled();
    // Nenhuma ligação de Tab no editor principal (UX-D7).
    const bindings = view.state.facet(keymap).flat();
    expect(bindings.some((b) => b.key === 'Tab')).toBe(false);
    view.destroy();
  });
});
