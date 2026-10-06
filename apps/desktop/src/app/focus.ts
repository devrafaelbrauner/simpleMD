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
