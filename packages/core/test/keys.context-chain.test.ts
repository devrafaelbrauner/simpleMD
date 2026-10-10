// @vitest-environment jsdom
import {
  completionStatus,
  currentCompletions,
  moveCompletionSelection,
  startCompletion,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  contextAction,
  EditorHost,
  EMPTY_CONTRIBUTIONS,
  escapeHandler,
  interactFacet,
  noteContext,
  runContextChain,
  runInteract,
} from '../src';

/** r7 ST — cadeia de contexto (arch-frontend §4.4), fallback de lista, árbitro do Escape, ordem. */
const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
  vi.restoreAllMocks();
});

function mount(
  doc: string,
  anchor: number,
  opts: { captureTab?: boolean; plugins?: Extension[]; sources?: CompletionSource[] } = {},
) {
  const host = new EditorHost({
    ...EMPTY_CONTRIBUTIONS,
    captureTab: opts.captureTab ?? false,
    pluginExtensions: opts.plugins ?? [],
    completion: { enabled: true, activateOnTyping: false, sources: opts.sources ?? [] },
  });
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new EditorView({ state: host.createState(doc, { notePath: 'a/b.md' }), parent });
  view.dispatch({ selection: { anchor } });
  views.push(view);
  return view;
}

function press(view: EditorView, key: string, mods: KeyboardEventInit = {}) {
  return runScopeHandlers(
    view,
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }),
    'editor',
  );
}

describe('ordem da cadeia', () => {
  test('slot > prioridade > ordem de configuração; o primeiro que aceita encerra', () => {
    const calls: string[] = [];
    const action = (name: string, accept: boolean) => () => (calls.push(name), accept);
    const view = mount('x', 0, {
      plugins: [
        contextAction('list', { priority: 10, kinds: ['tab'], run: action('outliner', false) }),
        contextAction('snippet', { kinds: ['tab', 'move'], run: action('snippet', false) }),
        contextAction('list', { priority: 20, kinds: ['indent'], run: action('só-indent', true) }),
      ],
    });
    expect(runContextChain(view, 1, 'tab')).toBe(true);
    // snippet (400) → outliner (lista 10) → fallback do núcleo (lista 0) aceita fora de lista? não:
    // fora de lista ele devolve false e a etapa final (indent 100) insere a unidade.
    expect(calls).toEqual(['snippet', 'outliner']);
    expect(view.state.doc.toString()).toBe('  x');
  });

  test('o noteContext carrega o caminho da aba', () => {
    expect(mount('', 0).state.facet(noteContext).path).toBe('a/b.md');
  });
});

describe('fallback de lista (MELHORIAS l.23)', () => {
  test('Mod-] (sempre ativo) aninha o item com os subitens sob o irmão anterior; Mod-[ desfaz', () => {
    const doc = '- a\n- b\n  - c\n- d';
    const view = mount(doc, doc.indexOf('b') + 1);
    expect(press(view, ']', { ctrlKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe('- a\n  - b\n    - c\n- d');
    expect(press(view, '[', { ctrlKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
  });

  test('Tab (chave ligada) no primeiro item não insere tabulação nem muda o texto', () => {
    const view = mount('- a\n- b', 2, { captureTab: true });
    expect(press(view, 'Tab')).toBe(true);
    expect(view.state.doc.toString()).toBe('- a\n- b');
  });

  test('fora de lista Mod-] mantém o indentMore do CodeMirror', () => {
    const view = mount('texto', 2);
    expect(press(view, ']', { ctrlKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe('  texto');
  });

  test('Mod-Alt-→ sem paradas nem tabela não faz nada (cai para o navegador)', () => {
    const view = mount('x', 0);
    expect(press(view, 'ArrowRight', { ctrlKey: true, altKey: true })).toBe(false);
  });
});

describe('popup do autocompletar', () => {
  const source: CompletionSource = (ctx) => ({
    from: ctx.pos - 3,
    options: [{ label: 'paralelo' }],
  });

  test('chave ligada: Tab fecha o popup SEM aceitar e segue a cadeia', async () => {
    const view = mount('par', 3, { captureTab: true, sources: [source] });
    startCompletion(view);
    await vi.waitFor(() => expect(currentCompletions(view.state).length).toBe(1));
    moveCompletionSelection(true)(view);
    expect(press(view, 'Tab')).toBe(true);
    expect(completionStatus(view.state)).toBeNull();
    expect(view.state.doc.toString()).toBe('par  ');
  });

  test('C-R7-F10: com #completion antes de #plugins, o Enter do popup vence um Enter Prec.highest de plugin', async () => {
    const pluginEnter = vi.fn(() => true);
    const view = mount('par', 3, {
      sources: [source],
      plugins: [Prec.highest(keymap.of([{ key: 'Enter', run: pluginEnter }]))],
    });
    startCompletion(view);
    await vi.waitFor(() => expect(currentCompletions(view.state).length).toBe(1));
    // `moveCompletionSelection`/`acceptCompletion` ignoram teclas nos primeiros 75 ms do popup
    // (`interactionDelay` do CM).
    const later = Date.now() + 1_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    moveCompletionSelection(true)(view);
    expect(press(view, 'Enter')).toBe(true);
    expect(view.state.doc.toString()).toBe('paralelo');
    expect(pluginEnter).not.toHaveBeenCalled();
  });
});

describe('árbitro do Escape e interação (DA-R7-14, DA-R7-27)', () => {
  function esc(view: EditorView) {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event);
    return event;
  }

  test('ordem W2 → paradas antes de um keydown Prec.highest de plugin (Vim)', () => {
    const calls: string[] = [];
    const vim = Prec.highest(
      EditorView.domEventHandlers({ keydown: () => (calls.push('vim'), true) }),
    );
    const view = mount('x', 0, {
      plugins: [
        vim,
        escapeHandler('snippet', () => (calls.push('snippet'), false)),
        escapeHandler('card', () => (calls.push('card'), true)),
      ],
    });
    expect(esc(view).defaultPrevented).toBe(true);
    expect(calls).toEqual(['card']);
  });

  test('sem dono que aceite, o Escape segue para o Vim', () => {
    const vim = vi.fn(() => true);
    const view = mount('x', 0, {
      plugins: [
        Prec.highest(EditorView.domEventHandlers({ keydown: vim })),
        escapeHandler('card', () => false),
      ],
    });
    esc(view);
    expect(vim).toHaveBeenCalledTimes(1);
  });

  test('runInteract tenta os alvos por ordem crescente na cabeça da seleção', () => {
    const seen: string[] = [];
    const view = mount('abc', 2, {
      plugins: [
        interactFacet.of({ order: 20, run: (_v, pos) => (seen.push(`w3@${pos}`), true) }),
        interactFacet.of({ order: 10, run: () => (seen.push('w2'), false) }),
      ],
    });
    expect(runInteract(view)).toBe(true);
    expect(seen).toEqual(['w2', 'w3@2']);
    expect(runInteract(mount('', 0))).toBe(false);
  });
});
