import type { CompletionSource } from '@codemirror/autocomplete';
import { Transaction, type EditorState, type Extension, type StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  appCompletionSources,
  DEFAULT_AUTOCOMPLETE,
  EditorHost,
  EMPTY_CONTRIBUTIONS,
  isLivePreview,
  noteContext,
  observeLivePreview,
  resetTabFocus,
  toggleLivePreviewAnnounced,
  type AppCompletionDeps,
  type AutocompleteSettings,
  type CompletionRuntime,
  type EditorMode,
} from '@simplemd/core';
import {
  Observable,
  type ContributionSnapshot,
  type EditorContributionSink,
} from '@simplemd/plugin-api/runtime';
import type { EditorGroup } from '../state/store';

/** Modo da nota mostrada (r27); `null` no estado sem aba. Publica só quando muda. */
class EditorModeSignal extends Observable<EditorMode | null> {
  constructor() {
    super(null);
  }

  set(mode: EditorMode | null): void {
    if (mode !== this.getSnapshot()) this.publish(mode);
  }
}

/**
 * A nota que um view mostrava quando saiu (r39a: o grupo que fecha na junção): o estado inteiro
 * (cursor, seleção, desfazer) e a rolagem, até o grupo que fica mostrá-la.
 */
export interface ParkedNote {
  readonly state: EditorState;
  readonly scroll: StateEffect<unknown>;
}

/**
 * Cola entre o host de plugins e os editores (arch-frontend r2 §3.1). Todo estado de aba nasce no
 * `EditorHost`; as contribuições chegam como efeitos de `reconfigure` despachados em cada
 * `EditorView` montado — um por grupo do editor, criado uma vez (regra 5; r39a) —, e as abas fora
 * da tela são atualizadas por `refresh` quando voltam a ser mostradas. Comandos, ⌘E, IA e a barra
 * agem no view do grupo com foco (`view`); quem procura uma nota usa o view que a mostra (`viewOf`).
 */
export class EditorAssembly implements EditorContributionSink {
  readonly host: EditorHost;
  /** O view de cada grupo (r39a); o do grupo 1 só existe com o editor dividido. */
  readonly #views: [EditorView | null, EditorView | null] = [null, null];
  #focused: EditorGroup = 0;
  readonly #parked = new Map<string, ParkedNote>();
  #empty: EditorState | null = null;
  #settings: AutocompleteSettings = DEFAULT_AUTOCOMPLETE;
  #appSources: readonly CompletionSource[] = [];
  #pluginSources: readonly CompletionSource[] = [];
  readonly #applied = new Set<() => void>();
  readonly #mode = new EditorModeSignal();

  /**
   * Avisa depois de cada aplicação das contribuições dos plugins (facets novas no estado), a cada
   * montagem/desmontagem de um view (CR-ST-07: plugins aplicados antes do editor montar) e a cada
   * troca do grupo com foco (r39a).
   */
  onApplied(listener: () => void): () => void {
    this.#applied.add(listener);
    return () => this.#applied.delete(listener);
  }

  /** `services`: facets de serviço do app (`editor/services.ts`), estáveis por janela. */
  constructor(exceptionSink: (error: unknown) => void, services: Extension = []) {
    this.host = new EditorHost({ ...EMPTY_CONTRIBUTIONS, exceptionSink }, [
      services,
      // r27: o modo da nota mostrada para o item "Fonte"/"Prévia" da barra de status. O observador
      // avisa de qualquer view; o modo publicado é sempre o do view com foco (r39a).
      observeLivePreview(() => this.#publishMode()),
    ]);
  }

  /**
   * Modo da nota mostrada no view com foco (r27; r39a): `null` sem nota (estado sem aba, aba
   * carregando ou grupo sem view).
   */
  get mode(): Observable<EditorMode | null> {
    return this.#mode;
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
   * `EditorView` novos). Toda mudança da chave volta o modo de cada view a "Tab indenta" (T1) e
   * rearma o anúncio da primeira entrada de foco.
   */
  setCaptureTab(captureTab: boolean): void {
    if (this.host.contributions.captureTab === captureTab) return;
    this.#dispatch(this.host.update({ captureTab }));
    for (const view of this.#views) if (view) resetTabFocus(view);
  }

  #completion(): CompletionRuntime {
    return {
      enabled: this.#settings.enabled,
      activateOnTyping: this.#settings.mode === 'auto',
      sources: [...this.#appSources, ...this.#pluginSources],
    };
  }

  /** Os efeitos vão a todos os views montados (r39a: um por grupo). */
  #dispatch(effects: readonly StateEffect<unknown>[]): void {
    for (const view of this.#views)
      view?.dispatch({ effects, annotations: Transaction.addToHistory.of(false) });
  }

  /**
   * Estado novo de uma aba (nome acessível com o caminho, como no r1; `noteContext` = caminho).
   * `mode` (r27): prévia, o padrão do núcleo, ou fonte. A nota foi aberta de novo ou relida do disco:
   * o que um view que saiu guardou dela não vale mais (r39a).
   */
  createState(doc: string, path: string, mode: EditorMode = 'live'): EditorState {
    this.#parked.delete(path);
    return this.host.createState(doc, {
      ariaLabel: `Editor: ${path}`,
      notePath: path,
      livePreview: mode === 'live',
    });
  }

  /**
   * Modo atual da aba `path` (r27): o do view que a mostra (o registro só guarda o estado ao trocar
   * de aba), senão o de `stored`; `undefined` sem nenhum dos dois (aba nova).
   */
  modeOf(path: string, stored?: EditorState): EditorMode | undefined {
    const state = this.viewOf(path)?.state ?? stored;
    if (!state) return undefined;
    return isLivePreview(state) ? 'live' : 'source';
  }

  /**
   * "Editor: alternar live preview" (r27: `Mod-E`, paleta, barra de status): só com uma nota no
   * view; um `reconfigure` anunciado (0 `EditorView` novos, nada gravado, fora do desfazer).
   */
  toggleLivePreview(): boolean {
    const view = this.view;
    if (!view || view.state.facet(noteContext).path === null) return false;
    toggleLivePreviewAnnounced(view);
    return true;
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
   * O view do grupo com foco (comandos, ⌘E, IA e prévia leem e aplicam nele); `null` se o grupo
   * ainda não montou.
   */
  get view(): EditorView | null {
    return this.#views[this.#focused];
  }

  /**
   * O view que mostra a nota `path`, com ou sem foco (r39a): quem edita uma nota ou leva o cursor a
   * ela usa este, nunca `view`. `null` se nenhum a mostra.
   */
  viewOf(path: string): EditorView | null {
    const focused = this.#views[this.#focused];
    if (focused?.state.facet(noteContext).path === path) return focused;
    const other = this.#views[this.#focused === 0 ? 1 : 0];
    return other?.state.facet(noteContext).path === path ? other : null;
  }

  /**
   * Passa o foco ao grupo (r39a; o controlador liga o `focusedGroup` do store aqui): `view`, `mode` e
   * os comandos passam a ser os do view dele.
   */
  focusGroup(group: EditorGroup): void {
    if (group === this.#focused) return;
    this.#focused = group;
    this.#publishMode();
    for (const listener of [...this.#applied]) listener();
  }

  /**
   * O view montado no grupo (padrão: 0, o principal); `null` na desmontagem. Se contribuições
   * chegaram antes da montagem, o estado do view é atualizado a partir dele mesmo (mantém o ouvinte
   * do `CodeMirrorEditor`). O view que sai ainda está montado (cleanup de layout do grupo, antes do
   * `destroy`) e guarda a nota que mostrava: na junção, o grupo que fecha a entrega ao que fica
   * (`takeParked`, r39a).
   */
  attach(view: EditorView | null, group: EditorGroup = 0): void {
    const previous = this.#views[group];
    const leaving = previous === view ? null : previous?.state.facet(noteContext).path;
    if (previous && leaving)
      this.#parked.set(leaving, { state: previous.state, scroll: previous.scrollSnapshot() });
    this.#views[group] = view;
    if (view) {
      const current = this.host.refresh(view.state);
      if (current !== view.state) view.setState(current);
    }
    if (group === this.#focused) this.#publishMode();
    for (const listener of [...this.#applied]) listener();
  }

  /**
   * A nota `path` como o view que saiu a deixou (r39a), para o grupo que fica mostrá-la: estado e
   * rolagem, só se o documento ainda é o de `current` (o do registro; uma tarefa marcada fora da
   * tela o troca). Entregue uma vez.
   */
  takeParked(path: string, current: EditorState): ParkedNote | null {
    const parked = this.#parked.get(path);
    this.#parked.delete(path);
    return parked?.state.doc.eq(current.doc) ? parked : null;
  }

  #publishMode(): void {
    const state = this.view?.state;
    if (!state || state.facet(noteContext).path === null) this.#mode.set(null);
    else this.#mode.set(isLivePreview(state) ? 'live' : 'source');
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
