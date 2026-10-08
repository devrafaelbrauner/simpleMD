import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { Icon } from '../lib/icons';
import { MOD_ARIA } from '../lib/platform-keys';

export type TabSaveState = 'clean' | 'dirty' | 'saving' | 'error' | 'conflict';

export interface TabView {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  /** Pasta-mãe mostrada quando há nomes repetidos (TAB-DUPNAME). */
  readonly folder?: string;
  readonly saveState: TabSaveState;
}

export interface TabBarProps {
  tabs: readonly TabView[];
  activeId: string | null;
  onActivate(id: string, options: { focusEditor: boolean }): void;
  onClose(id: string): void;
}

/** Id DOM da aba na posição `index`; o painel usa o mesmo id em `aria-labelledby`. */
export const tabDomId = (index: number) => `tab-${index}`;

const SUFFIX: Record<TabSaveState, string> = {
  clean: '',
  saving: '',
  dirty: ', não salvo',
  error: ', erro ao salvar',
  conflict: ', em conflito',
};

/**
 * C2 ABAS (R-2.8, AC-2.15, DESIGN §8.4). Ativação automática com ←/→/Home/End; Delete fecha a aba
 * focada. O × é um glifo NÃO focável fora da árvore de acessibilidade (UX-D5): um botão dentro de
 * `role=tab` violaria `nested-interactive`. Sem abas não há `role=tablist` (UX-D11).
 */
export function TabBar({ tabs, activeId, onActivate, onClose }: TabBarProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const focusActive = useRef(false);
  const activeIndex = tabs.findIndex((tab) => tab.id === activeId);

  // Mantém a aba ativa visível (rolagem horizontal da faixa) e, após navegação por teclado, focada.
  useLayoutEffect(() => {
    const list = listRef.current;
    const element = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !element) return;
    if (element.offsetLeft < list.scrollLeft) list.scrollLeft = element.offsetLeft;
    else if (element.offsetLeft + element.offsetWidth > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = element.offsetLeft + element.offsetWidth - list.clientWidth;
    }
    if (focusActive.current) {
      focusActive.current = false;
      element.focus();
    }
  }, [activeId, tabs.length]);

  if (tabs.length === 0) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const last = tabs.length - 1;
    const current = Math.max(activeIndex, 0);
    const target =
      event.key === 'ArrowRight'
        ? Math.min(current + 1, last)
        : event.key === 'ArrowLeft'
          ? Math.max(current - 1, 0)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (event.key === 'Delete') {
      event.preventDefault();
      const id = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]')?.dataset.tabId;
      if (id) onClose(id);
      return;
    }
    if (target === null) return;
    event.preventDefault();
    const tab = tabs[target];
    if (!tab) return;
    focusActive.current = true;
    onActivate(tab.id, { focusEditor: false });
  };

  return (
    <div
      ref={listRef}
      className="smd-tablist"
      role="tablist"
      aria-label="Arquivos abertos"
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === activeId;
        const busy = tab.saveState === 'dirty' || tab.saveState === 'saving';
        return (
          <div
            key={tab.id}
            id={tabDomId(index)}
            role="tab"
            className="smd-tab"
            data-testid="tab"
            data-tab-id={tab.id}
            data-path={tab.path}
            data-save-state={tab.saveState}
            aria-selected={selected}
            // Nome explícito: o sufixo num span `sr-only` (posição absoluta) fazia o Chromium inserir um
            // espaço antes da vírgula ("nota.md , não salvo"; EC F-7 / a11y F-6). STR-12.
            aria-label={`${tab.name}${tab.folder !== undefined ? ` · ${tab.folder}` : ''}${SUFFIX[tab.saveState]}`}
            // EC3-A11Y-1: as abas dividem um tabpanel; com ele em todas, o WebKit marcava toda aba
            // como AXSelected quando o foco estava no editor. Só a aba selecionada aponta para ele.
            aria-controls={selected ? 'editor-panel' : undefined}
            aria-keyshortcuts={`${MOD_ARIA}+W Delete`}
            tabIndex={selected ? 0 : -1}
            title={tab.path}
            onClick={() => onActivate(tab.id, { focusEditor: true })}
          >
            <span className="smd-tab-label">
              {tab.name}
              {tab.folder !== undefined && <span className="smd-tab-dup"> · {tab.folder}</span>}
            </span>
            <span className="smd-tab-slot">
              {busy && (
                <span
                  className="smd-tab-glyph smd-tab-dot"
                  data-testid="tab-dirty"
                  aria-hidden="true"
                />
              )}
              {tab.saveState === 'error' && (
                <Icon name="warn" className="smd-tab-glyph smd-tab-glyph-danger" />
              )}
              {tab.saveState === 'conflict' && (
                <Icon name="conflict" className="smd-tab-glyph smd-tab-glyph-danger" />
              )}
              <span
                className="smd-tab-close"
                data-testid="tab-close"
                aria-hidden="true"
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
              >
                <Icon name="close" />
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
