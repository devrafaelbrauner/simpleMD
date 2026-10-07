import {
  AppEventBus,
  type InternalPlugin,
  type ModuleEvaluator,
} from '@simplemd/plugin-api/runtime';
import { CatalogController } from '../catalog/catalog';
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
  /** Catálogo/índice do vault aberto (etapa 9). */
  readonly catalog: CatalogController;
}

export interface AppControllerOptions {
  /** Avaliador de módulos de plugin (padrão: `blob:`; o Vitest usa arquivos temporários). */
  readonly evaluator?: ModuleEvaluator;
  /** Plugins internos (padrão: Mermaid, KaTeX e calc; os testes antigos passam `[]`). */
  readonly internal?: readonly InternalPlugin[];
  /**
   * Índice do vault na abertura da pasta (padrão `true`). Os testes de sincronização do r1 passam
   * `false`: sem leituras/gravações extras nas contagens deles (como `internal: []`, D-S2-8).
   */
  readonly catalog?: boolean;
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
    ...(options.internal ? { internal: options.internal } : {}),
    internalPrefs: {
      enabled: (id) => settings.internalPluginEnabled(id),
      set: (id, enabled) => settings.setInternalPlugin(id, enabled),
    },
  });
  const catalog = new CatalogController(platform.vault, clock);
  const indexOn = options.catalog ?? true;
  sync = new SyncController({
    platform,
    store,
    registry,
    clock,
    events,
    ...(indexOn
      ? {
          index: {
            saved: (path, text, mtime) => catalog.saved(path, text, mtime),
            changed: (paths) => catalog.changed(paths),
          },
        }
      : {}),
    createState: (doc, path) => plugins.editor.createState(doc, path),
    hooks: {
      beforeOpen: (handle) => settings.loadForVault(handle),
      afterClose: () => settings.reset(),
      flush: async () => {
        await Promise.all([settings.flush(), catalog.flush()]);
      },
      beforeClose: () => {
        plugins.host.disposeAll();
        catalog.close();
      },
      afterOpen: (handle) => {
        if (indexOn) catalog.open(handle);
        return plugins.openVault(handle);
      },
    },
  });
  return { platform, store, registry, sync, settings, plugins, catalog };
}
