import {
  AppEventBus,
  builtinHotkeys,
  CommandRegistry,
  ContributionStore,
  PanelRegistry,
  PluginHost,
  type InternalPlugin,
  type ModuleEvaluator,
  type PluginNotice,
  type PluginVaultContext,
} from '@simplemd/plugin-api/runtime';
import { EDITOR_KEY_BINDINGS } from '@simplemd/core';
import { hotkeyLabel, isMac } from '@simplemd/ui';
import { sha256Hex, type VaultHandle } from '@simplemd/vault';
import { EditorAssembly } from '../editor/assembly';
import { createEditorServices } from '../editor/services';
import type { AppPlatform } from '../platform/types';
import type { AppStore } from '../state/store';
import { HOST_MODULE_NAMESPACES } from './host-modules';
import { internalPlugins } from './internal/index';
import {
  createPluginDirPort,
  createPluginSettingsPort,
  createPluginVaultSession,
  readPluginMain,
} from './vault-port';

/** Versão do app para `minAppVersion` (Vite `define`, de `apps/desktop/package.json`). */
declare const __SIMPLEMD_VERSION__: string | undefined;
export const APP_VERSION =
  typeof __SIMPLEMD_VERSION__ === 'string' ? __SIMPLEMD_VERSION__ : '0.0.0';

/** O que a sincronização oferece ao `api.vault` dos plugins (reler a árvore, recarregar abas). */
export interface PluginSyncHooks {
  refreshList(): Promise<void>;
  checkTab(id: string): Promise<void>;
}

/** Sistema de plugins montado sobre a plataforma (arch-frontend r2 §2, §3.1, §4.1, §5.2). */
export interface PluginRuntime {
  readonly host: PluginHost;
  readonly commands: CommandRegistry;
  readonly panels: PanelRegistry;
  readonly contributions: ContributionStore;
  readonly events: AppEventBus;
  readonly editor: EditorAssembly;
  /** Abre o vault para os plugins (não bloqueia a casca). */
  openVault(handle: VaultHandle): Promise<void>;
}

/** Preferência dos plugins internos (`config.json` `plugins.internal`; o writer é o de configurações). */
export interface InternalPluginPrefs {
  enabled(id: string): boolean;
  set(id: string, enabled: boolean): void;
}

export interface PluginRuntimeDeps {
  readonly platform: AppPlatform;
  readonly store: AppStore;
  readonly events: AppEventBus;
  readonly sync: () => PluginSyncHooks;
  readonly evaluator: ModuleEvaluator;
  /** Plugins internos (etapa 7); os testes podem trocar a lista. */
  readonly internal?: readonly InternalPlugin[];
  readonly internalPrefs?: InternalPluginPrefs;
}

export function createPluginRuntime({
  platform,
  store,
  events,
  sync,
  evaluator,
  internal = internalPlugins(APP_VERSION),
  internalPrefs,
}: PluginRuntimeDeps): PluginRuntime {
  const commands = new CommandRegistry();
  const panels = new PanelRegistry();
  const platformName = isMac ? 'mac' : 'other';
  let host: PluginHost | null = null;
  const contributions = new ContributionStore(
    builtinHotkeys(EDITOR_KEY_BINDINGS, platformName),
    (pluginId) => host?.rank(pluginId) ?? 0,
  );
  const editor = new EditorAssembly(
    (error) => host?.onEditorException(error),
    createEditorServices({ platform, store, os: platformName }),
  );
  const notify = (notice: PluginNotice) =>
    store.getState().pushNotice({
      kind: notice.level === 'error' ? 'error' : 'info',
      ...(notice.level === 'warn' ? { level: 'warn' as const } : {}),
      notice: notice.kind,
      text: notice.text,
      ...(notice.key === undefined ? {} : { key: notice.key }),
    });
  host = new PluginHost({
    appVersion: APP_VERSION,
    platform: platformName,
    commands,
    panels,
    contributions,
    events,
    evaluator,
    hostModules: HOST_MODULE_NAMESPACES,
    sha256Hex,
    paletteHotkeyLabel: hotkeyLabel('Mod-Shift-p'),
    internal,
    ...(internalPrefs
      ? {
          internalEnabled: (id: string) => internalPrefs.enabled(id),
          onInternalToggle: (id: string, enabled: boolean) => internalPrefs.set(id, enabled),
        }
      : {}),
    notify,
    showPanel: (panelId) => store.setState({ sidePanelOpen: true, sidePanelTab: panelId }),
    onActivated: () =>
      // Primeiro quadro depois de `activate` e da reconfiguração (NFR-19, S-1).
      (globalThis.requestAnimationFrame ?? ((cb: () => void) => setTimeout(cb, 0)))(() => {
        performance.mark('simplemd:plugin-active');
        platform.log('simplemd:plugin-active');
      }),
  });
  const pluginHost = host;
  contributions.setSink(editor);

  const contextFor = (handle: VaultHandle): PluginVaultContext => {
    const provider = platform.vault;
    return {
      dir: createPluginDirPort(provider, handle),
      readMain: (folder, main) => readPluginMain(provider, handle, folder, main),
      approvals: platform.approvals,
      settings: createPluginSettingsPort(provider, handle, (id) =>
        notify({
          level: 'warn',
          kind: 'plugin',
          key: `plugin-data:${id}`,
          text: `${id}: .simplemd/plugins/${id}/data.json é inválido; as configurações deste plugin valem só nesta sessão.`,
        }),
      ),
      vaultFor: () =>
        createPluginVaultSession({
          provider,
          handle,
          tabStatus: (path) => store.getState().docs[path],
          afterWrite: (path, created) => {
            if (store.getState().handle !== handle) return;
            if (created) void sync().refreshList();
            else if (store.getState().tabs.some((tab) => tab.id === path))
              void sync().checkTab(path);
            events.emit('vault:change', { paths: [path] });
          },
        }),
    };
  };

  return {
    host: pluginHost,
    commands,
    panels,
    contributions,
    events,
    editor,
    openVault: (handle) => pluginHost.loadForVault(contextFor(handle)),
  };
}
