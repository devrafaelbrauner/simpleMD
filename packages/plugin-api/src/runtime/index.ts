/**
 * Runtime do sistema de plugins (arch-frontend r2 §2.2). O app importa daqui; plugins importam só
 * os tipos de `@simplemd/plugin-api`. Nada aqui importa React, ReactDOM, Tauri ou outro pacote do
 * simpleMD: tudo chega por portas (regras 2–3, AC-6.3).
 */
export {
  createPluginApi,
  Registration,
  SETTINGS_MAX_BYTES,
  type FailureKind,
  type PluginApiContext,
  type PluginSettingsSlot,
} from './api';
export {
  builtinHotkeys,
  CommandRegistry,
  normalizeHotkey,
  type AppCommand,
  type Platform,
} from './commands';
export {
  ContributionStore,
  GLOBAL_KEY_SCOPE,
  type ContributionSnapshot,
  type EditorContributionSink,
  type HotkeyResult,
} from './contributions';
export {
  compareSemver,
  discoverPlugins,
  MAIN_MAX_BYTES,
  MANIFEST_MAX_BYTES,
  PLUGINS_DIR,
  validateManifest,
  type PluginDirPort,
  type PluginRecord,
} from './discovery';
export { AppEventBus, PLUGIN_EVENTS, type AppEventListener } from './events';
export {
  PluginHost,
  type ApprovalsPort,
  type InternalPlugin,
  type PluginHostDeps,
  type PluginHostSnapshot,
  type PluginNotice,
  type PluginRowView,
  type PluginSettingsPort,
  type PluginStatus,
  type PluginVaultContext,
  type PluginVaultSession,
  type PluginWarningView,
} from './host';
export {
  HOST_MODULES,
  HOST_REGISTRY_KEY,
  hostShimSource,
  installHostModules,
  PLUGIN_URL_SCHEME,
  PluginLoadError,
  prepareModule,
  type HostModuleName,
  type HostModules,
  type HostModuleUrls,
  type ModuleEvaluator,
} from './loader';
export { Observable } from './observable';
export { PanelRegistry, type PluginPanel } from './panels';
