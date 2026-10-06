import type { AppPlatform } from '../platform/types';
import { DocumentRegistry } from '../state/documents';
import { SettingsController, type RootTarget } from '../state/settings';
import { createAppStore, type AppStore } from '../state/store';
import { SyncController, systemClock, type Clock } from '../state/sync';
import { createDomRoot } from './dom-root';

/** Tudo o que a UI recebe: store, motores de sincronização e de preferências, documentos e plataforma. */
export interface AppController {
  readonly platform: AppPlatform;
  readonly store: AppStore;
  readonly registry: DocumentRegistry;
  readonly sync: SyncController;
  readonly settings: SettingsController;
}

/**
 * Monta o app sobre uma plataforma (Tauri em produção; memória no harness e nos testes). `root` é
 * onde o tema é aplicado: o `<html>` por padrão, um dublê nos testes sem DOM.
 */
export function createAppController(
  platform: AppPlatform,
  clock: Clock = systemClock,
  root: RootTarget = createDomRoot(),
): AppController {
  const store = createAppStore();
  const registry = new DocumentRegistry();
  const settings = new SettingsController({ platform, store, clock, root });
  const sync = new SyncController({
    platform,
    store,
    registry,
    clock,
    hooks: {
      beforeOpen: (handle) => settings.loadForVault(handle),
      afterClose: () => settings.reset(),
      flush: () => settings.flush(),
    },
  });
  return { platform, store, registry, sync, settings };
}
