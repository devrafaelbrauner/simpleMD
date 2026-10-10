import type { Extension } from '@codemirror/state';
import { indentContextAction, tabChainKeymap } from './context-chain';
import { listIndentAction } from './list-indent';
import { tabFocusExtension } from './tab-focus';

export {
  contextAction,
  contextActionFacet,
  contextChainKeymap,
  indentContextAction,
  runContextChain,
  tabChainKeymap,
  type ContextAction,
  type ContextKind,
  type ContextSlot,
} from './context-chain';
export { escapeArbiter, escapeHandler, escapeHandlerFacet, type EscapeOwner } from './escape';
export { interactFacet, runInteract, type InteractHandler } from './interact';
export { listIndentAction } from './list-indent';
export { problemsCommandsFacet, type ProblemsCommands } from './problems';
export {
  isTabFocusToggleKey,
  resetTabFocus,
  SPOKEN_TOGGLE,
  TAB_FOCUS_HOTKEY,
  TAB_FOCUS_TEXT,
  TAB_HELP_ID,
  tabFocusObserver,
  tabFocusExtension,
  tabFocusMode,
  tabModeDescription,
  toggleTabFocusAnnounced,
  type TabMode,
} from './tab-focus';

/**
 * Contribuições do núcleo à cadeia de contexto, sempre presentes na pilha do markdown (ponto de
 * registro ST → S3: uma linha por contribuição; S6/S7 registram por `host.editor.contextAction`).
 */
export const coreContextActions: Extension = [listIndentAction, indentContextAction];

/** Só com `editor.captureTab` ligado (compartimento `#hostKeys`): Tab pela cadeia + modo de foco. */
export const captureTabExtension: Extension = [tabChainKeymap, tabFocusExtension];
