import type { LtMenuAction, LtStatus, VimStatus } from '@simplemd/plugin-api/internal/host';
import { Observable } from '@simplemd/plugin-api/runtime';
import type { TabMode } from '@simplemd/core';

/**
 * Estado da barra de status C6 (r7 arch-frontend §3.5, D-R7-F13/F32, DA-R7-1): três slots
 * tipados. `tab` é do núcleo (espelho do modo de foco); `vim` só o registro do Vim escreve (S4);
 * `lt` só o registro do LanguageTool (S8). Textos, glifos, anúncios e menu são do componente
 * (`StatusBar.tsx`), nunca dos plugins.
 */
export interface StatusBarSnapshot {
  readonly tab: { readonly mode: TabMode } | null;
  readonly vim: VimStatus | null;
  readonly lt: LtStatus | null;
}

const EMPTY: StatusBarSnapshot = { tab: null, vim: null, lt: null };

/** "Como instalar" (M2 e linha do plugin; DA-R7-28, arch-ux P-7): abre pelo `openUrl` nativo. */
export const LANGUAGETOOL_DOCS_URL =
  'https://github.com/devrafaelbrauner/simpleMD/blob/main/docs/languagetool.md';

export class StatusBarStore extends Observable<StatusBarSnapshot> {
  readonly #ltActions = new Set<(action: LtMenuAction) => void>();

  constructor() {
    super(EMPTY);
  }

  set<K extends keyof StatusBarSnapshot>(slot: K, value: StatusBarSnapshot[K]): void {
    const current = this.getSnapshot();
    if (current[slot] === value) return;
    this.publish({ ...current, [slot]: value });
  }

  /** Assinatura do registro do LT: "Tentar de novo" / "Verificar … agora" do menu M2. */
  onLtAction(listener: (action: LtMenuAction) => void): () => void {
    this.#ltActions.add(listener);
    return () => this.#ltActions.delete(listener);
  }

  runLtAction(action: LtMenuAction): void {
    for (const listener of [...this.#ltActions]) listener(action);
  }
}
