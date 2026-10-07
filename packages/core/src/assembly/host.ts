import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  moveCompletionSelection,
  startCompletion,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { defaultKeymap, historyKeymap } from '@codemirror/commands';
import {
  Compartment,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
} from '@codemirror/state';
import { EditorView, keymap, type KeyBinding } from '@codemirror/view';
import { wordIndexField } from '../autocomplete/sources';
import { createMarkdownExtensions, type MarkdownExtensionsOptions } from '../markdown';

/**
 * Sugestões do editor principal (R-8.2, R-8.7, R-6.12): o interruptor global, o modo e as fontes
 * (as do app ligadas nas configurações + as dos plugins). Desligado = compartimento vazio.
 */
export interface CompletionRuntime {
  readonly enabled: boolean;
  /** `true` = "Ao digitar"; `false` = "Só pelo atalho" (R-8.6). */
  readonly activateOnTyping: boolean;
  readonly sources: readonly CompletionSource[];
}

export interface EditorContributions {
  /** Extensões `source` dos plugins, na ordem de carga (internos, depois externos por id). */
  readonly pluginExtensions: readonly Extension[];
  readonly completion: CompletionRuntime;
  /** Atalhos de plugin no escopo `simplemd-global` (rodados pela janela, nunca pelo editor). */
  readonly globalBindings: readonly KeyBinding[];
  /** Recebe exceções de extensões (`EditorView.exceptionSink`); atribuição no host de plugins. */
  readonly exceptionSink: ((error: unknown) => void) | null;
}

export const EMPTY_CONTRIBUTIONS: EditorContributions = {
  pluginExtensions: [],
  completion: { enabled: true, activateOnTyping: true, sources: [] },
  globalBindings: [],
  exceptionSink: null,
};

/**
 * Teclas ligadas no editor principal pelos keymaps padrão e de histórico do CodeMirror: entram no
 * conjunto de conflito dos atalhos de plugin (arch-ux r2 CF-R2-2: um plugin nunca rouba o desfazer).
 */
export const EDITOR_KEY_BINDINGS: readonly KeyBinding[] = [...defaultKeymap, ...historyKeymap];

/**
 * Teclas do popup (UX-R2-D14): `Ctrl-Space` (e `Mod-Shift-Space` no macOS) abre; setas e
 * PageUp/PageDown movem; Enter aceita (sem popup, Enter faz a quebra de linha); Esc fecha. Tab
 * nunca é ligado (UX-D7).
 */
const completionKeys: readonly KeyBinding[] = [
  { key: 'Ctrl-Space', run: startCompletion },
  { mac: 'Mod-Shift-Space', run: startCompletion },
  { key: 'ArrowDown', run: moveCompletionSelection(true) },
  { key: 'ArrowUp', run: moveCompletionSelection(false) },
  { key: 'PageDown', run: moveCompletionSelection(true, 'page') },
  { key: 'PageUp', run: moveCompletionSelection(false, 'page') },
  { key: 'Enter', run: acceptCompletion },
  { key: 'Escape', run: closeCompletion },
];

/**
 * Espera antes de consultar as fontes ao digitar (PERF-R2-02). O padrão do CodeMirror (100 ms)
 * sozinho já estoura o NFR-24 (popup em ≤ 50 ms para palavras e snippets): o primeiro popup chegava
 * em 106–124 ms. 20 ms ainda juntam as teclas de uma digitação rápida numa só consulta, e o
 * refiltro com o popup aberto não depende disso (7–11 ms medidos).
 */
export const COMPLETION_TYPING_DELAY_MS = 20;

function completionExtension(completion: CompletionRuntime): Extension {
  // Desligado ou sem fontes: nenhuma extensão (0 popups, 0 chamadas às fontes; R-8.7, AC-6.13).
  if (!completion.enabled || completion.sources.length === 0) return [];
  return [
    wordIndexField,
    autocompletion({
      override: [...completion.sources],
      activateOnTyping: completion.activateOnTyping,
      activateOnTypingDelay: COMPLETION_TYPING_DELAY_MS,
      // R4-02 / arch-ux F16: nenhuma opção pré-selecionada. Enter só aceita depois de ↓/↑ (ou de um
      // clique); sem isso, com o popup em 20 ms, um Enter logo depois de digitar "para" virava
      // "parabéns" em vez de quebrar a linha.
      selectOnOpen: false,
      defaultKeymap: false,
      maxRenderedOptions: 10,
      icons: false,
    }),
    Prec.highest(keymap.of([...completionKeys])),
  ];
}

const setHostVersion = StateEffect.define<number>();
/** Versão das contribuições que cada estado carrega: `refresh` é O(1) quando ela é atual. */
const hostVersionField = StateField.define<number>({
  create: () => -1,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setHostVersion)) return effect.value;
    return value;
  },
});

/**
 * Montagem do editor principal (arch-frontend r2 §3.1, regra 5). Todo estado de aba nasce aqui com
 * a pilha do r1 + 4 compartimentos (plugins, sugestões, atalhos globais, receptor de exceções).
 * Mudanças viram efeitos de `reconfigure` despachados no `EditorView` existente: documento,
 * seleção e histórico de desfazer ficam intactos e o view nunca é recriado.
 */
export class EditorHost {
  readonly #plugins = new Compartment();
  readonly #completion = new Compartment();
  readonly #globalKeys = new Compartment();
  readonly #sink = new Compartment();
  #contributions: EditorContributions;
  #version = 0;

  constructor(initial: EditorContributions = EMPTY_CONTRIBUTIONS) {
    this.#contributions = initial;
  }

  get version(): number {
    return this.#version;
  }

  get contributions(): EditorContributions {
    return this.#contributions;
  }

  createState(doc: string, opts: MarkdownExtensionsOptions = {}): EditorState {
    const c = this.#contributions;
    return EditorState.create({
      doc,
      extensions: [
        createMarkdownExtensions(opts),
        this.#plugins.of([...c.pluginExtensions]),
        this.#completion.of(completionExtension(c.completion)),
        this.#globalKeys.of(keymap.of([...c.globalBindings])),
        this.#sink.of(c.exceptionSink ? EditorView.exceptionSink.of(c.exceptionSink) : []),
        hostVersionField.init(() => this.#version),
      ],
    });
  }

  /** Troca parte das contribuições; devolve os efeitos para o estado vivo e sobe a versão. */
  update(next: Partial<EditorContributions>): readonly StateEffect<unknown>[] {
    this.#contributions = { ...this.#contributions, ...next };
    this.#version++;
    return this.#effects(next);
  }

  /** Atualiza um estado guardado (aba fora da tela) para a versão atual; sem mudança se já está. */
  refresh(state: EditorState): EditorState {
    if (state.field(hostVersionField, false) === this.#version) return state;
    return state.update({
      effects: this.#effects(this.#contributions),
      annotations: Transaction.addToHistory.of(false),
    }).state;
  }

  #effects(next: Partial<EditorContributions>): StateEffect<unknown>[] {
    const effects: StateEffect<unknown>[] = [setHostVersion.of(this.#version)];
    if (next.pluginExtensions) effects.push(this.#plugins.reconfigure([...next.pluginExtensions]));
    if (next.completion)
      effects.push(this.#completion.reconfigure(completionExtension(next.completion)));
    if (next.globalBindings)
      effects.push(this.#globalKeys.reconfigure(keymap.of([...next.globalBindings])));
    if (next.exceptionSink !== undefined) {
      const sink = next.exceptionSink;
      effects.push(this.#sink.reconfigure(sink ? EditorView.exceptionSink.of(sink) : []));
    }
    return effects;
  }
}
