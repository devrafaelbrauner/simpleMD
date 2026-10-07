import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useRef, useState } from 'react';
import { Button } from '../components/ui/button';
import { Icon } from '../lib/icons';
import { hotkeyAria, hotkeyLabel } from '../lib/platform-keys';

export type ExportMenuKind = 'md' | 'html' | 'pdf';

export interface ExportMenuProps {
  /** Motivo STR-115 quando não há aba: os itens ficam `aria-disabled`, focáveis, com o motivo. */
  disabledReason: string | null;
  /** Uma exportação em andamento: "Exportar" fica `aria-disabled` e o menu não abre. */
  busy: boolean;
  onSelect(kind: ExportMenuKind): void;
}

/** STR-114 (vinculante; R-10.1). */
const ITEMS: ReadonlyArray<{ kind: ExportMenuKind; label: string; hotkey?: string }> = [
  { kind: 'md', label: 'Exportar como Markdown…' },
  { kind: 'html', label: 'Exportar como HTML…' },
  { kind: 'pdf', label: 'Exportar como PDF…', hotkey: 'Mod-p' },
];

/**
 * M1 menu "Exportar" (DESIGN §8.11, §8.16; arch-ux r2 UX-R2-D13): botão-menu da barra e um
 * `role="menu"` com os 3 itens. Itens desabilitados NÃO usam o `disabled` do Radix (sairiam da
 * navegação por setas): ficam `aria-disabled` com a segunda linha do motivo e não agem. A ação
 * escolhida roda depois que o menu fecha e o foco volta ao "Exportar" (o L7 devolve o foco a ele).
 */
export function ExportMenu({ disabledReason, busy, onSelect }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const pending = useRef<ExportMenuKind | null>(null);
  return (
    <DropdownMenu.Root open={open} onOpenChange={(next) => setOpen(next && !busy)} modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          data-testid="export-menu"
          aria-disabled={busy || undefined}
          aria-describedby={busy ? 'export-busy-reason' : undefined}
        >
          <Icon name="export" />
          Exportar
          <Icon name="chevron-down" />
        </Button>
      </DropdownMenu.Trigger>
      {busy && (
        <span id="export-busy-reason" className="sr-only">
          Exportação em andamento.
        </span>
      )}
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="smd-menu"
          role="menu"
          aria-label="Exportar"
          data-testid="export-menu-list"
          align="end"
          sideOffset={4}
          loop={false}
          onCloseAutoFocus={() => {
            const kind = pending.current;
            pending.current = null;
            // O Radix já devolveu o foco ao "Exportar": agora a ação pode abrir o L7 ou o diálogo.
            if (kind) requestAnimationFrame(() => onSelect(kind));
          }}
        >
          {ITEMS.map((item) => {
            const reasonId = `export-${item.kind}-reason`;
            return (
              <DropdownMenu.Item
                key={item.kind}
                className="smd-menu-item"
                data-testid={`export-${item.kind}`}
                aria-disabled={disabledReason !== null || undefined}
                aria-describedby={disabledReason !== null ? reasonId : undefined}
                {...(item.hotkey ? { 'aria-keyshortcuts': hotkeyAria(item.hotkey) } : {})}
                onSelect={(event) => {
                  if (disabledReason !== null) {
                    event.preventDefault();
                    return;
                  }
                  pending.current = item.kind;
                }}
              >
                <span className="smd-menu-label">{item.label}</span>
                {item.hotkey ? (
                  <kbd className="smd-kbd" aria-hidden="true">
                    {hotkeyLabel(item.hotkey)}
                  </kbd>
                ) : (
                  <span />
                )}
                {disabledReason !== null && (
                  <span id={reasonId} className="smd-menu-why">
                    {disabledReason}
                  </span>
                )}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
