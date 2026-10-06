import { useRef } from 'react';
import { AlertDialog } from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';

export interface UnsavedCloseDialogProps {
  /** Caminhos que não puderam ser gravados; `null` = diálogo fechado. */
  paths: readonly string[] | null;
  onBack(): void;
  onDiscard(): void;
}

/**
 * L4 ALTERAÇÕES NÃO SALVAS (OQ-1 = sim; DESIGN §8.7): descartar é sempre uma ação explícita.
 * Foco inicial e Esc = "Voltar".
 */
export function UnsavedCloseDialog({ paths, onBack, onDiscard }: UnsavedCloseDialogProps) {
  const back = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      open={paths !== null}
      data-testid="unsaved-close-dialog"
      initialFocus={back}
      onEscape={onBack}
      title="Algumas alterações não foram salvas"
      description={
        <p>Não foi possível gravar estes arquivos. Fechar agora descarta as alterações deles.</p>
      }
      footer={
        <>
          <Button variant="secondary" data-testid="unsaved-close-discard" onClick={onDiscard}>
            Fechar sem salvar
          </Button>
          <Button ref={back} variant="primary" data-testid="unsaved-close-back" onClick={onBack}>
            Voltar
          </Button>
        </>
      }
    >
      <ul className="smd-filelist">
        {paths?.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>
    </AlertDialog>
  );
}
