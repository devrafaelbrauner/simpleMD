import type { PluginEventMap, PluginEventName, Unsubscribe } from '../types';

export const PLUGIN_EVENTS: readonly PluginEventName[] = ['file:open', 'file:save', 'vault:change'];

export type AppEventListener = <E extends PluginEventName>(
  evt: E,
  payload: PluginEventMap[E],
) => void;

/**
 * Barramento de eventos do app (arch-frontend r2 §6): o `SyncController` emite, o host de plugins
 * (e, nas próximas etapas, o índice) escuta. Uma única fonte de eventos de arquivo.
 */
export class AppEventBus {
  readonly #listeners = new Set<AppEventListener>();

  emit<E extends PluginEventName>(evt: E, payload: PluginEventMap[E]): void {
    for (const listener of [...this.#listeners]) listener(evt, payload);
  }

  subscribe(listener: AppEventListener): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
