import { Prec, type Extension } from '@codemirror/state';
import { keymap, type Command } from '@codemirror/view';
import { runInteract } from '../keys/interact';

/**
 * "Interagir com o elemento sob o cursor" (`editor:interact`, `Mod-Shift-Enter`; UX-R7-D5,
 * DA-R7-27): leva o foco para o widget/cartão do bloco onde está o cursor, pelos alvos registrados
 * em `interactFacet` (W2 cartão do problema → W3 consulta → W4 HTML). Sem alvo, nada acontece e a
 * tecla segue para o CM.
 */
export const interactWithElement: Command = runInteract;

/** `Mod-Shift-Enter` no núcleo (`Prec.high`, arch-frontend §4.2 camada 9). */
export function interactKeymap(): Extension {
  return Prec.high(keymap.of([{ key: 'Mod-Shift-Enter', run: interactWithElement }]));
}
