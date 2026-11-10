import type { StateEffect } from '@codemirror/state';
import {
  CodeMirrorEditor,
  EditorPanel,
  SPLIT_MIN_PANE_PX,
  TabBar,
  tabDomId,
  type CodeMirrorEditorHandle,
  type TabView,
} from '@simplemd/ui';
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { AppStore, DocStatus, EditorGroup as Group } from '../state/store';
import type { AppController } from './controller';

/** Largura mínima do editor para dividir (r39b, D-R39-10): dois grupos de 320 px. */
export const GROUPS_MIN_WIDTH_PX = 2 * SPLIT_MIN_PANE_PX;

/** Textos do editor dividido (r39b, design-r39 §1). */
export const GROUP_TEXT = {
  split: 'Dividir editor',
  merge: 'Juntar grupos do editor',
  noNote: 'Abra uma nota primeiro.',
  narrow: (width: number) =>
    `Precisa de ${GROUPS_MIN_WIDTH_PX} px no editor (agora ${width} px). Feche o painel lateral ou aumente a janela.`,
  divided: 'Editor dividido. Escolha uma nota no explorador para abrir no grupo da direita.',
  joined: 'Editor em um grupo só.',
  /** Nome do `role=group` de cada grupo, com o editor dividido. */
  name: ['Grupo da esquerda', 'Grupo da direita'],
} as const;

/**
 * O `editor` do App (design-r39 §1): o handle do grupo com foco, lido do store a cada uso, então
 * foco, teclas e comandos seguem com a forma `editor.current`. Cada `EditorGroup` montado põe o seu.
 */
export class GroupEditors {
  readonly #store: AppStore;
  readonly #handles: [CodeMirrorEditorHandle | null, CodeMirrorEditorHandle | null] = [null, null];

  constructor(store: AppStore) {
    this.#store = store;
  }

  get current(): CodeMirrorEditorHandle | null {
    return this.#handles[this.#store.getState().focusedGroup];
  }

  set(group: Group, handle: CodeMirrorEditorHandle | null): void {
    this.#handles[group] = handle;
  }
}

export interface EditorGroupProps {
  app: AppController;
  group: Group;
  /** Editor dividido: o grupo vira `role=group` com nome e a faixa ganha "Fechar grupo …". */
  split: boolean;
  /** O grupo tem o foco (sem divisão, sempre o 0); sem ele, a aba ativa perde a faixa e o negrito. */
  focused: boolean;
  /** Abas do grupo (memo do `Shell`: trocar de aba não as recria). */
  tabs: readonly TabView[];
  /** Aba ativa do grupo e o estado do documento dela. */
  activeId: string | null;
  activeStatus: DocStatus | undefined;
  editors: GroupEditors;
  /** Rolagem de cada aba que saiu da tela, uma para os dois grupos (uma nota fica num grupo só). */
  scrolls: RefObject<Map<string, StateEffect<unknown>>>;
  onCloseTab(id: string): void;
  /** "Fechar grupo …": as abas dele passam para o outro grupo. */
  onCloseGroup(): void;
  /** Cada mudança do documento (o `Shell` recalcula Sumário e Propriedades). */
  onDocChange(): void;
}

/**
 * Um grupo do editor (r39b, design-r39 §1): a faixa de abas, o painel e o `CodeMirrorEditor` do
 * grupo — um `EditorView` por grupo, criado uma vez (regra 5) —, com a troca de aba (`showTab`), a
 * recarga do disco e o `onChange` da aba que ele mostra. Foco ou ponteiro dentro dele passa o foco
 * do store a este grupo (comandos, ⌘E, IA, prévia e barra de status seguem o grupo com foco).
 */
export function EditorGroup({
  app,
  group,
  split,
  focused,
  tabs,
  activeId,
  activeStatus,
  editors,
  scrolls,
  onCloseTab,
  onCloseGroup,
  onDocChange,
}: EditorGroupProps) {
  const { store, registry, sync } = app;
  const assembly = app.plugins.editor;
  const handle = useRef<CodeMirrorEditorHandle>(null);
  /** Aba cujo estado está no editor deste grupo: a origem de cada `onChange`. */
  const shownId = useRef<string | null>(null);

  // O view do grupo recebe as contribuições dos plugins (regra 5) e é o `editor` do App enquanto o
  // grupo tem o foco. A limpeza roda antes da do filho (o `destroy` do view): o grupo que fecha
  // deixa guardada a nota que mostrava, e o que fica a mostra como estava (`takeParked`, r39a).
  useLayoutEffect(() => {
    editors.set(group, handle.current);
    assembly.attach(handle.current?.view ?? null, group);
    return () => {
      assembly.attach(null, group);
      editors.set(group, null);
    };
  }, [assembly, group, editors]);

  const showTab = useCallback(
    (id: string | null) => {
      const current = handle.current;
      if (!current) return;
      const { view } = current;
      const previous = shownId.current;
      const left = previous === null || previous === id ? undefined : registry.get(previous);
      if (previous !== null && left) {
        // arch-frontend F-3, passo 1: guarda o estado inteiro da aba que sai (cursor, seleção,
        // foco), não só o que veio de transações que mudaram o documento (CR-04). Só quando o
        // documento é o mesmo: uma recarga do disco já trocou o estado do registro.
        if (left.state.doc.eq(view.state.doc)) registry.updateState(previous, view.state);
        scrolls.current.set(previous, view.scrollSnapshot());
      }
      const record = id === null ? undefined : registry.get(id);
      shownId.current = record ? id : null;
      // A nota que o grupo que fechou mostrava chega com o cursor, o desfazer e a rolagem dela.
      const parked = id !== null && record ? assembly.takeParked(id, record.state) : null;
      current.setState(assembly.refresh(parked?.state ?? record?.state ?? assembly.emptyState()));
      const scroll = parked?.scroll ?? (id === null ? undefined : scrolls.current.get(id));
      if (record && scroll) current.dispatch({ effects: scroll });
      if (record) requestAnimationFrame(() => performance.mark('simplemd:file-visible'));
    },
    [registry, assembly, scrolls],
  );

  // Troca de aba no grupo (ou fim da leitura): o mesmo EditorView, estado por aba (arch-frontend F-3).
  useLayoutEffect(() => {
    const wanted = activeStatus === undefined || activeStatus === 'loading' ? null : activeId;
    if (wanted !== shownId.current) showTab(wanted);
  }, [activeId, activeStatus, showTab]);

  // Recarga do disco (aba limpa ou conflito resolvido): o estado novo entra sem `onChange`.
  useEffect(
    () =>
      registry.onReplace((id) => {
        scrolls.current.delete(id);
        const state = store.getState();
        if (id === state.groupActive[group] && state.docs[id] !== 'loading') showTab(id);
      }),
    [registry, store, group, showTab, scrolls],
  );

  const activeIndex = tabs.findIndex((tab) => tab.id === activeId);
  const activeTab = tabs[activeIndex];
  const focusGroup = () => store.getState().focusGroup(group);
  return (
    <div
      className="smd-group"
      data-testid="editor-group"
      data-group={group}
      data-focus={split && !focused ? 'off' : undefined}
      role={split ? 'group' : undefined}
      aria-label={split ? GROUP_TEXT.name[group] : undefined}
      onFocus={focusGroup}
      onPointerDown={focusGroup}
    >
      <TabBar
        tabs={tabs}
        activeId={activeId}
        group={group}
        onActivate={(id, { focusEditor }) => {
          store.getState().activate(id);
          if (focusEditor) requestAnimationFrame(() => handle.current?.focus());
        }}
        onClose={onCloseTab}
        onCloseGroup={split ? onCloseGroup : undefined}
      />
      <EditorPanel
        group={group}
        split={split}
        labelledBy={activeIndex === -1 ? null : tabDomId(activeIndex, group)}
        openingName={activeTab && activeStatus === 'loading' ? activeTab.name : null}
      >
        <CodeMirrorEditor
          ref={handle}
          className="smd-panel-host"
          initialState={assembly.emptyState()}
          onChange={(update) => {
            const id = shownId.current;
            if (id !== null) {
              sync.onEditorChange(id, update.state);
              app.ai.onEditorChange(id, update);
              // r38a: depois do registro atualizado (o motor da prévia lê o texto de lá).
              app.preview.onEditorChange(id);
            }
            onDocChange();
          }}
        />
      </EditorPanel>
    </div>
  );
}
