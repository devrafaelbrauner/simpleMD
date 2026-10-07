import { useLayoutEffect, useRef, type KeyboardEvent, type Ref } from 'react';

/** Painel de plugin: o elemento persistente criado pelo host (o React nunca renderiza dentro). */
export interface SidePanelPluginTab {
  readonly id: string;
  readonly title: string;
  readonly pluginName: string;
  readonly el: HTMLElement;
  readonly failed: boolean;
  /** Chama `render(el)` uma única vez, na primeira exibição (AC-6.12). */
  ensureRendered(): void;
}

export interface SidePanelProps {
  open: boolean;
  /** Painéis na ordem de UX-R2-D3 (na etapa 6, só os de plugin). */
  panels: readonly SidePanelPluginTab[];
  activeId: string | null;
  onActivate(id: string): void;
  tablistRef?: Ref<HTMLDivElement>;
}

export const sideTabDomId = (id: string) => `side-tab-${id.replace(/[^\w-]/g, '_')}`;

/**
 * C4 PAINEL LATERAL (R-6.19; arch-ux r2 UX-R2-D2…D4; DESIGN §8.11): `<aside>` sempre montado
 * (`hidden` quando fechado), lista de abas "Painéis" com ativação automática e ←/→/Home/End; cada
 * painel numa `region` nomeada pelo título. Sem painéis: STR-54 e nenhuma `tablist`.
 */
export function SidePanel({ open, panels, activeId, onActivate, tablistRef }: SidePanelProps) {
  const active = panels.find((panel) => panel.id === activeId) ?? panels[0] ?? null;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = panels.findIndex((panel) => panel === active);
    const target =
      event.key === 'ArrowRight'
        ? panels[(index + 1) % panels.length]
        : event.key === 'ArrowLeft'
          ? panels[(index - 1 + panels.length) % panels.length]
          : event.key === 'Home'
            ? panels[0]
            : event.key === 'End'
              ? panels[panels.length - 1]
              : undefined;
    if (!target) return;
    event.preventDefault();
    onActivate(target.id);
    requestAnimationFrame(() => document.getElementById(sideTabDomId(target.id))?.focus());
  };
  return (
    <aside
      id="side-panel"
      className="smd-sidepanel"
      aria-label="Painel lateral"
      data-testid="side-panel"
      hidden={!open}
    >
      {active === null ? (
        <p className="smd-sidepanel-empty">Nenhum painel disponível.</p>
      ) : (
        <>
          <div
            ref={tablistRef}
            role="tablist"
            aria-label="Painéis"
            className="smd-tablist smd-sidepanel-tabs"
            onKeyDown={onKeyDown}
          >
            {panels.map((panel) => {
              const selected = panel === active;
              return (
                <div
                  key={panel.id}
                  id={sideTabDomId(panel.id)}
                  role="tab"
                  className="smd-tab smd-side-tab"
                  aria-selected={selected}
                  aria-controls="side-panel-body"
                  tabIndex={selected ? 0 : -1}
                  data-testid="side-tab"
                  data-panel-id={panel.id}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onActivate(panel.id);
                    (event.currentTarget as HTMLElement).focus();
                  }}
                >
                  <span className="smd-tab-label">{panel.title}</span>
                </div>
              );
            })}
          </div>
          <div
            id="side-panel-body"
            role="tabpanel"
            aria-labelledby={sideTabDomId(active.id)}
            className="smd-sidepanel-body"
          >
            {open && <PluginPanelHost key={active.id} panel={active} />}
          </div>
        </>
      )}
    </aside>
  );
}

/**
 * Hospeda o elemento persistente do plugin dentro de uma `region` nomeada pelo título (tabbable,
 * para o axe `scrollable-region-focusable`; UX-R2-D4). Esconder a aba só desanexa o elemento.
 */
function PluginPanelHost({ panel }: { panel: SidePanelPluginTab }) {
  const slot = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const host = slot.current;
    if (!host || panel.failed) return;
    host.appendChild(panel.el);
    panel.ensureRendered();
    return () => {
      if (panel.el.parentNode === host) host.removeChild(panel.el);
    };
  }, [panel]);
  return (
    <section
      ref={slot}
      role="region"
      aria-label={panel.title}
      tabIndex={0}
      className="smd-plugin-panel"
      data-testid="plugin-panel"
    >
      {panel.failed && <p>O plugin “{panel.pluginName}” não conseguiu desenhar este painel.</p>}
    </section>
  );
}
