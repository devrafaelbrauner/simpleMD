import { EditorView } from '@codemirror/view';
import {
  contextAction,
  EDITOR_KEY_BINDINGS,
  escapeHandler,
  interactFacet,
  problemsCommandsFacet,
} from '@simplemd/core';
import type {
  ConfigFileRead,
  InternalHostContext,
  LtStatus,
  VimStatus,
} from '@simplemd/plugin-api/internal/host';
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
import { hotkeyLabel, isMac } from '@simplemd/ui';
import {
  isVaultConfigFile,
  isVaultError,
  sha256Hex,
  type VaultConfigFile,
  type VaultHandle,
} from '@simplemd/vault';
import { StatusBarStore } from '../app/status-bar';
import { EditorAssembly } from '../editor/assembly';
import { createEditorServices } from '../editor/services';
import type { AppPlatform } from '../platform/types';
import type { AppStore } from '../state/store';
import { HOST_MODULE_NAMESPACES } from './host-modules';
import {
  internalPlugins,
  type InternalAppServices,
  type InternalLoadContext,
  type InternalPluginDescriptor,
} from './internal/index';
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
  /** Barra de status C6 (r7 §3.5): slots `tab` (núcleo), `vim` (S4) e `lt` (S8). */
  readonly statusBar: StatusBarStore;
  /** Abre o vault para os plugins (não bloqueia a casca). */
  openVault(handle: VaultHandle): Promise<void>;
  /** Arquivo de configuração da lista fechada do vault aberto (opções `info`); `null` sem pasta. */
  readConfigFile(name: string): Promise<ConfigFileRead | null>;
}

/** Preferência dos plugins internos (`config.json` `plugins.internal`; o writer é o de configurações). */
export interface InternalPluginPrefs {
  enabled(id: string, defaultEnabled: boolean): boolean;
  set(id: string, enabled: boolean): void;
}

export interface PluginRuntimeDeps {
  readonly platform: AppPlatform;
  readonly store: AppStore;
  readonly events: AppEventBus;
  readonly sync: () => PluginSyncHooks;
  readonly evaluator: ModuleEvaluator;
  /** Plugins internos já convertidos (os testes antigos passam `[]` ou uma lista própria). */
  readonly internal?: readonly InternalPlugin[];
  /** Descritores dos internos (padrão: o coletor; o harness embrulha o `load`, H27). */
  readonly internalDescriptors?: readonly InternalPluginDescriptor[];
  readonly internalPrefs?: InternalPluginPrefs;
  /** Objetos do app para os arquivos de registro (DA-R7-26); lido só quando um interno carrega. */
  readonly services?: () => InternalAppServices;
}

/**
 * Menor privilégio por plugin interno (arch-frontend r7 §3.2): o que cada registro recebe além do
 * contexto comum. Fica aqui, revisável num lugar só; um descritor não concede nada a si mesmo.
 */
interface InternalPrivileges {
  /** Arquivos de configuração do vault que o plugin pode ler (lista fechada do backend). */
  readonly files?: readonly VaultConfigFile[];
  readonly languageTool?: true;
  readonly status?: 'vim' | 'lt';
  /** Ordem do alvo de "Interagir com o elemento sob o cursor" (W2 10 → W3 20; DA-R7-27). */
  readonly interactOrder?: number;
}

const PRIVILEGES: Readonly<Record<string, InternalPrivileges>> = {
  'simplemd.tasks': { interactOrder: 20 },
  'simplemd.vim': { status: 'vim' },
  'simplemd.lint': { files: ['.markdownlint.json', '.markdownlint.jsonc'], interactOrder: 10 },
  'simplemd.latex-snippets': { files: ['.simplemd/latex-snippets.json'] },
  'simplemd.languagetool': { languageTool: true, status: 'lt', interactOrder: 10 },
};

/** Alvo de interação de um plugin sem ordem declarada: depois de W2/W3, antes do núcleo (30). */
const DEFAULT_INTERACT_ORDER = 25;
/** Espera depois da última mudança num arquivo de configuração (≤ 2 s até reaplicar). */
const CONFIG_CHANGE_DEBOUNCE_MS = 300;

export function createPluginRuntime({
  platform,
  store,
  events,
  sync,
  evaluator,
  internal,
  internalDescriptors,
  internalPrefs,
  services,
}: PluginRuntimeDeps): PluginRuntime {
  const commands = new CommandRegistry();
  const panels = new PanelRegistry();
  const statusBar = new StatusBarStore();
  const platformName = isMac ? 'mac' : 'other';
  let host: PluginHost | null = null;
  const contributions = new ContributionStore(
    builtinHotkeys(EDITOR_KEY_BINDINGS, platformName),
    (pluginId) => host?.rank(pluginId) ?? 0,
  );
  const editor = new EditorAssembly(
    (error) => host?.onEditorException(error),
    createEditorServices({
      platform,
      store,
      os: platformName,
      sync: () => {
        if (!services) throw new Error('serviços do app ausentes no runtime de plugins');
        return services().sync;
      },
    }),
  );
  const notify = (notice: PluginNotice) =>
    store.getState().pushNotice({
      kind: notice.level === 'error' ? 'error' : 'info',
      ...(notice.level === 'warn' ? { level: 'warn' as const } : {}),
      notice: notice.kind,
      text: notice.text,
      ...(notice.key === undefined ? {} : { key: notice.key }),
    });

  /** Leitura da lista fechada pelo provider do backend (64/64/256 KiB; só leitura). */
  const readConfigFile = async (name: string): Promise<ConfigFileRead | null> => {
    const handle = store.getState().handle;
    if (!handle) return null;
    if (!isVaultConfigFile(name)) return { error: 'missing' };
    try {
      const file = await platform.vault.readConfigFile(handle, name);
      return file === null ? { error: 'missing' } : { text: file.text };
    } catch (error) {
      return { error: isVaultError(error) && error.code === 'TOO_LARGE' ? 'too-large' : 'read' };
    }
  };

  /** Mudanças nos arquivos permitidos (observação do provider, só os 3 caminhos da lista). */
  const watchConfigFiles = (
    allowed: readonly VaultConfigFile[],
    listener: (name: string) => void,
  ): (() => void) => {
    const handle = store.getState().handle;
    if (!handle || !platform.vault.watch) return () => {};
    /** Cancelamento da espera pendente de cada arquivo. */
    const pending = new Map<string, () => void>();
    const stop = platform.vault.watch(handle, (event) => {
      if (event.kind !== 'change' || store.getState().handle !== handle) return;
      for (const path of event.paths) {
        if (!allowed.some((name) => name === path)) continue;
        pending.get(path)?.();
        const timer = setTimeout(() => {
          pending.delete(path);
          listener(path);
        }, CONFIG_CHANGE_DEBOUNCE_MS);
        pending.set(path, () => clearTimeout(timer));
      }
    });
    return () => {
      stop();
      for (const cancel of pending.values()) cancel();
    };
  };

  /** Contexto de UM plugin interno (D-R7-F03): o comum + só os privilégios da tabela. */
  const contextFor = (descriptor: InternalPluginDescriptor): InternalLoadContext => {
    const id = descriptor.id;
    const privileges = PRIVILEGES[id] ?? {};
    const files = privileges.files;
    const status =
      privileges.status === 'vim'
        ? {
            set: (value: VimStatus) => statusBar.set('vim', value),
            clear: () => statusBar.set('vim', null),
          }
        : privileges.status === 'lt'
          ? {
              set: (value: LtStatus) => statusBar.set('lt', value),
              clear: () => statusBar.set('lt', null),
              onAction: statusBar.onLtAction.bind(statusBar),
            }
          : undefined;
    const hostContext: InternalHostContext = {
      pluginId: id,
      platform: platformName,
      editor: {
        contextAction: (slot, action) => contextAction(slot, action),
        interact: (run) =>
          interactFacet.of({ order: privileges.interactOrder ?? DEFAULT_INTERACT_ORDER, run }),
        escape: (owner, run) => escapeHandler(owner, run),
        problems: (commandsOf) => problemsCommandsFacet.of(commandsOf),
        announce: (text) => editor.view?.dispatch({ effects: EditorView.announce.of(text) }),
      },
      ...(status ? { status } : {}),
      options: {
        get: <T>(key: string) => pluginHost.internalOptions(id)?.values[key] as T,
        subscribe: (listener) => pluginHost.onInternalOption(id, listener),
      },
      links: {
        openExternal: (url) => {
          platform.openUrl(url).catch(() =>
            store.getState().pushNotice({
              kind: 'error',
              notice: 'link',
              text: 'Não foi possível abrir o link no navegador.',
            }),
          );
        },
      },
      ...(files
        ? {
            files: {
              read: async (name: string): Promise<ConfigFileRead> =>
                files.some((allowed) => allowed === name)
                  ? ((await readConfigFile(name)) ?? { error: 'missing' })
                  : { error: 'missing' },
              onChange: (listener: (name: string) => void) => watchConfigFiles(files, listener),
            },
          }
        : {}),
      ...(privileges.languageTool ? { languageTool: platform.languageTool } : {}),
    };
    if (!services) throw new Error(`${id}: serviços do app ausentes no runtime de plugins`);
    return { pluginId: id, host: hostContext, services: services() };
  };

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
    internal: internal ?? internalPlugins(APP_VERSION, contextFor, internalDescriptors),
    ...(internalPrefs
      ? {
          internalEnabled: (id: string, defaultEnabled: boolean) =>
            internalPrefs.enabled(id, defaultEnabled),
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

  const vaultContext = (handle: VaultHandle): PluginVaultContext => {
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
    statusBar,
    openVault: (handle) => pluginHost.loadForVault(vaultContext(handle)),
    readConfigFile,
  };
}
