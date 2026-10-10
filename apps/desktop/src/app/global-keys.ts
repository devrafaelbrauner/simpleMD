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
  | 'settings'
  | 'next-tab'
  | 'prev-tab';

export interface GlobalKey {
  readonly id: GlobalKeyId;
  /** Notação do CodeMirror (`Mod` = ⌘ no macOS, Ctrl nos demais). */
  readonly key: string;
}

export const GLOBAL_KEYS: readonly GlobalKey[] = [
  { id: 'palette', key: 'Mod-Shift-p' },
  { id: 'side-panel', key: 'Mod-Shift-l' },
  { id: 'ai-palette', key: 'Mod-Shift-a' },
  { id: 'export-pdf', key: 'Mod-p' },
  { id: 'close-tab', key: 'Mod-w' },
  { id: 'open-vault', key: 'Mod-o' },
  { id: 'settings', key: 'Mod-,' },
  { id: 'next-tab', key: 'Ctrl-Tab' },
  { id: 'prev-tab', key: 'Ctrl-Shift-Tab' },
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
