import type { Unsubscribe } from '../types';

/**
 * Store simples para `useSyncExternalStore`: o React lê `getSnapshot()` e assina mudanças sem que
 * nenhum tipo do React entre neste pacote (regra 3).
 */
export class Observable<S> {
  readonly #listeners = new Set<() => void>();
  #snapshot: S;

  constructor(initial: S) {
    this.#snapshot = initial;
  }

  readonly getSnapshot = (): S => this.#snapshot;

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  protected publish(snapshot: S): void {
    this.#snapshot = snapshot;
    for (const listener of [...this.#listeners]) listener();
  }
}
