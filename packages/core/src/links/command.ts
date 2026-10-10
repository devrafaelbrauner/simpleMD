import { Prec, type Extension } from '@codemirror/state';
import { keymap, type Command } from '@codemirror/view';
import { linkAt } from './at-pos';
import { linkOpenerFacet } from './opener';

/**
 * "Abrir link sob o cursor" (`link:open-under-cursor`, `Alt-Enter`; R-I1.2, UX-R7-D8): a mesma
 * chamada do ⌘/Ctrl-clique para o link onde está a cabeça da seleção; sem link → aviso info
 * "Nenhum link sob o cursor." (STR-137). Sem serviço do app, não age.
 */
export const openLinkAtCursor: Command = (view) => {
  const opener = view.state.facet(linkOpenerFacet);
  if (!opener) return false;
  const info = linkAt(view.state, view.state.selection.main.head);
  if (info) opener.open(info.target, view);
  else opener.noLink();
  return true;
};

/** `Alt-Enter` no núcleo (`Prec.high`, arch-frontend §4.2 camada 9). */
export function linkKeymap(): Extension {
  return Prec.high(keymap.of([{ key: 'Alt-Enter', run: openLinkAtCursor }]));
}
