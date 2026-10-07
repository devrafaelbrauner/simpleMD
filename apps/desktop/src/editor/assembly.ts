import { Transaction, type EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { EditorHost, EMPTY_CONTRIBUTIONS } from '@simplemd/core';
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

  constructor(exceptionSink: (error: unknown) => void) {
    this.host = new EditorHost({ ...EMPTY_CONTRIBUTIONS, exceptionSink });
  }

  /** Estado novo de uma aba (nome acessível com o caminho, como no r1). */
  createState(doc: string, path: string): EditorState {
    return this.host.createState(doc, { ariaLabel: `Editor: ${path}` });
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

  /**
   * O view montado; `null` na desmontagem. Se contribuições chegaram antes da montagem, o estado do
   * view é atualizado a partir dele mesmo (mantém o listener do `CodeMirrorEditor`).
   */
  attach(view: EditorView | null): void {
    this.#view = view;
    if (!view) return;
    const current = this.host.refresh(view.state);
    if (current !== view.state) view.setState(current);
  }

  apply(snapshot: ContributionSnapshot): void {
    const effects = this.host.update({
      pluginExtensions: snapshot.pluginExtensions,
      completion: { enabled: true, sources: snapshot.completionSources },
      globalBindings: snapshot.globalBindings,
    });
    this.#view?.dispatch({ effects, annotations: Transaction.addToHistory.of(false) });
  }
}
