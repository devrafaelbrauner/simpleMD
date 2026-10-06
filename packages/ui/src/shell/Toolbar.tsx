import type { Ref } from 'react';
import { Button } from '../components/ui/button';
import { Icon } from '../lib/icons';
import { MOD_ARIA } from '../lib/platform-keys';

export interface ToolbarProps {
  vaultName: string;
  onOpenVault(): void;
  onOpenSettings(): void;
  openButtonRef?: Ref<HTMLButtonElement>;
}

/** Botão de engrenagem "Configurações" (STR-04), à direita da barra; atalho `Mod-,`. */
export function SettingsButton({ onOpenSettings }: { onOpenSettings(): void }) {
  return (
    <Button
      variant="icon"
      className="smd-toolbar-gear"
      aria-label="Configurações"
      data-testid="open-settings"
      aria-keyshortcuts={`${MOD_ARIA}+,`}
      onClick={onOpenSettings}
    >
      <Icon name="gear" />
    </Button>
  );
}

/** Barra da casca (DESIGN §6): "Abrir pasta…", o nome do vault e a engrenagem. */
export function Toolbar({ vaultName, onOpenVault, onOpenSettings, openButtonRef }: ToolbarProps) {
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
      <SettingsButton onOpenSettings={onOpenSettings} />
    </header>
  );
}
