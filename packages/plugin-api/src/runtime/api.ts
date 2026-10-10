import type { CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import type {
  NotifyLevel,
  PluginAPI,
  PluginEventMap,
  PluginEventName,
  Unsubscribe,
} from '../types';
import { normalizeHotkey, type CommandRegistry, type Platform } from './commands';
import type { ContributionStore } from './contributions';
import { PLUGIN_EVENTS } from './events';
import type { PanelRegistry } from './panels';

/** Onde uma falha de plugin aconteceu (um aviso por plugin × tipo; arch-frontend r2 §2.7). */
export type FailureKind =
  'activate' | 'command' | 'handler' | 'render' | 'completion' | 'extension';

/** Desfaz tudo o que um plugin registrou, na ordem inversa; uma falha não para as outras. */
export class Registration {
  readonly #disposers: Array<() => void> = [];

  add(dispose: () => void): void {
    this.#disposers.push(dispose);
  }

  dispose(): void {
    for (const dispose of this.#disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch (error) {
        console.warn('[simplemd] falha ao desfazer registro de plugin', error);
      }
    }
  }
}

export type PluginHandler = (payload: PluginEventMap[PluginEventName]) => void;

/** Configurações do plugin, carregadas ANTES de `activate` (R-6.16). */
export interface PluginSettingsSlot {
  readonly values: Record<string, unknown>;
  /** `false` quando o `data.json` existente é ilegível: ele nunca é sobrescrito. */
  readonly writable: boolean;
  save(key: string, value: unknown): Promise<void>;
  /** Depois de `api.settings.set` gravar e atualizar `values` (o host repinta o gerenciador). */
  saved?(key: string): void;
}

export const SETTINGS_MAX_BYTES = 1024 * 1024;
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];
const encoder = new TextEncoder();

/** Tudo de que a instância da API de UM plugin precisa (montado pelo `PluginHost`). */
export interface PluginApiContext {
  readonly id: string;
  readonly name: string;
  readonly platform: Platform;
  readonly bag: Registration;
  readonly commands: CommandRegistry;
  readonly panels: PanelRegistry;
  readonly contributions: ContributionStore;
  /** Assinantes de evento deste plugin (o host entrega os eventos em ordem de carga). */
  readonly handlers: Set<{ readonly evt: PluginEventName; readonly handler: PluginHandler }>;
  readonly vault: PluginAPI['vault'];
  readonly settings: PluginSettingsSlot;
  /** Atalho da paleta para STR-78 (ex.: "⌘⇧P"). */
  readonly paletteHotkeyLabel: string;
  isRevoked(): boolean;
  pluginName(id: string): string;
  notify(level: NotifyLevel, text: string, kind: 'plugin' | 'plugin-hotkey', key?: string): void;
  fail(kind: FailureKind, where: string, error: unknown): void;
  showPanel(panelId: string): void;
}

/**
 * A instância congelada da API v1 de um plugin (R-6.7, AC-6.9): exatamente os 8 membros, presa ao
 * id do plugin. Depois do descarte, todo método lança `Error('plugin desativado')` e não registra
 * nada. Não é sandbox: o plugin roda no mesmo realm do app (D-8).
 */
export function createPluginApi(ctx: PluginApiContext): PluginAPI {
  const { id, name, bag } = ctx;
  const guard = () => {
    if (ctx.isRevoked()) throw new Error('plugin desativado');
  };
  const commandIds = new Set<string>();
  const panelIds = new Set<string>();

  const registerCommand: PluginAPI['registerCommand'] = (cmdId, cmd) => {
    guard();
    if (typeof cmdId !== 'string' || cmdId === '')
      throw new TypeError('registerCommand: id deve ser texto');
    if (typeof cmd?.name !== 'string' || typeof cmd.run !== 'function')
      throw new TypeError('registerCommand espera { name, run }');
    if (commandIds.has(cmdId)) throw new Error(`comando “${cmdId}” já registrado por este plugin`);
    const label = cmd.name;
    const run = () => {
      if (ctx.isRevoked()) return;
      try {
        const result: unknown = cmd.run();
        if (result instanceof Promise)
          result.catch((error: unknown) => ctx.fail('command', `comando “${label}”`, error));
      } catch (error) {
        ctx.fail('command', `comando “${label}”`, error);
      }
    };
    let hotkey: string | undefined;
    if (cmd.hotkey !== undefined) {
      const key = normalizeHotkey(String(cmd.hotkey), ctx.platform);
      const result = ctx.contributions.bindHotkey(id, key, () => {
        run();
        return true;
      });
      if (result.bound) {
        hotkey = cmd.hotkey;
        bag.add(result.unbind);
      } else {
        const by =
          result.conflict === 'builtin'
            ? 'pelo simpleMD'
            : `pelo plugin “${ctx.pluginName(result.otherPluginId)}”`;
        ctx.notify(
          'warn',
          `${name}: o atalho ${cmd.hotkey} de “${label}” já é usado ${by}. Use a paleta de comandos (${ctx.paletteHotkeyLabel}).`,
          'plugin-hotkey',
          `plugin-hotkey:${id}:${key}`,
        );
      }
    }
    commandIds.add(cmdId);
    bag.add(() => commandIds.delete(cmdId));
    bag.add(
      ctx.commands.register({
        id: `${id}:${cmdId}`,
        title: `${name}: ${label}`,
        source: 'plugin',
        pluginId: id,
        ...(hotkey === undefined ? {} : { hotkey }),
        run,
      }),
    );
  };

  const registerEditorExtension: PluginAPI['registerEditorExtension'] = (ext) => {
    guard();
    if (
      typeof ext !== 'object' ||
      ext === null ||
      (ext.source === undefined && ext.wysiwyg === undefined)
    ) {
      throw new TypeError('registerEditorExtension espera { source } e/ou { wysiwyg }');
    }
    // `wysiwyg`: reservado para o modo WYSIWYG (etapa 15); aceito e ignorado hoje (R-6.2).
    if (ext.source !== undefined) bag.add(ctx.contributions.addExtension(id, ext.source));
  };

  const registerPanel: PluginAPI['registerPanel'] = (panelId, panel) => {
    guard();
    if (typeof panelId !== 'string' || panelId === '')
      throw new TypeError('registerPanel: id deve ser texto');
    if (typeof panel?.title !== 'string' || typeof panel.render !== 'function')
      throw new TypeError('registerPanel espera { title, render }');
    if (panelIds.has(panelId)) throw new Error(`painel “${panelId}” já registrado por este plugin`);
    const fullId = `${id}:${panelId}`;
    const render = panel.render;
    panelIds.add(panelId);
    bag.add(() => panelIds.delete(panelId));
    bag.add(
      ctx.panels.add({
        id: fullId,
        title: panel.title,
        pluginId: id,
        pluginName: name,
        el: document.createElement('div'),
        render: (el) => render.call(panel, el),
        rendered: false,
        failed: false,
      }),
    );
    bag.add(
      ctx.commands.register({
        id: `panel:${fullId}`,
        title: `Mostrar painel: ${panel.title}`,
        source: 'plugin',
        pluginId: id,
        run: () => ctx.showPanel(fullId),
      }),
    );
  };

  const registerCompletionSource: PluginAPI['registerCompletionSource'] = (src) => {
    guard();
    if (typeof src !== 'function')
      throw new TypeError('registerCompletionSource espera uma função');
    const onError = (error: unknown) => {
      ctx.fail('completion', 'sugestões', error);
      return null;
    };
    const wrapped: CompletionSource = (context) => {
      if (ctx.isRevoked()) return null;
      try {
        const result = src(context);
        return result instanceof Promise
          ? result.catch(onError)
          : (result as CompletionResult | null);
      } catch (error) {
        return onError(error);
      }
    };
    bag.add(ctx.contributions.addCompletionSource(id, wrapped));
  };

  const on: PluginAPI['on'] = (evt, handler) => {
    guard();
    if (!PLUGIN_EVENTS.includes(evt)) throw new TypeError(`evento desconhecido: “${String(evt)}”`);
    if (typeof handler !== 'function') throw new TypeError('on espera uma função');
    const entry = { evt, handler: handler as PluginHandler };
    ctx.handlers.add(entry);
    const off: Unsubscribe = () => {
      ctx.handlers.delete(entry);
    };
    bag.add(off);
    return off;
  };

  const vault = Object.freeze({
    read: (path: string) => {
      guard();
      return ctx.vault.read(String(path));
    },
    write: (path: string, text: string) => {
      guard();
      return ctx.vault.write(String(path), String(text));
    },
    list: () => {
      guard();
      return ctx.vault.list();
    },
  });

  let writes = Promise.resolve();
  const settings = Object.freeze({
    get<T>(key: string): T | undefined {
      guard();
      const value = ctx.settings.values[key];
      return value === undefined ? undefined : (structuredClone(value) as T);
    },
    set<T>(key: string, value: T): Promise<void> {
      guard();
      if (
        typeof key !== 'string' ||
        key.length < 1 ||
        key.length > 256 ||
        FORBIDDEN_KEYS.includes(key)
      )
        return Promise.reject(new TypeError('settings.set: chave inválida'));
      if (!ctx.settings.writable)
        return Promise.reject(
          new Error('data.json deste plugin é inválido; as configurações não são gravadas'),
        );
      let serialized: string;
      try {
        serialized = JSON.stringify({ ...ctx.settings.values, [key]: value });
      } catch (error) {
        return Promise.reject(
          new TypeError(`settings.set: valor não serializável (${String(error)})`),
        );
      }
      if (encoder.encode(serialized).length > SETTINGS_MAX_BYTES)
        return Promise.reject(new RangeError('settings.set: configurações maiores que 1 MB'));
      const copy = JSON.parse(JSON.stringify({ value })) as { value?: unknown };
      const run = writes.then(async () => {
        await ctx.settings.save(key, copy.value);
        if (copy.value === undefined) delete ctx.settings.values[key];
        else ctx.settings.values[key] = copy.value;
        ctx.settings.saved?.(key);
      });
      writes = run.catch(() => undefined);
      return run;
    },
  });

  const ui = Object.freeze({
    notify(msg: string, level: NotifyLevel = 'info'): void {
      guard();
      const safe: NotifyLevel = level === 'warn' || level === 'error' ? level : 'info';
      ctx.notify(safe, `${name}: ${String(msg)}`, 'plugin');
    },
  });

  return Object.freeze({
    registerCommand,
    registerEditorExtension,
    registerPanel,
    registerCompletionSource,
    on,
    vault,
    settings,
    ui,
  });
}
