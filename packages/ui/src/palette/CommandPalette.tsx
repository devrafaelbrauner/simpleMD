import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useOutsidePointerRule } from '../components/ui/outside-pointer';

/** Um comando como a paleta o mostra (arch-ux r2 §3.6). */
export interface PaletteItem {
  readonly id: string;
  readonly label: string;
  /** Segunda linha informativa (ex.: "para <idioma>"). */
  readonly detail?: string;
  /** Atalho em notação da plataforma (⌘⇧H / Ctrl+Shift+H), só visual. */
  readonly hotkeyLabel?: string;
  /** `aria-keyshortcuts` (ex.: `Meta+Shift+H`). */
  readonly keyshortcuts?: string;
  /** Presente = desabilitado; o motivo é a segunda linha (e parte do nome acessível). */
  readonly disabledReason?: string;
}

export interface CommandPaletteProps {
  open: boolean;
  /** Texto inicial da busca (`Mod-Shift-A` → `IA: `). */
  initialQuery: string;
  /** Lista na ordem da busca vazia; avaliada ao abrir e a cada mudança da busca. */
  getItems(): readonly PaletteItem[];
  onClose(): void;
  /** Roda no quadro seguinte ao fechamento, com o foco já devolvido (UX-R2-D7). */
  onRun(id: string): void;
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });

/**
 * Filtra sem diferenciar maiúsculas nem acentos (`ola` → "Dizer olá") e ordena por prefixo, depois
 * início de palavra, depois trecho, com empates em ordem alfabética (UX-R2-D6).
 */
export function filterPalette(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const q = fold(query.trim());
  if (q === '') return [...items];
  const ranked: Array<{ item: PaletteItem; rank: number }> = [];
  for (const item of items) {
    const label = fold(item.label);
    const at = label.indexOf(q);
    if (at === -1) continue;
    const wordStart = label.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(q));
    ranked.push({ item, rank: at === 0 ? 0 : wordStart ? 1 : 2 });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || collator.compare(a.item.label, b.item.label))
    .map(({ item }) => item);
}

/**
 * L5 PALETA DE COMANDOS (R-6.18, D-16; arch-ux r2 UX-R2-D5…D7; DESIGN §8.12): diálogo no topo,
 * sem rodapé, combobox "Buscar comando" + listbox "Comandos" (segunda parada de Tab). Esc ou clique
 * fora fecham e devolvem o foco a quem estava com ele.
 */
export function CommandPalette({
  open,
  initialQuery,
  getItems,
  onClose,
  onRun,
}: CommandPaletteProps) {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const [status, setStatus] = useState('');
  // A11Y-R2-03: a busca, a opção ativa e o status voltam ao início no MESMO render que abre a
  // paleta. Feito no `onOpenAutoFocus`, o valor anterior aparecia num quadro e a digitação rápida
  // entrava atrás dele ("IA: ResumirR").
  const [shownOpen, setShownOpen] = useState(open);
  if (open !== shownOpen) {
    setShownOpen(open);
    if (open) {
      setQuery(initialQuery);
      setActive(0);
      setStatus('');
    }
  }
  const content = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useOutsidePointerRule(open, content, onClose);

  // `getItems` é reavaliado a cada abertura e mudança de busca (estado das predicações, §4.1).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => (open ? filterPalette(getItems(), query) : []), [open, query]);
  const current = items[Math.min(active, items.length - 1)];
  const optionId = (index: number) => `palette-opt-${index}`;

  useEffect(() => {
    if (!current) return;
    document
      .getElementById(optionId(items.indexOf(current)))
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [current, items]);

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    if (item.disabledReason) {
      setStatus(item.disabledReason);
      return;
    }
    onClose();
    requestAnimationFrame(() => onRun(item.id));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (items.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive(
        (index) => (Math.min(index, items.length - 1) + step + items.length) % items.length,
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(current);
    }
  };

  const activeId = current ? optionId(items.indexOf(current)) : undefined;
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="smd-overlay" />
        <DialogPrimitive.Content
          ref={content}
          className="smd-dialog smd-palette"
          data-testid="palette"
          aria-modal="true"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            const focused = document.activeElement;
            returnFocus.current = focused instanceof HTMLElement ? focused : null;
            event.preventDefault();
            input.current?.focus();
            // O texto inicial entra no próximo quadro; o cursor vai para o fim (`IA: `).
            requestAnimationFrame(() => {
              const end = input.current?.value.length ?? 0;
              input.current?.setSelectionRange(end, end);
            });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // A11Y-R2-02: se o comando já levou o foco a outro lugar (o cartão da IA, com resposta
            // instantânea pelo ponteiro), a devolução atrasada não o tira de lá.
            const now = document.activeElement;
            const moved =
              now instanceof HTMLElement &&
              now !== document.body &&
              !content.current?.contains(now);
            if (!moved && returnFocus.current?.isConnected) returnFocus.current.focus();
          }}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <DialogPrimitive.Title className="sr-only">Paleta de comandos</DialogPrimitive.Title>
          <div className="smd-palette-head">
            <input
              ref={input}
              className="smd-input smd-palette-input"
              role="combobox"
              aria-label="Buscar comando"
              placeholder="Digite o nome de um comando…"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-autocomplete="list"
              aria-activedescendant={activeId}
              autoComplete="off"
              spellCheck={false}
              data-testid="palette-input"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
                setStatus('');
              }}
              onKeyDown={onKeyDown}
            />
          </div>
          {items.length > 0 && (
            <ul
              ref={list}
              id="palette-list"
              role="listbox"
              aria-label="Comandos"
              aria-activedescendant={activeId}
              tabIndex={0}
              className="smd-palette-list"
              onKeyDown={onKeyDown}
            >
              {items.map((item, index) => {
                const selected = item === current;
                return (
                  <li
                    key={item.id}
                    id={optionId(index)}
                    role="option"
                    aria-selected={selected}
                    aria-disabled={item.disabledReason ? true : undefined}
                    aria-keyshortcuts={item.keyshortcuts}
                    data-testid="palette-option"
                    data-command-id={item.id}
                    className="smd-palette-option"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setActive(index);
                      run(item);
                    }}
                  >
                    <span className="smd-palette-label">
                      {item.label}
                      {(item.disabledReason ?? item.detail) && (
                        <span className="smd-palette-detail">
                          {item.disabledReason ?? item.detail}
                        </span>
                      )}
                    </span>
                    {item.hotkeyLabel && (
                      <kbd className="smd-kbd" aria-hidden="true">
                        {item.hotkeyLabel}
                      </kbd>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="smd-palette-status" role="status">
            {items.length === 0 ? 'Nenhum comando encontrado.' : status}
          </p>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
