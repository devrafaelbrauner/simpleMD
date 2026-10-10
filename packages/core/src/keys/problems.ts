import { Facet } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * Comandos de diagnósticos (arch-frontend r7 §10.2 item 6, DA-R7-13): `diagnostics-ui` (S5; S8
 * importa a MESMA constante) declara uma vez; os comandos `problems:panel|next|prev` da paleta
 * são builtins do app que chamam esta facet, sem o app importar `@codemirror/lint` na entrada.
 * Ausente (`null`) = nem lint nem LanguageTool ligados.
 */
export interface ProblemsCommands {
  openPanel(view: EditorView): boolean;
  next(view: EditorView): boolean;
  prev(view: EditorView): boolean;
}

export const problemsCommandsFacet = Facet.define<ProblemsCommands, ProblemsCommands | null>({
  combine: (values) => values[0] ?? null,
});
