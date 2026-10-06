import type { EditorState } from '@codemirror/state';
import type { TextFormat } from '@simplemd/vault';

/** Estado por aba fora do Zustand (arch-frontend §3.3): muda a cada tecla e não é serializável. */
export interface DocumentRecord {
  /** Último `EditorState` desta aba (histórico de desfazer incluso). */
  state: EditorState;
  /** Fim de linha e BOM originais do arquivo (R-2.5). */
  readonly format: TextFormat;
  /** Texto exato (já codificado) que o app leu ou gravou por último. */
  diskText: string;
  mtime: number;
}

type ReplaceListener = (id: string, state: EditorState) => void;

/**
 * Registro aba → documento. `updateState` acompanha o editor (sem eventos); `replace` troca o
 * documento por programa (recarga do disco) e avisa o painel para mostrá-lo se a aba estiver ativa.
 */
export class DocumentRegistry {
  readonly #docs = new Map<string, DocumentRecord>();
  readonly #listeners = new Set<ReplaceListener>();

  get(id: string): DocumentRecord | undefined {
    return this.#docs.get(id);
  }

  set(id: string, record: DocumentRecord): void {
    this.#docs.set(id, record);
  }

  delete(id: string): void {
    this.#docs.delete(id);
  }

  clear(): void {
    this.#docs.clear();
  }

  updateState(id: string, state: EditorState): void {
    const record = this.#docs.get(id);
    if (record) record.state = state;
  }

  replace(id: string, record: DocumentRecord): void {
    this.#docs.set(id, record);
    for (const listener of this.#listeners) listener(id, record.state);
  }

  onReplace(listener: ReplaceListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
