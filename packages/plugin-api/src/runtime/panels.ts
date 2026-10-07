import type { Unsubscribe } from '../types';
import { Observable } from './observable';

/**
 * Painel de plugin (R-6.11, arch-frontend r2 §5.2–§5.3). O elemento é criado UMA vez pelo host e
 * sobrevive a esconder/mostrar a aba; `render(el)` roda uma única vez, na primeira exibição.
 */
export interface PluginPanel {
  /** `<pluginId>:<id>`. */
  readonly id: string;
  readonly title: string;
  readonly pluginId: string;
  readonly pluginName: string;
  readonly el: HTMLElement;
  readonly render: (el: HTMLElement) => void;
  rendered: boolean;
  /** `render` lançou: a região mostra STR-81. */
  failed: boolean;
}

export class PanelRegistry extends Observable<readonly PluginPanel[]> {
  readonly #panels: PluginPanel[] = [];
  /** Chamado quando `render` lança (o host registra a falha do plugin). */
  onRenderError: ((panel: PluginPanel, error: unknown) => void) | null = null;

  constructor() {
    super([]);
  }

  /** Lança se o id já existe. A remoção esvazia o elemento e tira a aba. */
  add(panel: PluginPanel): Unsubscribe {
    if (this.#panels.some((p) => p.id === panel.id))
      throw new Error(`painel “${panel.id}” já registrado`);
    this.#panels.push(panel);
    this.publish([...this.#panels]);
    return () => {
      const index = this.#panels.indexOf(panel);
      if (index === -1) return;
      this.#panels.splice(index, 1);
      panel.el.replaceChildren();
      this.publish([...this.#panels]);
    };
  }

  /** Primeira exibição: chama `render(el)` uma vez, isolando a falha (AC-6.12, AC-6.18). */
  ensureRendered(id: string): void {
    const panel = this.#panels.find((p) => p.id === id);
    if (!panel || panel.rendered) return;
    panel.rendered = true;
    try {
      panel.render(panel.el);
    } catch (error) {
      panel.failed = true;
      this.publish([...this.#panels]);
      this.onRenderError?.(panel, error);
    }
  }
}
