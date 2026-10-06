import type { AppPlatform } from '../platform/types';
import { DocumentRegistry } from '../state/documents';
import { createAppStore, type AppStore } from '../state/store';
import { SyncController, systemClock, type Clock } from '../state/sync';

/** Tudo o que a UI recebe: store, motor de sincronização, registro de documentos e plataforma. */
export interface AppController {
  readonly platform: AppPlatform;
  readonly store: AppStore;
  readonly registry: DocumentRegistry;
  readonly sync: SyncController;
}

/** Monta o app sobre uma plataforma (Tauri em produção; memória no harness e nos testes). */
export function createAppController(
  platform: AppPlatform,
  clock: Clock = systemClock,
): AppController {
  const store = createAppStore();
  const registry = new DocumentRegistry();
  const sync = new SyncController({ platform, store, registry, clock });
  return { platform, store, registry, sync };
}
