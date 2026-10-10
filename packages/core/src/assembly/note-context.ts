import { Facet } from '@codemirror/state';

/**
 * Contexto da nota de cada aba (r7 D-R7-F25): o caminho relativo ao vault (com `/`) de onde o
 * estado foi criado, ou `null` no estado sem aba. Lido pelo live preview (imagens e links `.md`
 * relativos, S1) e por quem resolve destinos a partir da nota. Entra por `createState` do
 * `EditorHost` e nunca muda dentro de um estado (outra aba = outro estado).
 */
export interface NoteContext {
  readonly path: string | null;
}

const NO_NOTE: NoteContext = { path: null };

export const noteContext = Facet.define<NoteContext, NoteContext>({
  combine: (values) => values[0] ?? NO_NOTE,
});
