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

/**
 * O listener de mudanças vive na configuração do estado, então um estado vindo de fora
 * (`setState`) recebe o listener desta montagem se ainda não o tiver.
 */
function withListener(state: EditorState, listener: UpdateListener): EditorState {
  if (state.facet(EditorView.updateListener).includes(listener)) return state;
  return state.update({
    effects: StateEffect.appendConfig.of(EditorView.updateListener.of(listener)),
  }).state;
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
  const listenerRef = useRef<UpdateListener | null>(null);
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
    const listener: UpdateListener = (update) => {
      if (update.docChanged) onChangeRef.current?.(update);
    };
    const state =
      mount.initialState ??
      EditorState.create({ doc: mount.initialDoc ?? '', extensions: mount.extensions ?? [] });
    const view = new EditorView({ state: withListener(state, listener), parent: host });
    constructions++;
    viewRef.current = view;
    listenerRef.current = listener;
    return () => {
      viewRef.current = null;
      listenerRef.current = null;
      view.destroy();
    };
  }, []);

  useImperativeHandle(ref, () => {
    const mounted = (): { view: EditorView; listener: UpdateListener } => {
      const view = viewRef.current;
      const listener = listenerRef.current;
      if (!view || !listener) throw new Error('CodeMirrorEditor não está montado');
      return { view, listener };
    };
    return {
      get view() {
        return mounted().view;
      },
      dispatch: (...specs) => mounted().view.dispatch(...specs),
      setState: (state) => {
        const { view, listener } = mounted();
        view.setState(withListener(state, listener));
      },
      getText: () => mounted().view.state.doc.toString(),
      focus: () => mounted().view.focus(),
    };
  }, []);

  return <div ref={hostRef} className={className} data-testid={testId} />;
}
