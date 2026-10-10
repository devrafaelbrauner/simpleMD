import { Facet, Prec, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { appPlatformFacet, type EditorPlatform } from '../assembly/platform';

/**
 * Modelo da tecla Tab com a chave "Tecla Tab no editor" ligada (arch-ux §6.1; arch-frontend r7
 * §4.5, D-R7-F09; WCAG 2.1.2). T1 = Tab indenta (cadeia de contexto); T2 = Tab move o foco
 * (`EditorView.setTabFocusMode`). T1/T2 é estado do `EditorView` (um só, regra 5): vale para todas
 * as abas na sessão e não persiste. As três saídas do editor pelo teclado:
 * 1. o alternador (`Ctrl-M`; macOS `⌥⇧M`, a mesma tecla do `defaultKeymap`), anunciado;
 * 2. Esc e depois Tab/Shift-Tab em até 2 s (armado por um observador, mesmo que o Vim, o popup ou
 *    as paradas consumam o Escape);
 * 3. os atalhos globais da janela (`Mod-O`, paleta, …), que nunca passam pelo editor.
 */
export type TabMode = 'indent' | 'focus';

/** Id do elemento (do app, visualmente oculto) que descreve o modo atual (`aria-describedby`). */
export const TAB_HELP_ID = 'smd-editor-tab-help';

/** Textos STR-158 (vinculantes: T1, alternância e paleta). */
export const TAB_FOCUS_TEXT = {
  announceFocus: 'Tab move o foco',
  announceIndent: 'Tab indenta',
  command: 'Tab: alternar entre indentar e mover o foco',
  disabledReason: 'Ligue “Tecla Tab no editor” em Configurações → Editor.',
} as const;

/** Atalho falado (palavras, não símbolos: leitores de tela leem ⌥⇧ de forma inconsistente). */
export const SPOKEN_TOGGLE: Record<EditorPlatform, string> = {
  mac: 'Option+Shift+M',
  other: 'Ctrl+M',
};

/** Atalho do alternador em notação do CodeMirror, por plataforma (rótulo ⌥⇧M / Ctrl+M). */
export const TAB_FOCUS_HOTKEY: Record<EditorPlatform, string> = {
  mac: 'Alt-Shift-m',
  other: 'Ctrl-m',
};

/** Descrição `aria-describedby` do conteúdo do editor no modo atual (STR-158). */
export function tabModeDescription(mode: TabMode, platform: EditorPlatform): string {
  const key = SPOKEN_TOGGLE[platform];
  return mode === 'indent'
    ? `Tab indenta. Para sair do editor: Esc e depois Tab, ou ${key}.`
    : `Tab move o foco. Para Tab voltar a indentar: ${key}.`;
}

interface MirrorEntry {
  mode: TabMode;
  /** A descrição já foi anunciada na primeira entrada de foco desde que a chave foi ligada. */
  announced: boolean;
}

/**
 * Espelho do modo de foco do CodeMirror (`inputState.tabFocusMode` é interno): T1/T2 por
 * `EditorView`, sobrevive a `setState` (troca de aba) como o próprio estado do CM.
 */
const mirror = new WeakMap<EditorView, MirrorEntry>();

/**
 * Observadores de T1↔T2 (barra de status do app). Ficam no estado do editor (serviço do
 * `EditorHost`), não num registro global do módulo: valem só para as views desse host e somem com
 * ele (CR-ST-13).
 */
export const tabFocusObserver = Facet.define<(view: EditorView, mode: TabMode) => void>();

function entryOf(view: EditorView): MirrorEntry {
  let entry = mirror.get(view);
  if (!entry) {
    entry = { mode: 'indent', announced: false };
    mirror.set(view, entry);
  }
  return entry;
}

export function tabFocusMode(view: EditorView): TabMode {
  return mirror.get(view)?.mode ?? 'indent';
}

function setMode(view: EditorView, mode: TabMode): void {
  entryOf(view).mode = mode;
  view.setTabFocusMode(mode === 'focus');
  for (const observer of view.state.facet(tabFocusObserver)) observer(view, mode);
}

/**
 * A chave foi ligada (ou desligada): volta a T1, o CM sai do modo de foco persistente e a próxima
 * entrada de foco anuncia de novo a descrição.
 */
export function resetTabFocus(view: EditorView): void {
  entryOf(view).announced = false;
  setMode(view, 'indent');
}

/** Alterna T1↔T2 e anuncia "Tab move o foco" / "Tab indenta" (comando e tecla). */
export function toggleTabFocusAnnounced(view: EditorView): boolean {
  const next: TabMode = tabFocusMode(view) === 'indent' ? 'focus' : 'indent';
  setMode(view, next);
  view.dispatch({
    effects: EditorView.announce.of(
      next === 'focus' ? TAB_FOCUS_TEXT.announceFocus : TAB_FOCUS_TEXT.announceIndent,
    ),
  });
  return true;
}

/** A tecla do alternador na plataforma (`keyCode`/`code`: ⌥⇧M no macOS produz "Â"). */
export function isTabFocusToggleKey(event: KeyboardEvent, platform: EditorPlatform): boolean {
  if (event.code !== 'KeyM' && event.keyCode !== 77) return false;
  if (event.metaKey) return false;
  return platform === 'mac'
    ? event.altKey && event.shiftKey && !event.ctrlKey
    : event.ctrlKey && !event.altKey && !event.shiftKey;
}

/**
 * Tudo o que existe só com a chave ligada (vai no compartimento `#hostKeys`): o alternador antes
 * do Vim (sombreia o `toggleTabFocusMode` silencioso do `defaultKeymap`), o observador do Esc, a
 * descrição `aria-describedby` e o anúncio da primeira entrada de foco.
 */
export const tabFocusExtension: Extension = [
  Prec.highest(
    EditorView.domEventHandlers({
      keydown(event, view) {
        if (event.isComposing || !isTabFocusToggleKey(event, view.state.facet(appPlatformFacet)))
          return false;
        event.preventDefault();
        return toggleTabFocusAnnounced(view);
      },
    }),
  ),
  EditorView.domEventObservers({
    keydown(event, view) {
      // Com o modo persistente (T2) o CM ignora o tempo e mantém o persistente.
      if (event.key === 'Escape') view.setTabFocusMode(2000);
    },
    focus(_event, view) {
      const entry = entryOf(view);
      if (entry.announced) return;
      entry.announced = true;
      // Fora do evento: o foco pode chegar por `view.focus()` no fim de outra atualização.
      queueMicrotask(() =>
        view.dispatch({
          effects: EditorView.announce.of(
            tabModeDescription(entry.mode, view.state.facet(appPlatformFacet)),
          ),
        }),
      );
    },
  }),
  EditorView.contentAttributes.of({ 'aria-describedby': TAB_HELP_ID }),
];
