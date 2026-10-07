import type {
  NotifyLevel,
  PluginAPI,
  PluginEventMap,
  PluginEventName,
  PluginManifest,
} from '../types';
import {
  createPluginApi,
  Registration,
  type FailureKind,
  type PluginApiContext,
  type PluginHandler,
  type PluginSettingsSlot,
} from './api';
import type { CommandRegistry, Platform } from './commands';
import type { ContributionStore } from './contributions';
import { discoverPlugins, type PluginDirPort, type PluginRecord } from './discovery';
import type { AppEventBus } from './events';
import {
  installHostModules,
  PLUGIN_URL_SCHEME,
  PluginLoadError,
  prepareModule,
  type HostModules,
  type ModuleEvaluator,
} from './loader';
import { Observable } from './observable';
import type { PanelRegistry } from './panels';

/** Status visíveis no gerenciador (R-6.20, STR-64). */
export type PluginStatus =
  'Desativado' | 'Ativo' | 'Erro' | 'Incompatível' | 'Alterado — confirme de novo' | 'Inválido';

/** Aprovações por dispositivo, fora do vault (D-10; comandos `plugin_*` do Rust no app). */
export interface ApprovalsPort {
  get(): Promise<Readonly<Record<string, { readonly sha256: string; readonly enabled: boolean }>>>;
  /** Grava ou troca o hash aprovado e liga o plugin. */
  set(id: string, sha256: string): Promise<void>;
  /** Liga/desliga sem mexer no hash; sem aprovação → rejeita (`NOT_APPROVED`). */
  setEnabled(id: string, enabled: boolean): Promise<void>;
}

/** Configurações do plugin em `.simplemd/plugins/<id>/data.json` (R-6.16). */
export interface PluginSettingsPort {
  load(id: string): Promise<{ values: Record<string, unknown>; writable: boolean }>;
  save(id: string, key: string, value: unknown): Promise<void>;
}

/** `api.vault` de um plugin, com as bases de conteúdo da sessão (R-6.14, R-6.15). */
export type PluginVaultSession = PluginAPI['vault'] & { dispose(): void };

/** Portas da pasta aberta (recriadas a cada vault). */
export interface PluginVaultContext {
  readonly dir: PluginDirPort;
  /** Lê os bytes do `main` UMA vez (teto de 5 MB). */
  readMain(folder: string, main: string): Promise<Uint8Array>;
  readonly approvals: ApprovalsPort;
  readonly settings: PluginSettingsPort;
  vaultFor(pluginId: string): PluginVaultSession;
}

/** Plugin interno (etapa 7): mesmo caminho de ativação, sem aviso nem aprovação. */
export interface InternalPlugin {
  readonly manifest: PluginManifest;
  load(): Promise<{ activate?: unknown; default?: unknown }>;
}

export interface PluginNotice {
  readonly level: NotifyLevel;
  readonly text: string;
  readonly kind: 'plugin' | 'plugin-error' | 'plugin-hotkey';
  readonly key?: string;
}

export interface PluginHostDeps {
  readonly appVersion: string;
  readonly platform: Platform;
  readonly commands: CommandRegistry;
  readonly panels: PanelRegistry;
  readonly contributions: ContributionStore;
  readonly events: AppEventBus;
  readonly evaluator: ModuleEvaluator;
  readonly hostModules: HostModules;
  readonly sha256Hex: (bytes: Uint8Array) => string;
  readonly paletteHotkeyLabel: string;
  readonly internal?: readonly InternalPlugin[];
  /** Plugins internos desligados nas preferências (`config.json` `plugins.internal`). */
  readonly internalEnabled?: (id: string) => boolean;
  notify(notice: PluginNotice): void;
  showPanel(panelId: string): void;
  /** Marca `simplemd:plugin-active` (NFR-19). */
  onActivated?(id: string): void;
  onInternalToggle?(id: string, enabled: boolean): void;
}

export interface PluginRowView {
  /** Pasta (externos) ou id (internos). */
  readonly key: string;
  readonly source: 'internal' | 'external';
  readonly name: string;
  readonly version: string | null;
  /** Id válido do manifesto; `null` → a linha mostra "pasta <nome>" (P-STR-4). */
  readonly id: string | null;
  readonly folder: string;
  readonly description: string | null;
  readonly status: PluginStatus;
  readonly reason: string;
  readonly checked: boolean;
  readonly toggleable: boolean;
  readonly busy: boolean;
}

/** Aviso de ativação pendente (L6): bytes já lidos e com hash (arch-frontend r2 §12). */
export interface PluginWarningView {
  readonly key: string;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly main: string;
  readonly hash12: string;
  readonly changed: boolean;
}

export interface PluginHostSnapshot {
  readonly vault: 'none' | 'open';
  readonly scan: 'idle' | 'scanning' | 'error';
  readonly internal: readonly PluginRowView[];
  readonly external: readonly PluginRowView[];
  readonly warning: PluginWarningView | null;
  /** Último anúncio para a região viva do L2 (UX-R2-D21); `seq` muda a cada anúncio. */
  readonly announcement: { readonly seq: number; readonly text: string } | null;
}

interface Active {
  readonly bag: Registration;
  readonly handlers: PluginApiContext['handlers'];
  readonly vault: PluginVaultSession;
  /** A função devolvida por `activate`, chamada uma única vez no descarte. */
  dispose: (() => void) | undefined;
  revoked: boolean;
}

interface Entry {
  readonly key: string;
  readonly source: 'internal' | 'external';
  manifest: PluginManifest | null;
  display: { name: string; version: string | null; id: string | null; description: string | null };
  status: PluginStatus;
  reason: string;
  busy: boolean;
  /** Bytes lidos UMA vez e o hash deles (externos válidos). */
  bytes: Uint8Array | null;
  hash: string | null;
  load: InternalPlugin['load'] | null;
  active: Active | null;
}

const NEVER_APPROVED = 'Nunca ativado neste dispositivo.';
const CHANGED = 'O código mudou desde a sua aprovação neste dispositivo.';
const USER_OFF = 'Desativado por você.';

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);

/**
 * Host de plugins (arch-frontend r2 §2.3–§2.7): descoberta, ligação ao hash dos bytes executados,
 * aprovação por dispositivo, ativação em ordem (internos, depois externos por id), descarte e
 * isolamento de falhas. Sem React e sem Tauri: tudo chega por portas.
 */
export class PluginHost extends Observable<PluginHostSnapshot> {
  readonly #deps: PluginHostDeps;
  readonly #internal: Entry[] = [];
  #external: Entry[] = [];
  #ctx: PluginVaultContext | null = null;
  /** Geração do vault: respostas atrasadas de um vault anterior são descartadas. */
  #generation = 0;
  #scan: PluginHostSnapshot['scan'] = 'idle';
  #warning: PluginWarningView | null = null;
  /** sha256 COMPLETO dos bytes do aviso aberto (o aviso mostra só 12 hex; CR2-07). */
  #warningHash: string | null = null;
  #announcement: PluginHostSnapshot['announcement'] = null;
  /** Falhas já anunciadas: um aviso por plugin × tipo (AC-6.18). */
  readonly #failures = new Map<string, Set<FailureKind>>();
  /** Módulos avaliados por `(id, hash)`: religar sem recarregar não reavalia (AC-6.19). */
  readonly #modules = new Map<string, Record<string, unknown>>();
  /** URL publicada → id, para atribuir falhas pelo `stack`. */
  readonly #urls = new Map<string, string>();

  constructor(deps: PluginHostDeps) {
    super({
      vault: 'none',
      scan: 'idle',
      internal: [],
      external: [],
      warning: null,
      announcement: null,
    });
    this.#deps = deps;
    for (const plugin of deps.internal ?? []) {
      this.#internal.push({
        key: plugin.manifest.id,
        source: 'internal',
        manifest: plugin.manifest,
        display: {
          name: plugin.manifest.name,
          version: plugin.manifest.version,
          id: plugin.manifest.id,
          description: plugin.manifest.description ?? null,
        },
        status: 'Desativado',
        reason: '',
        busy: false,
        bytes: null,
        hash: null,
        load: () => plugin.load(),
        active: null,
      });
    }
    deps.events.subscribe((evt, payload) => this.#deliver(evt, payload));
    deps.panels.onRenderError = (panel, error) =>
      this.#fail(panel.pluginId, 'render', `painel “${panel.title}”`, error);
    this.#publish();
  }

  /** Posição na ordem de carga (internos primeiro, depois externos por id). */
  readonly rank = (pluginId: string): number => {
    const index = [...this.#internal, ...this.#external].findIndex(
      (entry) => entry.manifest?.id === pluginId,
    );
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };

  /** Abre o vault: internos ligados, depois descoberta + ativação dos externos aprovados. */
  async loadForVault(ctx: PluginVaultContext): Promise<void> {
    this.disposeAll();
    this.#ctx = ctx;
    const generation = ++this.#generation;
    this.#publish();
    for (const entry of this.#internal) {
      if (this.#deps.internalEnabled?.(entry.key) ?? true) await this.#activate(entry, generation);
      else this.#setStatus(entry, 'Desativado', USER_OFF);
    }
    await this.#rescan(generation, false);
  }

  /** "Recarregar lista" (R-6.4): relê os manifestos e re-hasheia cada `main`. */
  async reload(): Promise<void> {
    if (!this.#ctx) return;
    await this.#rescan(this.#generation, true);
  }

  /**
   * Fecha/troca de vault (AC-6.28): descarta TODOS os plugins, de forma síncrona, antes de
   * qualquer `activate` da pasta nova.
   */
  disposeAll(): void {
    this.#generation++;
    for (const entry of [...this.#internal, ...this.#external]) this.#dispose(entry);
    for (const entry of this.#internal) this.#setStatus(entry, 'Desativado', '', false);
    this.#external = [];
    this.#ctx = null;
    this.#scan = 'idle';
    this.#warning = null;
    this.#warningHash = null;
    this.#failures.clear();
    this.#publish();
  }

  /** Interruptor do gerenciador. Ligar código novo ou alterado abre o aviso (L6) em vez de ativar. */
  async setEnabled(key: string, on: boolean): Promise<void> {
    const entry = this.#find(key);
    const ctx = this.#ctx;
    if (!entry || entry.busy) return;
    if (entry.status === 'Inválido' || entry.status === 'Incompatível') return;
    const generation = this.#generation;
    if (!on) {
      this.#dispose(entry);
      this.#setStatus(entry, 'Desativado', USER_OFF);
      this.#announce(entry);
      if (entry.source === 'internal') this.#deps.onInternalToggle?.(entry.key, false);
      else if (ctx && entry.manifest) {
        await ctx.approvals.setEnabled(entry.manifest.id, false).catch((error: unknown) => {
          console.warn('[simplemd] plugin_enabled_set', messageOf(error));
        });
      }
      return;
    }
    if (entry.active) return;
    if (entry.source === 'internal') {
      this.#deps.onInternalToggle?.(entry.key, true);
      await this.#activate(entry, generation);
      this.#announce(entry);
      return;
    }
    if (!ctx || !entry.manifest || !entry.hash || !entry.bytes) return;
    const approvals = await ctx.approvals.get().catch(() => ({}) as Record<string, never>);
    if (generation !== this.#generation) return;
    const approval = approvals[entry.manifest.id];
    if (approval?.sha256 === entry.hash) {
      await ctx.approvals.setEnabled(entry.manifest.id, true);
      await this.#activate(entry, generation);
      this.#announce(entry);
      return;
    }
    this.#warningHash = entry.hash;
    this.#warning = {
      key: entry.key,
      id: entry.manifest.id,
      name: entry.manifest.name,
      version: entry.manifest.version,
      main: entry.manifest.main,
      hash12: entry.hash.slice(0, 12),
      changed: approval !== undefined,
    };
    this.#publish();
  }

  /** "Cancelar"/Esc no L6: nada é executado e o status não muda (AC-6.6). */
  cancelWarning(): void {
    this.#warning = null;
    this.#warningHash = null;
    this.#publish();
  }

  /**
   * "Ativar mesmo assim": aprova o hash dos bytes JÁ lidos e avalia ESSE buffer (sem segunda
   * leitura; R-6.6).
   */
  async confirmWarning(): Promise<void> {
    const warning = this.#warning;
    const hash = this.#warningHash;
    const ctx = this.#ctx;
    this.#warning = null;
    this.#warningHash = null;
    this.#publish();
    const entry = warning && this.#find(warning.key);
    // Bytes trocados por uma nova leitura entre o aviso e o clique → nada é aprovado (hash inteiro).
    if (!warning || !ctx || !entry?.hash || entry.hash !== hash) return;
    const generation = this.#generation;
    try {
      await ctx.approvals.set(warning.id, entry.hash);
    } catch (error) {
      this.#deps.notify({
        level: 'error',
        kind: 'plugin-error',
        text: `${warning.name}: não foi possível registrar a aprovação — ${messageOf(error)}`,
      });
      return;
    }
    await this.#activate(entry, generation);
    this.#announce(entry);
  }

  /**
   * `EditorView.exceptionSink` do editor principal: atribui a falha de uma extensão pelo `stack`
   * (`simplemd-plugin://<id>/` ou a URL publicada) e marca o plugin com `Erro` (AC-6.18).
   */
  readonly onEditorException = (error: unknown): void => {
    const id = this.attribute(error);
    if (id === null) console.error('[simplemd] falha numa extensão do editor', error);
    else this.#fail(id, 'extension', 'extensão do editor', error);
  };

  /** Id do plugin cujo código aparece primeiro no `stack` do erro, ou `null`. */
  attribute(error: unknown): string | null {
    const stack = error instanceof Error ? (error.stack ?? '') : '';
    for (const line of stack.split('\n')) {
      const scheme = line.indexOf(PLUGIN_URL_SCHEME);
      if (scheme !== -1) {
        const rest = line.slice(scheme + PLUGIN_URL_SCHEME.length);
        const id = rest.slice(0, rest.indexOf('/'));
        if (this.#find(id)) return id;
      }
      for (const [url, id] of this.#urls) if (line.includes(url)) return id;
    }
    return null;
  }

  // ---- internos -------------------------------------------------------------------------------

  #find(key: string): Entry | undefined {
    return [...this.#internal, ...this.#external].find(
      (entry) => entry.key === key || entry.manifest?.id === key,
    );
  }

  async #rescan(generation: number, announce: boolean): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx) return;
    this.#scan = 'scanning';
    this.#publish();
    let records: PluginRecord[];
    try {
      records = await discoverPlugins(ctx.dir, this.#deps.appVersion);
    } catch {
      if (generation === this.#generation) {
        this.#scan = 'error';
        this.#publish();
      }
      return;
    }
    // Armazém corrompido, ilegível ou ausente → tudo `Desativado` (fail closed; D-10).
    const approvals = await ctx.approvals.get().catch(() => ({}) as Record<string, never>);
    if (generation !== this.#generation) return;
    const previous = new Map(this.#external.map((entry) => [entry.key, entry]));
    const next: Entry[] = [];
    const toActivate: Entry[] = [];
    for (const record of records) {
      const old = previous.get(record.folder);
      previous.delete(record.folder);
      const entry: Entry = old ?? {
        key: record.folder,
        source: 'external',
        manifest: null,
        display: { name: record.folder, version: null, id: null, description: null },
        status: 'Desativado',
        reason: '',
        busy: false,
        bytes: null,
        hash: null,
        load: null,
        active: null,
      };
      next.push(entry);
      if (record.kind !== 'valid') {
        this.#dispose(entry);
        entry.manifest = record.kind === 'incompatible' ? record.manifest : null;
        entry.bytes = null;
        entry.hash = null;
        entry.display =
          record.kind === 'incompatible'
            ? {
                name: record.manifest.name,
                version: record.manifest.version,
                id: record.manifest.id,
                description: record.manifest.description ?? null,
              }
            : { ...record.display, description: null };
        this.#setStatus(
          entry,
          record.kind === 'invalid' ? 'Inválido' : 'Incompatível',
          record.reason,
          false,
        );
        continue;
      }
      const { manifest } = record;
      let bytes: Uint8Array;
      try {
        bytes = await ctx.readMain(record.folder, manifest.main);
      } catch (error) {
        if (generation !== this.#generation) return;
        this.#dispose(entry);
        entry.manifest = manifest;
        entry.bytes = null;
        entry.hash = null;
        this.#setStatus(
          entry,
          'Erro',
          `Não foi possível ler ${manifest.main}: ${messageOf(error)}`,
          false,
        );
        continue;
      }
      if (generation !== this.#generation) return;
      const hash = this.#deps.sha256Hex(bytes);
      entry.display = {
        name: manifest.name,
        version: manifest.version,
        id: manifest.id,
        description: manifest.description ?? null,
      };
      if (entry.active && entry.hash === hash) {
        entry.manifest = manifest;
        continue; // continua ativo com o mesmo código
      }
      this.#dispose(entry); // código mudou com o plugin ligado: o antigo para, o novo não roda
      entry.manifest = manifest;
      entry.bytes = bytes;
      entry.hash = hash;
      const approval = approvals[manifest.id];
      if (!approval) this.#setStatus(entry, 'Desativado', NEVER_APPROVED, false);
      else if (approval.sha256 !== hash)
        this.#setStatus(entry, 'Alterado — confirme de novo', CHANGED, false);
      else if (!approval.enabled) this.#setStatus(entry, 'Desativado', USER_OFF, false);
      else toActivate.push(entry);
    }
    for (const gone of previous.values()) this.#dispose(gone);
    this.#external = next;
    this.#scan = 'idle';
    if (announce)
      this.#announcement = {
        seq: (this.#announcement?.seq ?? 0) + 1,
        text: 'Lista de plugins recarregada.',
      };
    this.#publish();
    for (const entry of toActivate) await this.#activate(entry, generation);
  }

  async #evaluate(entry: Entry, manifest: PluginManifest): Promise<Record<string, unknown>> {
    const cacheKey = `${manifest.id}:${entry.hash ?? ''}`;
    const cached = this.#modules.get(cacheKey);
    if (cached) return cached;
    if (!entry.bytes) throw new PluginLoadError('código do plugin indisponível');
    const { evaluator } = this.#deps;
    const urls = installHostModules(this.#deps.hostModules, evaluator);
    const text = prepareModule(entry.bytes, manifest.id, manifest.main, urls);
    const url = evaluator.publish(text);
    this.#urls.set(url, manifest.id);
    try {
      const module = await evaluator.importModule(url);
      this.#modules.set(cacheKey, module);
      return module;
    } finally {
      evaluator.release?.(url);
    }
  }

  async #activate(entry: Entry, generation: number): Promise<void> {
    const ctx = this.#ctx;
    const manifest = entry.manifest;
    if (!ctx || !manifest || entry.active) return;
    entry.busy = true;
    this.#failures.delete(manifest.id);
    this.#publish();
    const bag = new Registration();
    let active: Active | null = null;
    try {
      const module =
        entry.source === 'internal' && entry.load
          ? ((await entry.load()) as Record<string, unknown>)
          : await this.#evaluate(entry, manifest);
      const activate = module.default ?? module.activate;
      if (typeof activate !== 'function')
        throw new PluginLoadError('main.js não exporta por padrão uma função activate.');
      const loaded = await ctx.settings.load(manifest.id);
      if (generation !== this.#generation) return;
      const vault = ctx.vaultFor(manifest.id);
      const handlers: PluginApiContext['handlers'] = new Set();
      active = { bag, handlers, vault, dispose: undefined, revoked: false };
      const current = active;
      const settings: PluginSettingsSlot = {
        values: loaded.values,
        writable: loaded.writable,
        save: (key, value) => ctx.settings.save(manifest.id, key, value),
      };
      const api = createPluginApi({
        id: manifest.id,
        name: manifest.name,
        platform: this.#deps.platform,
        bag,
        commands: this.#deps.commands,
        panels: this.#deps.panels,
        contributions: this.#deps.contributions,
        handlers,
        vault,
        settings,
        paletteHotkeyLabel: this.#deps.paletteHotkeyLabel,
        isRevoked: () => current.revoked,
        pluginName: (id) => this.#find(id)?.manifest?.name ?? id,
        notify: (level, text, kind, key) =>
          this.#deps.notify({ level, text, kind, ...(key === undefined ? {} : { key }) }),
        fail: (kind, where, error) => this.#fail(manifest.id, kind, where, error),
        showPanel: (panelId) => this.#deps.showPanel(panelId),
      });
      entry.active = active;
      const result: unknown = (activate as (api: PluginAPI) => unknown).call(undefined, api);
      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          if (entry.active !== current) return;
          this.#dispose(entry);
          this.#fail(manifest.id, 'activate', 'ativação', error);
        });
      } else if (typeof result === 'function') {
        current.dispose = result as () => void;
      }
      this.#setStatus(
        entry,
        'Ativo',
        entry.source === 'external' && entry.hash
          ? `Código aprovado: sha256 ${entry.hash.slice(0, 12)}…`
          : '',
        false,
      );
      this.#deps.onActivated?.(manifest.id);
    } catch (error) {
      // Rollback: nada do que `activate` registrou antes de lançar continua valendo (AC-6.18).
      if (active) {
        active.revoked = true;
        entry.active = null;
      }
      bag.dispose();
      active?.vault.dispose();
      if (generation === this.#generation) this.#fail(manifest.id, 'activate', 'ativação', error);
    } finally {
      entry.busy = false;
      this.#publish();
    }
  }

  #dispose(entry: Entry): void {
    const active = entry.active;
    if (!active) return;
    entry.active = null;
    if (active.dispose) {
      try {
        active.dispose();
      } catch (error) {
        console.warn('[simplemd] o descarte do plugin lançou', entry.key, messageOf(error));
      }
    }
    active.revoked = true;
    active.bag.dispose();
    active.handlers.clear();
    active.vault.dispose();
  }

  #fail(
    id: string,
    kind: FailureKind,
    where: string,
    error: unknown,
    reason = messageOf(error),
  ): void {
    const entry = this.#find(id);
    if (!entry) return;
    const kinds = this.#failures.get(id) ?? new Set<FailureKind>();
    this.#failures.set(id, kinds);
    if (kinds.has(kind)) return; // já anunciado: só conta
    kinds.add(kind);
    const name = entry.manifest?.name ?? entry.display.name;
    this.#setStatus(entry, 'Erro', reason, false);
    this.#deps.notify({
      level: 'error',
      kind: 'plugin-error',
      key: `plugin-error:${id}:${kind}`,
      text: `${name}: erro em ${where} — ${messageOf(error)}`,
    });
    this.#announce(entry);
  }

  /** Eventos do app → handlers dos plugins ativos, em ordem de carga, cada um isolado. */
  #deliver<E extends PluginEventName>(evt: E, payload: PluginEventMap[E]): void {
    const frozen = Object.freeze(
      'paths' in payload
        ? {
            ...payload,
            paths: Object.freeze([...(payload as PluginEventMap['vault:change']).paths]),
          }
        : { ...payload },
    ) as PluginEventMap[E];
    for (const entry of [...this.#internal, ...this.#external]) {
      const active = entry.active;
      if (!active || !entry.manifest) continue;
      const id = entry.manifest.id;
      for (const { evt: wanted, handler } of [...active.handlers]) {
        if (wanted !== evt || active.revoked) continue;
        try {
          (handler as PluginHandler)(frozen);
        } catch (error) {
          this.#fail(id, 'handler', `evento ${evt}`, error);
        }
      }
    }
  }

  #setStatus(entry: Entry, status: PluginStatus, reason: string, publish = true): void {
    entry.status = status;
    entry.reason = reason;
    if (publish) this.#publish();
  }

  #announce(entry: Entry): void {
    const text = `“${entry.display.name}”: ${entry.status}.${entry.reason ? ` ${entry.reason}` : ''}`;
    this.#announcement = { seq: (this.#announcement?.seq ?? 0) + 1, text };
    this.#publish();
  }

  #row(entry: Entry): PluginRowView {
    return {
      key: entry.key,
      source: entry.source,
      name: entry.display.name,
      version: entry.display.version,
      id: entry.display.id,
      folder: entry.key,
      description: entry.display.description,
      status: entry.status,
      reason: entry.reason,
      checked: entry.active !== null,
      toggleable: entry.status !== 'Inválido' && entry.status !== 'Incompatível',
      busy: entry.busy,
    };
  }

  #publish(): void {
    this.publish({
      vault: this.#ctx ? 'open' : 'none',
      scan: this.#scan,
      internal: this.#internal.map((entry) => this.#row(entry)),
      external: this.#external.map((entry) => this.#row(entry)),
      warning: this.#warning,
      announcement: this.#announcement,
    });
  }
}
