import { EditorState, StateEffect, type Extension, type TransactionSpec } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react';

export interface CodeMirrorEditorHandle {
  readonly view: EditorView;
  /** Toda escrita passa por aqui (regra 5). */
  dispatch(...specs: TransactionSpec[]): void;
  /** Troca de aba / recarga do disco. Não dispara `onChange`. */
  setState(state: EditorState): void;
  /** Materializa o documento (só no caminho de salvar). */
  getText(): string;
  focus(): void;
}

export interface CodeMirrorEditorProps {
  /** Lido SÓ na montagem (AC-1.7). */
  initialDoc?: string;
  /** Lido SÓ na montagem; tem precedência sobre `initialDoc`. */
  initialState?: EditorState;
  /** Lido SÓ na montagem (usado com `initialDoc`). */
  extensions?: Extension;
  /** Chamado uma vez por `ViewUpdate` que muda o documento; sempre a versão mais recente. */
  onChange?: (update: ViewUpdate) => void;
  className?: string;
  'data-testid'?: string;
  ref?: Ref<CodeMirrorEditorHandle>;
}

type UpdateListener = (update: ViewUpdate) => void;

let constructions = 0;

/**
 * Quantos `EditorView` este componente já construiu na página (H22; r7 NFR-53, AC-X7.4/AC-I4.1):
 * ligar/desligar plugins, a chave Tab ou trocar de aba nunca soma (regra 5).
 */
export function editorViewConstructions(): number {
  return constructions;
}

/** O `onChange` de cada view montado (r39a, D-R39-07). */
const changeRoutes = new WeakMap<EditorView, UpdateListener>();

/**
 * Ouvinte ÚNICO do módulo, guardado na configuração do estado (r39a, D-R39-07). Um estado viaja
 * entre views (aba de um grupo que fecha mostrada no outro): um ouvinte por montagem iria junto e o
 * `onChange` do grupo velho gravaria o texto desta nota no arquivo da aba que ele mostrava. Este
 * entrega cada mudança ao `onChange` do view onde ela aconteceu, e só a ele.
 */
const routeChange: UpdateListener = (update) => {
  if (update.docChanged) changeRoutes.get(update.view)?.(update);
};

/** Um estado vindo de fora (`setState`) recebe o ouvinte do módulo se ainda não o tiver. */
function withListener(state: EditorState): EditorState {
  if (state.facet(EditorView.updateListener).includes(routeChange)) return state;
  return state.update({
    effects: StateEffect.appendConfig.of(EditorView.updateListener.of(routeChange)),
  }).state;
}

/**
 * Sem foco, o CodeMirror não reescreve a seleção do DOM; uma seleção velha no conteúdo faz o
 * WKWebView rolar até ela no `focus()`, mesmo com `preventScroll` (AC-R11-3.4). Sem ela, o foco
 * deixa o CodeMirror recriar a dele.
 */
function dropStaleSelection(view: EditorView): void {
  if (view.root.activeElement === view.contentDOM) return;
  const selection = view.dom.ownerDocument.getSelection();
  if (selection?.anchorNode && view.contentDOM.contains(selection.anchorNode))
    selection.removeAllRanges();
}

/**
 * R38B-FOCO-ROLAGEM: quem devolve o foco ao editor (diálogo, paleta, L6, exportação) chama
 * `focus()` no `.cm-content`, sem opções; o motor põe a seleção no início do conteúdo e rola até ela
 * (`.cm-scroller` 9789 → 22), e a prévia segue. Todo foco programático do conteúdo passa a ser como
 * o do handle: sem seleção velha e sem rolar; o CodeMirror devolve o cursor ao lugar dele.
 */
function focusWithoutScroll(view: EditorView): void {
  const content = view.contentDOM;
  const focus = content.focus.bind(content);
  content.focus = (options?: FocusOptions) => {
    dropStaleSelection(view);
    focus({ ...options, preventScroll: true });
  };
}

/**
 * Hospeda um `EditorView` do CodeMirror 6. O view é construído UMA vez por montagem e
 * destruído na desmontagem (regra 5): o efeito tem lista de dependências vazia e props
 * alteradas depois da montagem são ignoradas. A comunicação é por `dispatch` no handle.
 */
export function CodeMirrorEditor({
  initialDoc,
  initialState,
  extensions,
  onChange,
  className,
  'data-testid': testId,
  ref,
}: CodeMirrorEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  // Valores de montagem capturados uma vez; mudanças posteriores nessas props são ignoradas.
  const mountRef = useRef({ initialDoc, initialState, extensions });

  useLayoutEffect(() => {
    onChangeRef.current = onChange;
  });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const mount = mountRef.current;
    const state =
      mount.initialState ??
      EditorState.create({ doc: mount.initialDoc ?? '', extensions: mount.extensions ?? [] });
    const view = new EditorView({ state: withListener(state), parent: host });
    constructions++;
    changeRoutes.set(view, (update) => onChangeRef.current?.(update));
    focusWithoutScroll(view);
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      changeRoutes.delete(view);
      view.destroy();
    };
  }, []);

  useImperativeHandle(ref, () => {
    const mounted = (): EditorView => {
      const view = viewRef.current;
      if (!view) throw new Error('CodeMirrorEditor não está montado');
      return view;
    };
    return {
      get view() {
        return mounted();
      },
      dispatch: (...specs) => mounted().dispatch(...specs),
      setState: (state) => mounted().setState(withListener(state)),
      getText: () => mounted().state.doc.toString(),
      // A seleção velha sai no `focus` do conteúdo (`focusWithoutScroll`), por onde o
      // `view.focus()` passa.
      focus: () => mounted().focus(),
    };
  }, []);

  return <div ref={hostRef} className={className} data-testid={testId} />;
}
