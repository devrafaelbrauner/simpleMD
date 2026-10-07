import type { Ref } from 'react';
import { Button } from '../components/ui/button';
import { Icon } from '../lib/icons';
import { isMac, MOD_ARIA } from '../lib/platform-keys';

export interface ToolbarProps {
  vaultName: string;
  onOpenVault(): void;
  onOpenSettings(): void;
  /** "Comandos": abre a paleta (D-16; o caminho do ponteiro). */
  onOpenPalette(): void;
  sidePanelOpen: boolean;
  onToggleSidePanel(): void;
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

/**
 * Barra da casca (DESIGN §6.1, §8.11): "Abrir pasta…", o nome do vault e, à direita, "Comandos",
 * "Painel lateral" e a engrenagem (ordem do DOM = ordem visual; UX-R2-D12).
 */
export function Toolbar(props: ToolbarProps) {
  const { vaultName, onOpenVault, onOpenSettings, openButtonRef, sidePanelOpen } = props;
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
      <div className="smd-toolbar-end">
        <Button
          variant="ghost"
          data-testid="open-palette"
          title={isMac ? 'Comandos (⌘⇧P)' : 'Comandos (Ctrl+Shift+P)'}
          aria-keyshortcuts={`${MOD_ARIA}+Shift+P`}
          onClick={props.onOpenPalette}
        >
          <Icon name="command" />
          Comandos
        </Button>
        <Button
          variant="icon"
          className="smd-toolbar-icon"
          aria-label="Painel lateral"
          title={isMac ? 'Painel lateral (⌘⇧L)' : 'Painel lateral (Ctrl+Shift+L)'}
          aria-expanded={sidePanelOpen}
          aria-controls="side-panel"
          aria-keyshortcuts={`${MOD_ARIA}+Shift+L`}
          data-testid="side-panel-toggle"
          onClick={props.onToggleSidePanel}
        >
          <Icon name="panel-right" />
        </Button>
        <SettingsButton onOpenSettings={onOpenSettings} />
      </div>
    </header>
  );
}
