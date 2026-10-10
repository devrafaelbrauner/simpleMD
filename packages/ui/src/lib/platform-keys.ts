/**
 * `Mod` = Cmd no macOS e Ctrl nos demais (R-1.2). Detectado uma vez a partir do navegador.
 */
interface NavigatorWithUAData extends Navigator {
  readonly userAgentData?: { readonly platform?: string };
}

export const isMac: boolean =
  typeof navigator !== 'undefined' &&
  /mac/i.test(
    (navigator as NavigatorWithUAData).userAgentData?.platform ?? navigator.platform ?? '',
  );

/** O evento usa o modificador principal da plataforma (sem Alt). */
export function hasMod(event: { metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean {
  return (
    (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && !event.altKey
  );
}

/** Prefixo de `aria-keyshortcuts` para o modificador principal. */
export const MOD_ARIA = isMac ? 'Meta' : 'Control';
/** Rótulo visível do modificador em dicas de atalho. */
export const MOD_LABEL = isMac ? '⌘' : 'Ctrl+';

const MAC_SYMBOL: Record<string, string> = { Mod: '⌘', Meta: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };
const ARIA_NAME: Record<string, string> = {
  Mod: MOD_ARIA,
  Meta: 'Meta',
  Ctrl: 'Control',
  Alt: 'Alt',
  Shift: 'Shift',
};

/** Partes de um atalho em notação do CodeMirror (`Mod-Shift-h` → modificadores + tecla). */
function splitHotkey(key: string): { mods: string[]; name: string } {
  const parts = key.split(/-(?!$)/);
  const last = parts[parts.length - 1] ?? '';
  return { mods: parts.slice(0, -1), name: last.length === 1 ? last.toUpperCase() : last };
}

/** Teclas com símbolo no rótulo visível (arch-ux r7 §3.7: ⌘⌥→, ↩); o `aria-keyshortcuts` usa o nome. */
const KEY_SYMBOL: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
};

/** Atalho visível na plataforma: `⌘⇧H` no macOS, `Ctrl+Shift+H` nos demais (STR-50). */
export function hotkeyLabel(key: string): string {
  const { mods, name: raw } = splitHotkey(key);
  const name = KEY_SYMBOL[raw] ?? (isMac && raw === 'Enter' ? '↩' : raw);
  if (isMac) return `${mods.map((m) => MAC_SYMBOL[m] ?? m).join('')}${name}`;
  return [...mods.map((m) => (m === 'Mod' ? 'Ctrl' : m)), name].join('+');
}

/** Valor de `aria-keyshortcuts` (ex.: `Meta+Shift+H`). */
export function hotkeyAria(key: string): string {
  const { mods, name } = splitHotkey(key);
  return [...mods.map((m) => ARIA_NAME[m] ?? m), name].join('+');
}
