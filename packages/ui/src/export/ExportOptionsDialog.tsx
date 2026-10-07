import { useEffect, useRef } from 'react';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Icon } from '../lib/icons';

export interface ExportOptionsDialogProps {
  /** `null` = fechado. */
  options: {
    readonly hasFrontMatter: boolean;
    /** STR-117 quando o destino escolhido é o próprio arquivo de origem. */
    readonly error: string | null;
    /** O diálogo de salvar está aberto. */
    readonly picking: boolean;
  } | null;
  onCancel(): void;
  onChoose(stripFrontMatter: boolean): void;
}

/** STR-116: dica quando a nota não tem front matter. */
const NO_FRONT_MATTER = 'Esta nota não tem front matter; a opção não muda nada.';

/**
 * L7 "Exportar como Markdown" (DESIGN §8.16, arch-ux r2 F19): caixa "Sem front matter" (foco
 * inicial), dica STR-116 só sem front matter, alerta em linha STR-117 (focado quando aparece) e
 * `[Cancelar] [Escolher destino…]`. Dispensável: Esc e clique fora cancelam (UX-R2-D27). O diálogo
 * de salvar roda com o L7 aberto; cancelar volta aqui em silêncio. A caixa não é controlada: o
 * conteúdo do diálogo desmonta ao fechar, então cada abertura começa desmarcada.
 */
export function ExportOptionsDialog({ options, onCancel, onChoose }: ExportOptionsDialogProps) {
  const checkbox = useRef<HTMLInputElement>(null);
  const alert = useRef<HTMLDivElement>(null);
  const open = options !== null;
  const error = options?.error ?? null;

  useEffect(() => {
    if (error !== null) alert.current?.focus();
  }, [error]);

  const picking = options?.picking ?? false;
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title="Exportar como Markdown"
      initialFocus={checkbox}
      className="smd-export-options"
      data-testid="export-options"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            data-testid="export-choose"
            aria-disabled={picking || undefined}
            onClick={() => onChoose(checkbox.current?.checked ?? false)}
          >
            Escolher destino…
          </Button>
        </>
      }
    >
      <label className="smd-check">
        <input
          ref={checkbox}
          type="checkbox"
          data-testid="export-strip-fm"
          defaultChecked={false}
          aria-describedby={options?.hasFrontMatter === false ? 'export-strip-hint' : undefined}
        />
        Sem front matter
      </label>
      {options?.hasFrontMatter === false && (
        <p id="export-strip-hint" className="smd-hint smd-export-hint">
          {NO_FRONT_MATTER}
        </p>
      )}
      <div
        ref={alert}
        className="smd-ialert smd-export-alert"
        role="alert"
        tabIndex={-1}
        data-testid="export-options-error"
      >
        {error !== null && (
          <>
            <Icon name="warn" />
            <p>{error}</p>
          </>
        )}
      </div>
    </Dialog>
  );
}
