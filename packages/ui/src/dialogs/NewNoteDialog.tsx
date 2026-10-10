import { useEffect, useRef } from 'react';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Icon } from '../lib/icons';

export interface NewNoteDialogProps {
  /** `null` = fechado. */
  state: {
    /** Pasta inicial (`''` = raiz). */
    readonly folder: string;
    /** Alerta em linha: por que a nota não foi criada. */
    readonly error: string | null;
    /** Criação em andamento ("Criar" fica `aria-disabled`). */
    readonly busy: boolean;
  } | null;
  /** Nome da pasta aberta: rótulo da raiz e prefixo das subpastas. */
  vaultName: string;
  /** Subpastas do vault (caminhos com `/`), na ordem do explorador. */
  folders: readonly string[];
  onCancel(): void;
  onCreate(folder: string, name: string): void;
}

/**
 * L8 "Nova nota": "Pasta" (a do item focado no explorador, ou a raiz) e "Nome" (foco inicial);
 * Enter ou "Criar" criam. O alerta em linha diz por que a nota não foi criada e o foco volta ao
 * nome, selecionado, para corrigir. Dispensável: Esc e clique fora cancelam. Os campos não são
 * controlados: o conteúdo do diálogo desmonta ao fechar, então cada abertura começa vazia.
 */
export function NewNoteDialog({
  state,
  vaultName,
  folders,
  onCancel,
  onCreate,
}: NewNoteDialogProps) {
  const name = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLSelectElement>(null);
  const error = state?.error ?? null;
  const busy = state?.busy ?? false;

  useEffect(() => {
    if (error === null) return;
    name.current?.focus();
    name.current?.select();
  }, [error]);

  return (
    <Dialog
      open={state !== null}
      onClose={onCancel}
      title="Nova nota"
      initialFocus={name}
      className="smd-new-note"
      data-testid="new-note-dialog"
      status={
        <div className="smd-ialert" role="alert" data-testid="new-note-error">
          {error !== null && (
            <>
              <Icon name="warn" />
              <p id="new-note-error">{error}</p>
            </>
          )}
        </div>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="new-note-form"
            data-testid="new-note-create"
            aria-disabled={busy || undefined}
          >
            Criar
          </Button>
        </>
      }
    >
      <form
        id="new-note-form"
        className="smd-section"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) onCreate(folder.current?.value ?? '', name.current?.value ?? '');
        }}
      >
        <div className="smd-field">
          <label htmlFor="new-note-folder">Pasta</label>
          <select
            id="new-note-folder"
            ref={folder}
            className="smd-input"
            defaultValue={state?.folder ?? ''}
          >
            <option value="">{vaultName}</option>
            {folders.map((path) => (
              <option key={path} value={path}>
                {`${vaultName}/${path}`}
              </option>
            ))}
          </select>
        </div>
        <div className="smd-field">
          <label htmlFor="new-note-name">Nome</label>
          <input
            id="new-note-name"
            ref={name}
            className="smd-input"
            data-testid="new-note-name"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error !== null || undefined}
            aria-describedby={error === null ? 'new-note-hint' : 'new-note-hint new-note-error'}
          />
          <p id="new-note-hint" className="smd-hint">
            A extensão .md é acrescentada se faltar.
          </p>
        </div>
      </form>
    </Dialog>
  );
}
