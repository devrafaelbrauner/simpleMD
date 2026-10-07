import type { CodeMirrorEditorHandle } from '@simplemd/ui';
import type { RefObject } from 'react';
import type { AppController } from './controller';

/**
 * Depois de fechar ou resolver algo, o foco vai ao editor da aba ativa; sem abas, ao item
 * itinerante do explorador (arch-ux §5.3, regra 4).
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

/** Fecha a aba (com flush) e move o foco: vizinha da direita, da esquerda, ou o explorador. */
export async function closeTab(
  app: AppController,
  editor: RefObject<CodeMirrorEditorHandle | null>,
  id: string,
): Promise<void> {
  if ((await app.sync.closeTab(id)) === 'ok') focusEditorOrExplorer(app, editor);
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
