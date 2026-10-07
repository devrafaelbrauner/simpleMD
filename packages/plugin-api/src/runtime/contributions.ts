import type { CompletionSource } from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import type { KeyBinding } from '@codemirror/view';
import type { Unsubscribe } from '../types';

/** O que os plugins acrescentam ao editor principal, na ordem de carga (internos, depois id). */
export interface ContributionSnapshot {
  readonly pluginExtensions: readonly Extension[];
  readonly completionSources: readonly CompletionSource[];
  /** Atalhos de plugin, escopo `simplemd-global` (rodados pela janela; arch-frontend r2 §4.3). */
  readonly globalBindings: readonly KeyBinding[];
}

/** Implementado pelo app sobre o `EditorHost` do core (reconfiguração por `Compartment`). */
export interface EditorContributionSink {
  apply(snapshot: ContributionSnapshot): void;
}

export const GLOBAL_KEY_SCOPE = 'simplemd-global';

interface Item<T> {
  readonly pluginId: string;
  readonly value: T;
}

export type HotkeyResult =
  | { readonly bound: true; readonly unbind: Unsubscribe }
  | { readonly bound: false; readonly conflict: 'builtin' }
  | { readonly bound: false; readonly conflict: 'plugin'; readonly otherPluginId: string };

/**
 * Registro das contribuições de editor de todos os plugins. Cada mudança agenda UMA aplicação no
 * fim da microtarefa (ativar 3 plugins na abertura do vault = 1 reconfiguração; arch-frontend
 * r2 §3.1).
 */
export class ContributionStore {
  readonly #extensions: Item<Extension>[] = [];
  readonly #sources: Item<CompletionSource>[] = [];
  readonly #hotkeys = new Map<string, Item<KeyBinding>>();
  readonly #builtin: ReadonlySet<string>;
  readonly #rank: (pluginId: string) => number;
  #sink: EditorContributionSink | null = null;
  #scheduled = false;

  /** `rank`: posição do plugin na ordem de carga (menor = antes). */
  constructor(builtinHotkeys: ReadonlySet<string>, rank: (pluginId: string) => number) {
    this.#builtin = builtinHotkeys;
    this.#rank = rank;
  }

  /** Liga (ou desliga, com `null`) o editor; a contribuição atual é aplicada na hora. */
  setSink(sink: EditorContributionSink | null): void {
    this.#sink = sink;
    sink?.apply(this.snapshot());
  }

  snapshot(): ContributionSnapshot {
    const byRank = <T>(items: readonly Item<T>[]) =>
      [...items]
        .map((item, index) => ({ item, index }))
        .sort(
          (a, b) => this.#rank(a.item.pluginId) - this.#rank(b.item.pluginId) || a.index - b.index,
        )
        .map(({ item }) => item.value);
    return {
      pluginExtensions: byRank(this.#extensions),
      completionSources: byRank(this.#sources),
      globalBindings: byRank([...this.#hotkeys.values()]),
    };
  }

  /** Contagens para os testes de descarte (AC-6.19: de volta à linha de base). */
  counts(): { extensions: number; sources: number; hotkeys: number } {
    return {
      extensions: this.#extensions.length,
      sources: this.#sources.length,
      hotkeys: this.#hotkeys.size,
    };
  }

  addExtension(pluginId: string, extension: Extension): Unsubscribe {
    return this.#add(this.#extensions, { pluginId, value: extension });
  }

  addCompletionSource(pluginId: string, source: CompletionSource): Unsubscribe {
    return this.#add(this.#sources, { pluginId, value: source });
  }

  /**
   * Liga um atalho já normalizado. Conflito com um embutido ou com um plugin carregado antes →
   * não liga (R-6.9: o embutido vence; entre plugins, o primeiro a carregar vence).
   */
  bindHotkey(pluginId: string, key: string, run: () => boolean): HotkeyResult {
    if (this.#builtin.has(key)) return { bound: false, conflict: 'builtin' };
    const taken = this.#hotkeys.get(key);
    if (taken) return { bound: false, conflict: 'plugin', otherPluginId: taken.pluginId };
    const item: Item<KeyBinding> = {
      pluginId,
      value: { key, run, scope: GLOBAL_KEY_SCOPE, preventDefault: true },
    };
    this.#hotkeys.set(key, item);
    this.#schedule();
    return {
      bound: true,
      unbind: () => {
        if (this.#hotkeys.get(key) !== item) return;
        this.#hotkeys.delete(key);
        this.#schedule();
      },
    };
  }

  #add<T>(list: Item<T>[], item: Item<T>): Unsubscribe {
    list.push(item);
    this.#schedule();
    return () => {
      const index = list.indexOf(item);
      if (index === -1) return;
      list.splice(index, 1);
      this.#schedule();
    };
  }

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#sink?.apply(this.snapshot());
    });
  }
}
