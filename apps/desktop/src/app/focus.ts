import { EditorView } from '@codemirror/view';
import type { CodeMirrorEditorHandle } from '@simplemd/ui';
import type { RefObject } from 'react';
import type { EditorGroup } from '../state/store';
import type { AppController } from './controller';
import { GROUP_TEXT, GROUPS_MIN_WIDTH_PX } from './EditorGroup';

/**
 * Depois de fechar ou resolver algo, o foco vai ao editor da aba ativa; sem abas, ao item
 * itinerante do explorador (arch-ux §5.3, regra 4). Com o editor dividido, o do grupo com foco.
 */
export function focusEditorOrExplorer(
  app: AppController,
  editor: RefObject<CodeMirrorEditorHandle | null>,
): void {
  requestAnimationFrame(() => {
    if (app.store.getState().activeId) editor.current?.focus();
    else document.querySelector<HTMLElement>('[data-testid="explorer-row"][tabindex="0"]')?.focus();
  });
}

/**
 * Fecha a aba (com flush) e move o foco: vizinha da direita, da esquerda, ou o explorador. Era a
 * última de um grupo do editor dividido (r39b): os grupos se juntam no outro (store) e o editor
 * anuncia, como no ⌘\.
 */
export async function closeTab(
  app: AppController,
  editor: RefObject<CodeMirrorEditorHandle | null>,
  id: string,
): Promise<void> {
  const split = app.store.getState().split;
  if ((await app.sync.closeTab(id)) !== 'ok') return;
  if (split && !app.store.getState().split)
    app.plugins.editor.view?.dispatch({ effects: EditorView.announce.of(GROUP_TEXT.joined) });
  focusEditorOrExplorer(app, editor);
}

/**
 * Mostra/esconde o painel lateral (R-6.19, arch-ux r2 SPN-*). Pelo botão o foco fica nele; por
 * `Mod-Shift-L`, abrir leva o foco à aba ativa do painel e fechar com o foco dentro dele o devolve
 * ao editor (ou ao explorador). O editor nunca é recriado (regra 5).
 */
export function toggleSidePanel(
  app: AppController,
  editor: RefObject<CodeMirrorEditorHandle | null>,
  via: 'button' | 'key',
): void {
  const opening = !app.store.getState().sidePanelOpen;
  const inside = document.getElementById('side-panel')?.contains(document.activeElement) ?? false;
  app.store.setState({ sidePanelOpen: opening });
  if (via === 'button') return;
  if (opening) {
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>('#side-panel [role="tab"][aria-selected="true"]')
        ?.focus(),
    );
  } else if (inside) {
    focusEditorOrExplorer(app, editor);
  }
}

/**
 * "Dividir editor" pode agir? Juntar sempre pode; dividir pede uma nota aberta e 640 px na área do
 * editor (sem medida, cabe; r39b, D-R39-10).
 */
export function splitEnabled(app: AppController): true | { readonly reason: string } {
  const { split, activeId, editorWidth } = app.store.getState();
  if (split) return true;
  if (activeId === null) return { reason: GROUP_TEXT.noNote };
  if (editorWidth !== null && editorWidth < GROUPS_MIN_WIDTH_PX)
    return { reason: GROUP_TEXT.narrow(editorWidth) };
  return true;
}

/**
 * ⌘\ (Ctrl+\), "Dividir editor" / "Juntar grupos do editor" (r39b, design-r39 §1). Dividir abre o
 * grupo da direita vazio e com o foco do store (D-R39-03), leva o foco ao explorador e anuncia o
 * próximo passo pelo canal do app (r39c); juntar fica com o grupo com foco (D-R39-04).
 */
export function toggleSplit(
  app: AppController,
  editor: RefObject<CodeMirrorEditorHandle | null>,
): void {
  const state = app.store.getState();
  if (state.split) {
    joinGroups(app, editor, state.focusedGroup);
    return;
  }
  if (!state.splitEditor()) return;
  requestAnimationFrame(() => {
    // ⌘\ e ⌘W no mesmo quadro: os grupos já se juntaram, e só o anúncio da junção vale (r39c).
    if (!app.store.getState().split) return;
    document.querySelector<HTMLElement>('[data-testid="explorer-row"][tabindex="0"]')?.focus();
    // Uma devolução de foco que passou pelo grupo da esquerda (a paleta fechando) não tira o grupo
    // novo do foco do store: a nota escolhida no explorador abre nele.
    app.store.getState().focusGroup(1);
    app.plugins.editor.view?.dispatch({ effects: EditorView.announce.of(GROUP_TEXT.divided) });
  });
}

/** × "Fechar grupo …" e ⌘W num grupo vazio (r39b): as abas dele passam para o outro, que fica. */
export function closeGroup(
  app: AppController,
  editor: RefObject<CodeMirrorEditorHandle | null>,
  group: EditorGroup,
): void {
  if (app.store.getState().split) joinGroups(app, editor, group === 0 ? 1 : 0);
}

/** Junta os grupos no `keep` (as abas do outro vão para o fim), anuncia e leva o foco ao editor. */
function joinGroups(
  app: AppController,
  editor: RefObject<CodeMirrorEditorHandle | null>,
  keep: EditorGroup,
): void {
  app.store.getState().mergeGroups(keep);
  app.plugins.editor.view?.dispatch({ effects: EditorView.announce.of(GROUP_TEXT.joined) });
  focusEditorOrExplorer(app, editor);
}
