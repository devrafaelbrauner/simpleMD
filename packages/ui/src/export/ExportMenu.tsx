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

/** Candidatos à sequência de Tab (sem desabilitados); `isTabbable` tira os que o navegador pula. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]';

/**
 * G-01: fora da sequência de Tab ficam `tabindex="-1"`, árvores ocultas e o que o CSS esconde
 * (`display: none` num ancestral, `visibility: hidden` herdada). Sem `checkVisibility()`: o WebKit
 * do Safari 16 não tem.
 */
function isTabbable(el: HTMLElement): boolean {
  if (el.tabIndex < 0 || el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  for (let node: Element | null = el; node; node = node.parentElement)
    if (getComputedStyle(node).display === 'none') return false;
  return getComputedStyle(el).visibility !== 'hidden';
}

/**
 * M1 menu "Exportar" (DESIGN §8.11, §8.16; arch-ux r2 UX-R2-D13): botão-menu da barra e um
 * `role="menu"` com os 3 itens. Itens desabilitados NÃO usam o `disabled` do Radix (sairiam da
 * navegação por setas): ficam `aria-disabled` com a segunda linha do motivo e não agem. A ação
 * escolhida roda depois que o menu fecha e o foco volta ao "Exportar" (o L7 devolve o foco a ele).
 * Tab fecha o menu e leva o foco ao elemento seguinte ao "Exportar"; Shift+Tab e Esc o devolvem
 * ao "Exportar" (arch-ux §6.2 M1, A11Y-R2-04; o Radix sozinho só impede o Tab).
 */
export function ExportMenu({ disabledReason, busy, onSelect }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const pending = useRef<ExportMenuKind | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  /** O menu fechou por Tab (para a frente). */
  const tabbedOut = useRef(false);
  return (
    <DropdownMenu.Root open={open} onOpenChange={(next) => setOpen(next && !busy)} modal={false}>
      <DropdownMenu.Trigger asChild ref={trigger}>
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
          onKeyDown={(event) => {
            if (event.key !== 'Tab') return;
            event.preventDefault();
            tabbedOut.current = !event.shiftKey;
            setOpen(false);
          }}
          onCloseAutoFocus={(event) => {
            const kind = pending.current;
            pending.current = null;
            const forward = tabbedOut.current;
            tabbedOut.current = false;
            if (forward && trigger.current) {
              const all = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)];
              const at = all.indexOf(trigger.current);
              const next = at < 0 ? undefined : all.slice(at + 1).find(isTabbable);
              if (next) {
                event.preventDefault();
                next.focus();
                return;
              }
            }
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
