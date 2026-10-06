import { useEffect, useRef } from 'react';
import { Button } from '../components/ui/button';
import { Icon } from '../lib/icons';
import { MOD_ARIA, MOD_LABEL } from '../lib/platform-keys';

/** `folder` falta quando o próprio diálogo falhou antes de devolver uma pasta. */
export type WelcomeError = { kind: 'denied' } | { kind: 'io'; folder?: string };

export interface WelcomeProps {
  /** Diálogo de pasta aberto ou primeira listagem em andamento (WEL-PICKING). */
  opening: boolean;
  error: WelcomeError | null;
  onOpenVault(): void;
}

/** V1 WELCOME (arch-ux §4.2, DESIGN §8.9): nenhuma pasta aberta. */
export function Welcome({ opening, error, onOpenVault }: WelcomeProps) {
  const openButton = useRef<HTMLButtonElement>(null);

  // Foco inicial em "Abrir pasta…" e de volta a ele depois de um erro (WEL-INITIAL, WEL-DENIED).
  useEffect(() => {
    if (!opening) openButton.current?.focus();
  }, [opening, error]);

  return (
    <div className="smd-welcome">
      <header className="smd-toolbar" />
      <main className="smd-welcome-main">
        <div className="smd-welcome-col">
          <h1 className="smd-wordmark">simpleMD</h1>
          <p className="smd-lead">Abra uma pasta com arquivos .md para começar.</p>
          <Button
            ref={openButton}
            variant="primary"
            data-testid="open-vault"
            aria-keyshortcuts={`${MOD_ARIA}+O`}
            aria-disabled={opening || undefined}
            onClick={onOpenVault}
          >
            <Icon name="folder" />
            Abrir pasta…
          </Button>
          <span className="smd-hint">
            <kbd className="smd-kbd">{MOD_LABEL}O</kbd> abre uma pasta
          </span>
          <div className="smd-ialert" role="alert" data-testid="welcome-error">
            {error && (
              <>
                <Icon name="warn" />
                <div>
                  {error.kind === 'denied' ? (
                    <>
                      <p>Sem permissão para acessar esta pasta.</p>
                      <div className="smd-ialert-actions">
                        <Button variant="secondary" onClick={onOpenVault}>
                          Escolher outra pasta…
                        </Button>
                      </div>
                    </>
                  ) : (
                    <p>
                      {error.folder === undefined
                        ? 'Não foi possível abrir a pasta.'
                        : `Não foi possível abrir “${error.folder}”.`}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
