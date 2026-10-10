import { Facet, type EditorState } from '@codemirror/state';
import { noteContext } from '../assembly/note-context';
import { wikilinkCreatePath, type WikilinkResolution } from './resolve';

/**
 * Fachada do app sobre o índice do vault para o editor (arch-frontend r7 §6): resolução, versão
 * (muda quando a resolução pode mudar: o conjunto de notas mudou) e assinatura.
 */
export interface WikilinkIndex {
  resolve(target: string, fromPath: string | null): WikilinkResolution;
  readonly version: number;
  subscribe(listener: () => void): () => void;
}

/** Sem índice (demo, prévia de temas, testes do núcleo): nenhuma nota existe. */
export const wikilinkIndexFacet = Facet.define<WikilinkIndex, WikilinkIndex | null>({
  combine: (values) => values[0] ?? null,
});

/**
 * Resolução de um alvo a partir da nota do editor. Alvo vazio (`[[#Título]]`) é a própria nota;
 * sem índice, o alvo é inexistente (o caminho de criação segue a regra R-I2.5).
 */
export function resolveInEditor(state: EditorState, target: string): WikilinkResolution {
  const fromPath = state.facet(noteContext).path;
  const index = state.facet(wikilinkIndexFacet);
  if (index) return index.resolve(target, fromPath);
  if (target.trim() === '' && fromPath !== null)
    return { kind: 'resolved', path: fromPath, others: [], otherCount: 0 };
  return { kind: 'missing', createPath: wikilinkCreatePath(target, fromPath) };
}
