import type { CompletionSource } from '@codemirror/autocomplete';
import { Transaction, type EditorState, type Extension, type StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  appCompletionSources,
  DEFAULT_AUTOCOMPLETE,
  EditorHost,
  EMPTY_CONTRIBUTIONS,
  resetTabFocus,
  type AppCompletionDeps,
  type AutocompleteSettings,
  type CompletionRuntime,
} from '@simplemd/core';
import type { ContributionSnapshot, EditorContributionSink } from '@simplemd/plugin-api/runtime';

/**
 * Cola entre o host de plugins e o editor principal (arch-frontend r2 §3.1). Todo estado de aba
 * nasce no `EditorHost`; as contribuições chegam como efeitos de `reconfigure` despachados no
 * `EditorView` montado (nunca recriado, regra 5). Abas fora da tela são atualizadas por `refresh`
 * quando voltam a ser mostradas.
 */
export class EditorAssembly implements EditorContributionSink {
  readonly host: EditorHost;
  #view: EditorView | null = null;
  #empty: EditorState | null = null;
  #settings: AutocompleteSettings = DEFAULT_AUTOCOMPLETE;
  #appSources: readonly CompletionSource[] = [];
  #pluginSources: readonly CompletionSource[] = [];
  readonly #applied = new Set<() => void>();

  /**
   * Avisa depois de cada aplicação das contribuições dos plugins (facets novas no estado) e a cada
   * montagem/desmontagem do view (CR-ST-07: plugins aplicados antes do editor montar).
   */
  onApplied(listener: () => void): () => void {
    this.#applied.add(listener);
    return () => this.#applied.delete(listener);
  }

  /** `services`: facets de serviço do app (`editor/services.ts`), estáveis por janela. */
  constructor(exceptionSink: (error: unknown) => void, services: Extension = []) {
    this.host = new EditorHost({ ...EMPTY_CONTRIBUTIONS, exceptionSink }, services);
  }

  /**
   * Configurações do autocompletar (R-8.2): reconfigura o compartimento de sugestões ao vivo, sem
   * recriar o `EditorView` (AC-8.5). Desligado = compartimento vazio (R-8.7, AC-6.13).
   */
  setAutocomplete(settings: AutocompleteSettings, deps: AppCompletionDeps): void {
    this.#settings = settings;
    this.#appSources = appCompletionSources(settings, deps);
    this.#dispatch(this.host.update({ completion: this.#completion() }));
  }

  /**
   * "Tecla Tab no editor" (r7 R-X7.1/R-X7.2): reconfigura o compartimento `#hostKeys` (0
   * `EditorView` novos). Toda mudança da chave volta o modo a "Tab indenta" (T1) e rearma o anúncio
   * da primeira entrada de foco.
   */
  setCaptureTab(captureTab: boolean): void {
    if (this.host.contributions.captureTab === captureTab) return;
    this.#dispatch(this.host.update({ captureTab }));
    if (this.#view) resetTabFocus(this.#view);
  }

  #completion(): CompletionRuntime {
    return {
      enabled: this.#settings.enabled,
      activateOnTyping: this.#settings.mode === 'auto',
      sources: [...this.#appSources, ...this.#pluginSources],
    };
  }

  #dispatch(effects: readonly StateEffect<unknown>[]): void {
    this.#view?.dispatch({ effects, annotations: Transaction.addToHistory.of(false) });
  }

  /** Estado novo de uma aba (nome acessível com o caminho, como no r1; `noteContext` = caminho). */
  createState(doc: string, path: string): EditorState {
    return this.host.createState(doc, { ariaLabel: `Editor: ${path}`, notePath: path });
  }

  /** Estado mostrado sem abas (refeito a cada versão das contribuições). */
  emptyState(): EditorState {
    this.#empty = this.host.refresh(
      this.#empty ?? this.host.createState('', { ariaLabel: 'Editor de markdown' }),
    );
    return this.#empty;
  }

  refresh(state: EditorState): EditorState {
    return this.host.refresh(state);
  }

  /** O `EditorView` principal montado (comandos de IA leem a seleção e aplicam o resultado). */
  get view(): EditorView | null {
    return this.#view;
  }

  /**
   * O view montado; `null` na desmontagem. Se contribuições chegaram antes da montagem, o estado do
   * view é atualizado a partir dele mesmo (mantém o listener do `CodeMirrorEditor`).
   */
  attach(view: EditorView | null): void {
    this.#view = view;
    if (view) {
      const current = this.host.refresh(view.state);
      if (current !== view.state) view.setState(current);
    }
    for (const listener of [...this.#applied]) listener();
  }

  apply(snapshot: ContributionSnapshot): void {
    this.#pluginSources = snapshot.completionSources;
    this.#dispatch(
      this.host.update({
        pluginExtensions: snapshot.pluginExtensions,
        completion: this.#completion(),
        globalBindings: snapshot.globalBindings,
      }),
    );
    for (const listener of [...this.#applied]) listener();
  }
}
