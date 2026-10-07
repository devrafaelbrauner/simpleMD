import { AppEventBus, type ModuleEvaluator } from '@simplemd/plugin-api/runtime';
import type { AppPlatform } from '../platform/types';
import { createBlobEvaluator } from '../plugins/evaluator';
import { createPluginRuntime, type PluginRuntime } from '../plugins/runtime';
import { DocumentRegistry } from '../state/documents';
import { SettingsController, type RootTarget } from '../state/settings';
import { createAppStore, type AppStore } from '../state/store';
import { SyncController, systemClock, type Clock } from '../state/sync';
import { createDomRoot } from './dom-root';

/**
 * Tudo o que a UI recebe: store, motores de sincronização e de preferências, documentos,
 * plataforma e o sistema de plugins (editor principal, comandos, painéis).
 */
export interface AppController {
  readonly platform: AppPlatform;
  readonly store: AppStore;
  readonly registry: DocumentRegistry;
  readonly sync: SyncController;
  readonly settings: SettingsController;
  readonly plugins: PluginRuntime;
}

export interface AppControllerOptions {
  /** Avaliador de módulos de plugin (padrão: `blob:`; o Vitest usa arquivos temporários). */
  readonly evaluator?: ModuleEvaluator;
}

/**
 * Monta o app sobre uma plataforma (Tauri em produção; memória no harness e nos testes). `root` é
 * onde o tema é aplicado: o `<html>` por padrão, um dublê nos testes sem DOM.
 */
export function createAppController(
  platform: AppPlatform,
  clock: Clock = systemClock,
  root: RootTarget = createDomRoot(),
  options: AppControllerOptions = {},
): AppController {
  const store = createAppStore();
  const registry = new DocumentRegistry();
  const settings = new SettingsController({ platform, store, clock, root });
  const events = new AppEventBus();
  let sync: SyncController | null = null;
  const plugins = createPluginRuntime({
    platform,
    store,
    events,
    sync: () => {
      if (!sync) throw new Error('sincronização ainda não montada');
      return sync;
    },
    evaluator: options.evaluator ?? createBlobEvaluator(),
  });
  sync = new SyncController({
    platform,
    store,
    registry,
    clock,
    events,
    createState: (doc, path) => plugins.editor.createState(doc, path),
    hooks: {
      beforeOpen: (handle) => settings.loadForVault(handle),
      afterClose: () => settings.reset(),
      flush: () => settings.flush(),
      beforeClose: () => plugins.host.disposeAll(),
      afterOpen: (handle) => plugins.openVault(handle),
    },
  });
  return { platform, store, registry, sync, settings, plugins };
}
