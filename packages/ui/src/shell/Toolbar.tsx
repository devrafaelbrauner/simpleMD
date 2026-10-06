import type { Ref } from 'react';
import { Button } from '../components/ui/button';
import { Icon } from '../lib/icons';
import { MOD_ARIA } from '../lib/platform-keys';

export interface ToolbarProps {
  vaultName: string;
  onOpenVault(): void;
  openButtonRef?: Ref<HTMLButtonElement>;
}

/** Barra da casca (DESIGN §6): "Abrir pasta…" e o nome do vault. */
export function Toolbar({ vaultName, onOpenVault, openButtonRef }: ToolbarProps) {
  return (
    <header className="smd-toolbar">
      <Button
        ref={openButtonRef}
        variant="ghost"
        data-testid="open-vault"
        aria-keyshortcuts={`${MOD_ARIA}+O`}
        onClick={onOpenVault}
      >
        <Icon name="folder" />
        Abrir pasta…
      </Button>
      <span className="smd-toolbar-vault" title={vaultName} data-testid="vault-name">
        {vaultName}
      </span>
    </header>
  );
}
