import { useEffect, useLayoutEffect, useRef } from 'react';
import { AlertDialog } from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import { Icon } from '../lib/icons';

export interface ConflictView {
  /** Único por conflito levantado (um mesmo arquivo pode entrar em conflito de novo). */
  readonly id: string;
  /** Nome do arquivo (`nota.md`). */
  readonly name: string;
  readonly reason: 'external-change' | 'save-conflict' | 'deleted';
}

export interface ConflictDialogProps {
  conflict: ConflictView | null;
  /** A cópia de conflito não pôde ser criada (STR-21); o diálogo continua aberto. */
  failed: boolean;
  busy: boolean;
  onKeepBoth(): void;
  onReload(): void;
  /** Chamado uma vez quando o diálogo aparece (log `simplemd:conflict-shown`, NFR-12). */
  onShown(): void;
}

const stemOf = (name: string) => name.replace(/\.[^.]+$/, '');

/**
 * L1 CONFLITO (R-2.10, D-3, DESIGN §8.7): `alertdialog` no topo, foco inicial em "Manter ambos",
 * Esc e clique fora não fazem nada, sem × e sem "Sobrescrever". Um conflito por vez.
 */
export function ConflictDialog({
  conflict,
  failed,
  busy,
  onKeepBoth,
  onReload,
  onShown,
}: ConflictDialogProps) {
  const keepBoth = useRef<HTMLButtonElement>(null);
  const onShownRef = useRef(onShown);
  useLayoutEffect(() => {
    onShownRef.current = onShown;
  });
  const key = conflict?.id ?? null;

  useEffect(() => {
    if (key !== null) onShownRef.current();
  }, [key]);

  const copy = conflict ? `${stemOf(conflict.name)} (conflito AAAA-MM-DD HH-mm-ss).md` : '';
  const deleted = conflict?.reason === 'deleted';
  return (
    <AlertDialog
      open={conflict !== null}
      data-testid="conflict-dialog"
      initialFocus={keepBoth}
      title={`Conflito em “${conflict?.name ?? ''}”`}
      description={
        deleted ? (
          <>
            <p>
              Este arquivo foi removido ou renomeado fora do simpleMD enquanto havia alterações não
              salvas.
            </p>
            <p>Manter ambos: suas alterações vão para “{copy}”; o original não é recriado.</p>
            <p>Recarregar do disco: fecha esta aba e descarta suas alterações.</p>
          </>
        ) : (
          <>
            <p>Este arquivo foi alterado fora do simpleMD enquanto havia alterações não salvas.</p>
            <p>
              Manter ambos: suas alterações vão para um novo arquivo “{copy}”; o original fica com a
              versão do disco.
            </p>
            <p>Recarregar do disco: descarta suas alterações neste arquivo.</p>
          </>
        )
      }
      footer={
        <>
          <Button
            variant="secondary"
            data-testid="conflict-reload"
            aria-disabled={busy || undefined}
            onClick={onReload}
          >
            Recarregar do disco
          </Button>
          <Button
            ref={keepBoth}
            variant="primary"
            data-testid="conflict-keep-both"
            aria-disabled={busy || undefined}
            onClick={onKeepBoth}
          >
            Manter ambos
          </Button>
        </>
      }
    >
      <div className="smd-ialert" role="alert" data-testid="conflict-error">
        {failed && (
          <>
            <Icon name="warn" />
            <p>Não foi possível criar a cópia de conflito. Nenhum arquivo foi alterado.</p>
          </>
        )}
      </div>
    </AlertDialog>
  );
}
