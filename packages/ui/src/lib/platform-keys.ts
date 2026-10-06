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
