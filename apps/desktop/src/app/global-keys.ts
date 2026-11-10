/**
 * Atalhos de janela do app (arch-frontend §4.3, r2 §4.3; r7 D-R7-F20): a tabela que
 * `useGlobalKeys` executa e que o teste de conflitos (`shortcut-conflicts.test.ts`, AC-X7.5) lê.
 * Rodam num `keydown` de janela em captura: vencem qualquer tecla do editor, inclusive o Vim
 * (D-38), e são a 3ª saída do editor com a "Tecla Tab no editor" ligada (arch-ux §6.1).
 */
export type GlobalKeyId =
  | 'palette'
  | 'side-panel'
  | 'ai-palette'
  | 'export-pdf'
  | 'close-tab'
  | 'open-vault'
  | 'new-note'
  | 'settings'
  | 'next-tab'
  | 'prev-tab'
  | 'toggle-live-preview'
  | 'toggle-side-preview'
  | 'toggle-split'
  | 'search-text';

export interface GlobalKey {
  readonly id: GlobalKeyId;
  /** Notação do CodeMirror (`Mod` = ⌘ no macOS, Ctrl nos demais). */
  readonly key: string;
}

/**
 * "Editor: alternar live preview" (r27, D-R27-02): global para valer com o foco em qualquer lugar e
 * vencer o Vim (no Windows/Linux o `<C-e>` do Vim deixa de rolar, como o `<C-n>` com `Mod-N`).
 * Também é o atalho mostrado na paleta e no item "Fonte"/"Prévia" da barra de status.
 */
export const TOGGLE_LIVE_PREVIEW_KEY = 'Mod-e';

/**
 * "Editor: alternar prévia lado a lado" (r38b, D-R38-05): global como o `Mod-E` (vale com o foco em
 * qualquer lugar e vence o Vim) e reservado para plugins (`BUILTIN_KEYS`). Livre no CodeMirror, nos
 * internos e no menu do macOS.
 */
export const TOGGLE_SIDE_PREVIEW_KEY = 'Mod-Shift-d';

/**
 * "Dividir editor" / "Juntar grupos do editor" (r39b, D-R39-05): global como o `Mod-E` (vale com o
 * foco em qualquer lugar e vence o Vim) e reservado para plugins (`BUILTIN_KEYS`). Livre no
 * CodeMirror (que só liga `Mod-Alt-\` e `Shift-Mod-\`), no Vim e nos internos.
 */
export const TOGGLE_SPLIT_KEY = 'Mod-\\';

/**
 * "Buscar no texto das notas" (r37c, D-R37-4): global como o `Mod-Shift-D` (vale com o foco em
 * qualquer lugar e vence o Vim) e reservado para plugins (`BUILTIN_KEYS`). Livre no app, no
 * CodeMirror, no Vim e no menu do macOS; a r38/r39 não o usam.
 */
export const SEARCH_TEXT_KEY = 'Mod-Shift-g';

export const GLOBAL_KEYS: readonly GlobalKey[] = [
  { id: 'palette', key: 'Mod-Shift-p' },
  { id: 'side-panel', key: 'Mod-Shift-l' },
  { id: 'ai-palette', key: 'Mod-Shift-a' },
  { id: 'export-pdf', key: 'Mod-p' },
  { id: 'close-tab', key: 'Mod-w' },
  { id: 'open-vault', key: 'Mod-o' },
  { id: 'new-note', key: 'Mod-n' },
  { id: 'settings', key: 'Mod-,' },
  { id: 'next-tab', key: 'Ctrl-Tab' },
  { id: 'prev-tab', key: 'Ctrl-Shift-Tab' },
  { id: 'toggle-live-preview', key: TOGGLE_LIVE_PREVIEW_KEY },
  { id: 'toggle-side-preview', key: TOGGLE_SIDE_PREVIEW_KEY },
  { id: 'toggle-split', key: TOGGLE_SPLIT_KEY },
  { id: 'search-text', key: SEARCH_TEXT_KEY },
];

type KeyEventLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

/**
 * Qual atalho da tabela o evento aciona (mesmas regras do r1/r2): `Mod` exige só o modificador
 * principal da plataforma e nenhum Alt; Shift precisa ser exatamente o da entrada; `Ctrl-Tab` exige
 * Ctrl sem ⌘/Alt em todo sistema.
 */
export function matchGlobalKey(event: KeyEventLike, platform: 'mac' | 'other'): GlobalKeyId | null {
  const mod =
    (platform === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
    !event.altKey;
  const ctrlOnly = event.ctrlKey && !event.metaKey && !event.altKey;
  const pressed = event.key.toLowerCase();
  for (const { id, key } of GLOBAL_KEYS) {
    const parts = key.split(/-(?!$)/);
    const name = (parts.pop() ?? '').toLowerCase();
    const shift = parts.includes('Shift');
    if (pressed !== name || event.shiftKey !== shift) continue;
    if (parts.includes('Mod') ? mod : ctrlOnly) return id;
  }
  return null;
}
