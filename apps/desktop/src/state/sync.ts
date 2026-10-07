import { EditorSelection, type EditorState } from '@codemirror/state';
import { createMarkdownState } from '@simplemd/core';
import type { PluginEventMap, PluginEventName } from '@simplemd/plugin-api';
import {
  ConflictError,
  conflictCopyCandidate,
  createWithFreeName,
  decodeDocument,
  encodeDocument,
  isVaultError,
  type Unsubscribe,
  type VaultHandle,
  type VaultWatchEvent,
} from '@simplemd/vault';
import type { AppPlatform } from '../platform/types';
import type { DocumentRecord, DocumentRegistry } from './documents';
import { INITIAL_DATA, type AppStore, type DocStatus } from './store';

/** Relógio injetável: o Vitest usa temporizadores falsos; o harness fixa a hora da cópia (H10). */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Ganchos de quem acompanha a pasta aberta: `beforeOpen` roda antes de a casca aparecer (A-20;
 * preferências do vault), `afterClose` quando a pasta não chega a abrir, `flush` antes de fechar a
 * janela ou trocar de pasta, `beforeClose` ao fechar/trocar a pasta (os plugins da pasta antiga são
 * descartados ANTES de qualquer ativação da nova, AC-6.28) e `afterOpen` com a pasta já listada
 * (carga dos plugins, sem bloquear a casca).
 */
export interface VaultHooks {
  beforeOpen(handle: VaultHandle): Promise<void>;
  afterClose(): void;
  flush(): Promise<void>;
  beforeClose?(): void;
  afterOpen?(handle: VaultHandle): Promise<void> | void;
}

/** Emissor de eventos de arquivo para plugins (R-6.13; `AppEventBus` do runtime de plugins). */
export interface FileEvents {
  emit<E extends PluginEventName>(evt: E, payload: PluginEventMap[E]): void;
}

/**
 * Índice do vault (etapa 9; arch-backend r2 §1.4 passo 5): gravações do app chegam com o texto
 * gravado (0 leituras) e mudanças externas com os caminhos do observador (só `stat`).
 */
export interface IndexHooks {
  saved(path: string, text: string, mtime: number): void;
  changed(paths: readonly string[]): void;
  /** Sem observador: relista o vault e indexa notas novas ou mudadas (CR2-03). */
  revalidate(): void;
}

export interface SyncDeps {
  readonly platform: AppPlatform;
  readonly store: AppStore;
  readonly registry: DocumentRegistry;
  readonly clock: Clock;
  readonly hooks?: VaultHooks;
  readonly events?: FileEvents;
  readonly index?: IndexHooks;
  /** Estado de uma aba nova (o `EditorHost` do app; padrão: a pilha do r1 sem contribuições). */
  readonly createState?: (doc: string, path: string) => EditorState;
}

export type FlushResult = 'ok' | 'conflict' | 'error';
export type OpenOrigin = 'welcome' | 'shell';

/** R-2.9 / NFR-11: debounce de 1.000 ms após a última mudança, sem espera máxima. */
export const AUTOSAVE_DEBOUNCE_MS = 1000;
/** Erros de E/S no autosave: novas tentativas após 1 s, 2 s e 4 s (arch-backend §1.5.7). */
const RETRY_DELAYS_MS = [1000, 2000, 4000];
/** Sem observação nativa, as abas abertas são conferidas a cada 1.000 ms (NFR-12). */
export const POLL_INTERVAL_MS = 1000;
/** Rodadas de flush ao fechar, para absorver teclas que chegam durante a gravação (CR-03). */
const MAX_FLUSH_ROUNDS = 5;

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const MD = /\.md$/i;

const defaultState = (doc: string, path: string) =>
  createMarkdownState(doc, { ariaLabel: `Editor: ${path}` });

/**
 * Motor de sincronização (arch-frontend §4.2 sobre o contrato do arch-backend §1.5.7–§1.5.9):
 * autosave com debounce, flush ao fechar aba/janela, detecção de mudança externa (watch, sondagem
 * e foco da janela) e os fluxos de conflito. Toda chamada ao provider de um mesmo arquivo passa por
 * uma fila FIFO por caminho. Nenhum caminho deste módulo sobrescreve um arquivo cujo conteúdo o
 * app não viu: o provider recusa com `ConflictError` (regra 6).
 */
export class SyncController {
  readonly #platform: AppPlatform;
  readonly #store: AppStore;
  readonly #registry: DocumentRegistry;
  readonly #clock: Clock;
  readonly #hooks: VaultHooks | undefined;
  readonly #events: FileEvents | undefined;
  readonly #index: IndexHooks | undefined;
  readonly #createState: (doc: string, path: string) => EditorState;
  readonly #debounce = new Map<string, unknown>();
  readonly #retry = new Map<string, { handle: unknown; attempt: number }>();
  readonly #queues = new Map<string, Promise<unknown>>();
  #unwatch: Unsubscribe | null = null;
  #poll: unknown = null;
  #listing: Promise<void> | null = null;
  #relist = false;
  /** Generação do vault: respostas atrasadas de um vault anterior são descartadas. */
  #generation = 0;

  constructor({ platform, store, registry, clock, hooks, events, index, createState }: SyncDeps) {
    this.#platform = platform;
    this.#store = store;
    this.#registry = registry;
    this.#clock = clock;
    this.#hooks = hooks;
    this.#events = events;
    this.#index = index;
    this.#createState = createState ?? defaultState;
  }

  /** Estado novo de uma aba; numa recarga, o cursor é limitado ao novo tamanho (arch-ux F2). */
  #freshState(path: string, doc: string, previous?: EditorState): EditorState {
    const state = this.#createState(doc, path);
    if (!previous) return state;
    const head = Math.min(previous.selection.main.head, doc.length);
    return state.update({ selection: EditorSelection.cursor(head) }).state;
  }

  // ---- Vault --------------------------------------------------------------------------------

  /**
   * "Abrir pasta…". Na casca, primeiro faz o flush de todas as abas; se algum falhar, abre L4.
   * A primeira listagem de uma pasta aberta das boas-vindas que falhar volta às boas-vindas com o
   * alerta (WEL-DENIED/WEL-ERROR); na casca, o erro aparece no explorador (EXP-ERROR/EXP-DENIED).
   */
  async openVault(origin: OpenOrigin): Promise<void> {
    const store = this.#store;
    if (store.getState().opening) return;
    if (store.getState().vaultStatus === 'open') {
      if (store.getState().conflict) return;
      const result = await this.flushAll();
      if (result.conflict) return;
      if (result.errorPaths.length > 0) {
        store.setState({ unsavedClose: { reason: 'vault-switch', paths: result.errorPaths } });
        return;
      }
      await this.#hooks?.flush();
    }
    await this.#pickAndOpen(origin);
  }

  async refreshList(): Promise<void> {
    if (this.#listing) {
      this.#relist = true;
      return this.#listing;
    }
    this.#listing = (async () => {
      do {
        this.#relist = false;
        await this.#listOnce();
      } while (this.#relist);
    })().finally(() => {
      this.#listing = null;
    });
    return this.#listing;
  }

  // ---- Abas e documentos ---------------------------------------------------------------------

  /** Abre o arquivo numa aba (ou foca a aba existente). Leitura nunca grava (regra 1). */
  async openFile(path: string): Promise<boolean> {
    const store = this.#store;
    const handle = store.getState().handle;
    if (!handle) return false;
    if (!store.getState().addTab(path)) return true;
    performance.mark('simplemd:file-open-start');
    const generation = this.#generation;
    try {
      const { text, mtime } = await this.#enqueue(path, () =>
        this.#platform.vault.read(handle, path),
      );
      if (generation !== this.#generation || !this.#hasTab(path)) return false;
      const { doc, format } = decodeDocument(text);
      const state = this.#freshState(path, doc);
      this.#registry.replace(path, { state, format, diskText: text, savedDoc: state.doc, mtime });
      store.getState().setDocStatus(path, 'clean');
      // Só aqui: uma aba NOVA abriu o arquivo (não numa troca de aba nem no foco de uma aberta).
      this.#events?.emit('file:open', { path });
      if (format.mixed) {
        store.getState().pushNotice({
          kind: 'info',
          notice: 'mixed-eol',
          text: 'Este arquivo mistura finais de linha; ao salvar, eles serão unificados.',
          detail: path,
        });
      }
      return true;
    } catch (error) {
      if (generation !== this.#generation) return false;
      this.#registry.delete(path);
      store.getState().removeTab(path);
      this.#reportOpenFailure(path, error);
      if (isVaultError(error, 'NOT_FOUND')) void this.refreshList();
      return false;
    }
  }

  /** Mudança do documento vinda do editor (`onChange`; nunca `setState`). */
  onEditorChange(id: string, state: EditorState): void {
    const store = this.#store;
    const status = store.getState().docs[id];
    if (status === undefined || status === 'loading') return;
    this.#registry.updateState(id, state);
    if (status === 'conflict') return; // autosave pausado até resolver (arch-backend §1.5.7)
    store.getState().markDirty(id);
    this.#cancelRetry(id);
    const clock = this.#clock;
    const pending = this.#debounce.get(id);
    if (pending !== undefined) clock.clearTimeout(pending);
    this.#debounce.set(
      id,
      clock.setTimeout(() => {
        this.#debounce.delete(id);
        void this.#save(id, 'auto');
      }, AUTOSAVE_DEBOUNCE_MS),
    );
  }

  /** Grava agora o que estiver pendente na aba. */
  async flush(id: string): Promise<FlushResult> {
    this.#cancelDebounce(id);
    this.#cancelRetry(id);
    return this.#save(id, 'flush');
  }

  /**
   * Flush de todas as abas, até cada uma ficar limpa: uma tecla que chega enquanto a gravação
   * anterior está em curso entra no flush seguinte em vez de se perder (CR-03).
   */
  async flushAll(): Promise<{ conflict: boolean; errorPaths: string[] }> {
    const tabs = this.#store.getState().tabs;
    const results = await Promise.all(tabs.map((tab) => this.#flushUntilClean(tab.id)));
    return {
      conflict: results.includes('conflict'),
      errorPaths: tabs.filter((_, i) => results[i] === 'error').map((tab) => tab.path),
    };
  }

  /**
   * Fecha a aba depois do flush; erro ou conflito mantêm a aba (AC-2.11). Uma aba limpa fecha sem
   * gravar nada (CR-01); edições digitadas durante o flush são gravadas antes de fechar (CR-03).
   */
  async closeTab(id: string): Promise<FlushResult> {
    const status = this.#store.getState().docs[id];
    if (status === undefined) return 'ok';
    const result = status === 'loading' ? 'ok' : await this.#flushUntilClean(id);
    if (result === 'ok') this.#dropTab(id);
    return result;
  }

  async closeActive(): Promise<FlushResult> {
    const active = this.#store.getState().activeId;
    return active === null ? 'ok' : this.closeTab(active);
  }

  /** Repete o salvamento de uma aba em erro ("Tentar novamente"). */
  async retrySave(id: string): Promise<FlushResult> {
    return this.flush(id);
  }

  // ---- Janela -------------------------------------------------------------------------------

  /**
   * Pedido de fechar a janela: só fecha se todos os flushes derem certo. Conflito pendente mostra
   * L1 (UCL-CONFLICT); erro de gravação abre L4 "Alterações não salvas".
   */
  async requestWindowClose(): Promise<boolean> {
    const store = this.#store;
    if (store.getState().conflict) return false;
    const result = await this.flushAll();
    if (result.conflict) return false;
    if (result.errorPaths.length > 0) {
      store.setState({ unsavedClose: { reason: 'window', paths: result.errorPaths } });
      return false;
    }
    await this.#hooks?.flush();
    this.#stopWatching();
    this.#hooks?.beforeClose?.();
    return true;
  }

  /** L4 "Fechar sem salvar": descarte explícito, 0 gravações de documentos. */
  async discardAndClose(): Promise<void> {
    const pending = this.#store.getState().unsavedClose;
    if (!pending) return;
    this.#store.setState({ unsavedClose: null });
    // As preferências já aplicadas não são "alterações não salvas" de arquivos: vão para o disco.
    await this.#hooks?.flush();
    if (pending.reason === 'window') {
      this.#stopWatching();
      this.#clearTimers();
      await this.#platform.closeWindow();
    } else {
      // Descarte explícito: as abas com erro não são gravadas de novo depois do diálogo.
      await this.#pickAndOpen('shell', { discard: true });
    }
  }

  cancelUnsavedClose(): void {
    this.#store.setState({ unsavedClose: null });
  }

  /** Foco da janela: rede de segurança para eventos de observação perdidos. */
  onWindowFocus(): void {
    for (const tab of this.#store.getState().tabs) void this.checkTab(tab.id);
    // Na sondagem não há eventos de pastas nem de notas novas: o catálogo relista (CR2-03).
    if (this.#poll !== null) this.#index?.revalidate();
  }

  // ---- Mudança externa e conflitos -----------------------------------------------------------

  /**
   * Compara o disco com o que o app viu por último (arch-backend §1.5.9). Igual → só atualiza o
   * mtime. Aba limpa → recarrega + aviso, 0 gravações (AC-2.13). Aba suja → conflito (AC-2.12).
   */
  async checkTab(id: string): Promise<void> {
    const handle = this.#store.getState().handle;
    if (!handle) return;
    const generation = this.#generation;
    await this.#enqueue(id, async () => {
      const status = this.#store.getState().docs[id];
      const record = this.#registry.get(id);
      if (!record || status === undefined || status === 'loading' || status === 'conflict') return;
      let text: string;
      let mtime: number;
      try {
        ({ text, mtime } = await this.#platform.vault.read(handle, id));
      } catch (error) {
        if (generation === this.#generation && isVaultError(error, 'NOT_FOUND')) {
          this.#index?.changed([id]);
          this.#onDeleted(id);
        } else console.warn('[simplemd]', isVaultError(error) ? error.code : 'IO', id);
        return;
      }
      if (generation !== this.#generation || !this.#hasTab(id)) return;
      if (text === record.diskText) {
        record.mtime = mtime;
        return;
      }
      // Na sondagem não há observador para avisar os plugins da mudança externa (R-6.13).
      if (this.#poll !== null) {
        this.#events?.emit('vault:change', { paths: [id] });
        this.#index?.changed([id]);
      }
      if (this.#store.getState().docs[id] === 'clean') {
        const { doc, format } = decodeDocument(text);
        const state = this.#freshState(id, doc, record.state);
        this.#registry.replace(id, { state, format, diskText: text, savedDoc: state.doc, mtime });
        this.#store.getState().pushNotice({
          kind: 'info',
          notice: 'external-reload',
          text: 'Arquivo alterado fora do simpleMD; recarregado',
          detail: id,
        });
      } else {
        this.#enterConflict(id, 'external-change');
      }
    });
  }

  /** "Manter ambos" (R-2.10, D-3): cópia só-criação com o buffer; o original volta ao disco. */
  async keepBoth(): Promise<void> {
    const store = this.#store;
    const { conflict, handle } = store.getState();
    const record = conflict && this.#registry.get(conflict.tabId);
    if (!conflict || !handle || !record || store.getState().conflictBusy) return;
    store.setState({ conflictBusy: true, conflictFailed: false });
    const text = encodeDocument(record.state.doc.toString(), record.format);
    const at = new Date(this.#clock.now());
    let copyPath: string;
    let copyMtime: number;
    try {
      ({ path: copyPath, mtime: copyMtime } = await this.#enqueue(conflict.path, () =>
        createWithFreeName(
          this.#platform.vault,
          handle,
          (n) => conflictCopyCandidate(conflict.path, at, n),
          text,
        ),
      ));
    } catch (error) {
      console.warn('[simplemd]', isVaultError(error) ? error.code : 'IO', conflict.path);
      store.setState({ conflictBusy: false, conflictFailed: true });
      return;
    }
    this.#index?.saved(copyPath, text, copyMtime);
    this.#events?.emit('file:save', { path: copyPath, mtime: copyMtime });
    this.#events?.emit('vault:change', { paths: [copyPath] });
    if (conflict.reason === 'deleted') this.#dropTab(conflict.tabId);
    else await this.#reloadOriginal(conflict.tabId);
    store.getState().resolveConflict();
    await this.refreshList();
    await this.openFile(copyPath);
    store.getState().pushNotice({
      kind: 'info',
      notice: 'conflict-copy-saved',
      text: `Suas alterações foram salvas em “${nameOf(copyPath)}”.`,
      detail: copyPath,
    });
  }

  /**
   * "Recarregar do disco": descarte explícito do buffer (arquivo removido → fecha a aba). A aba
   * ativa não muda: um conflito numa aba de fundo é recarregado no lugar (EC F-5, arch-ux r2 §2.1).
   */
  async reloadFromDisk(): Promise<void> {
    const store = this.#store;
    const { conflict } = store.getState();
    if (!conflict || store.getState().conflictBusy) return;
    store.setState({ conflictBusy: true });
    if (conflict.reason === 'deleted') {
      this.#dropTab(conflict.tabId);
      this.#noticeDeleted(conflict.path);
    } else if (await this.#reloadOriginal(conflict.tabId)) {
      store.getState().pushNotice({
        kind: 'info',
        notice: 'reloaded-from-disk',
        text: `“${nameOf(conflict.path)}” recarregado do disco.`,
      });
    }
    store.getState().resolveConflict();
  }

  /** Encerra tudo (desmontagem do app). */
  dispose(): void {
    this.#generation++;
    this.#stopWatching();
    this.#clearTimers();
  }

  // ---- Internos -----------------------------------------------------------------------------

  async #pickAndOpen(origin: OpenOrigin, options: { discard?: boolean } = {}): Promise<void> {
    const store = this.#store;
    store.setState({ opening: true, welcomeError: null });
    try {
      await this.#openPicked(origin, options.discard === true);
    } finally {
      // Nenhuma falha inesperada pode deixar "Abrir pasta…" travado para sempre (CR-12).
      if (store.getState().opening) store.setState({ opening: false });
    }
  }

  async #openPicked(origin: OpenOrigin, discard: boolean): Promise<void> {
    const store = this.#store;
    let handle: VaultHandle;
    try {
      handle = await this.#platform.vault.open();
    } catch (error) {
      store.setState({ opening: false });
      if (isVaultError(error, 'CANCELLED')) return;
      const denied = isVaultError(error, 'PERMISSION_DENIED');
      if (store.getState().vaultStatus === 'closed') {
        store.setState({ welcomeError: denied ? { kind: 'denied' } : { kind: 'io' } });
      } else {
        // A pasta atual continua aberta; só avisa que a nova não pôde ser aberta.
        store.getState().pushNotice({
          kind: 'error',
          notice: 'open-failed',
          text: denied
            ? 'Sem permissão para acessar esta pasta.'
            : 'Não foi possível abrir a pasta.',
        });
      }
      return;
    }
    if (!discard && store.getState().vaultStatus === 'open') {
      // O usuário pode ter digitado enquanto o diálogo estava aberto (no Windows ele não é modal
      // para a janela): grava de novo antes de descartar as abas do vault atual (CR-02). A pasta
      // nova ainda está pendente, então estas gravações vão para a pasta atual (CR2-02).
      const result = await this.flushAll();
      if (result.conflict || result.errorPaths.length > 0) {
        // A pasta atual continua aberta e gravável; a escolhida é esquecida.
        this.#platform.vault.abandon(handle);
        store.setState({ opening: false });
        if (result.errorPaths.length > 0) {
          store.setState({ unsavedClose: { reason: 'vault-switch', paths: result.errorPaths } });
        }
        return;
      }
    }
    this.#platform.vault.activate(handle);
    this.#closeCurrentVault();
    // Tema e fontes da pasta antes de a casca aparecer (A-20: sem piscar o tema padrão).
    await this.#hooks?.beforeOpen(handle);
    store.setState({
      vaultStatus: 'open',
      opening: false,
      handle,
      vaultName: handle.name,
      listStatus: 'loading',
      entries: [],
      expanded: {},
      focusedPath: null,
      sidePanelOpen: false,
      sidePanelTab: null,
    });
    const listed = await this.#listOnce();
    if (!listed.ok && origin === 'welcome' && store.getState().handle === handle) {
      this.#closeCurrentVault();
      store.setState({
        ...INITIAL_DATA,
        notices: store.getState().notices,
        welcomeError: listed.denied ? { kind: 'denied' } : { kind: 'io', folder: handle.name },
      });
      this.#hooks?.afterClose();
      return;
    }
    this.#startWatching(handle);
    // Os plugins da pasta carregam primeiro, então já recebem o `vault:change` da abertura.
    const generation = this.#generation;
    void Promise.resolve(this.#hooks?.afterOpen?.(handle)).then(() => {
      if (!listed.ok || generation !== this.#generation) return;
      this.#events?.emit('vault:change', {
        paths: store
          .getState()
          .entries.filter((entry) => entry.kind === 'file')
          .map((entry) => entry.path),
      });
    });
  }

  async #listOnce(): Promise<{ ok: boolean; denied: boolean }> {
    const store = this.#store;
    const handle = store.getState().handle;
    if (!handle) return { ok: false, denied: false };
    const generation = this.#generation;
    try {
      const entries = await this.#platform.vault.list(handle);
      if (generation !== this.#generation) return { ok: false, denied: false };
      performance.mark('simplemd:explorer-data-ready');
      store.setState({ entries, listStatus: 'ready' });
      return { ok: true, denied: false };
    } catch (error) {
      const denied = isVaultError(error, 'PERMISSION_DENIED');
      if (generation === this.#generation)
        store.setState({ listStatus: denied ? 'denied' : 'error' });
      return { ok: false, denied };
    }
  }

  #closeCurrentVault(): void {
    this.#generation++;
    this.#stopWatching();
    this.#clearTimers();
    // Plugins da pasta que sai: descartados antes de qualquer ativação da próxima (AC-6.28).
    this.#hooks?.beforeClose?.();
    this.#registry.clear();
    this.#store.setState({
      tabs: [],
      activeId: null,
      docs: {},
      conflict: null,
      conflictQueue: [],
      conflictFailed: false,
      conflictBusy: false,
    });
  }

  #startWatching(handle: VaultHandle): void {
    const vault = this.#platform.vault;
    if (!vault.watch) {
      this.#startPolling();
      return;
    }
    this.#unwatch = vault.watch(handle, (event: VaultWatchEvent) => {
      if (this.#store.getState().handle !== handle) return;
      if (event.kind === 'unavailable') {
        this.#startPolling();
        return;
      }
      // Eventos só de arquivos abertos (inclusive os do próprio autosave) não mudam a árvore: nada
      // de reler o vault inteiro a cada gravação (CR-07). Remoções de abertos chegam ao checkTab,
      // que relista; qualquer outro caminho relista.
      const open = new Set(this.#store.getState().tabs.map((tab) => tab.path));
      if (event.paths.some((p) => !open.has(p))) void this.refreshList();
      const notes = event.paths.filter((p) => MD.test(p));
      if (notes.length > 0) this.#events?.emit('vault:change', { paths: notes });
      this.#index?.changed(event.paths);
      for (const tab of this.#store.getState().tabs) {
        if (event.paths.some((p) => tab.path === p || tab.path.startsWith(`${p}/`)))
          void this.checkTab(tab.id);
      }
    });
  }

  #startPolling(): void {
    if (this.#poll !== null) return;
    const tick = () => {
      this.#poll = this.#clock.setTimeout(() => {
        for (const tab of this.#store.getState().tabs) void this.checkTab(tab.id);
        tick();
      }, POLL_INTERVAL_MS);
    };
    tick();
  }

  #stopWatching(): void {
    this.#unwatch?.();
    this.#unwatch = null;
    if (this.#poll !== null) this.#clock.clearTimeout(this.#poll);
    this.#poll = null;
  }

  #clearTimers(): void {
    for (const id of [...this.#debounce.keys()]) this.#cancelDebounce(id);
    for (const id of [...this.#retry.keys()]) this.#cancelRetry(id);
  }

  #cancelDebounce(id: string): void {
    const handle = this.#debounce.get(id);
    if (handle !== undefined) this.#clock.clearTimeout(handle);
    this.#debounce.delete(id);
  }

  #cancelRetry(id: string): void {
    const retry = this.#retry.get(id);
    if (retry) this.#clock.clearTimeout(retry.handle);
    this.#retry.delete(id);
  }

  #hasTab(id: string): boolean {
    return this.#store.getState().tabs.some((tab) => tab.id === id);
  }

  #dropTab(id: string): void {
    this.#cancelDebounce(id);
    this.#cancelRetry(id);
    this.#registry.delete(id);
    this.#store.getState().removeTab(id);
  }

  /** Fila FIFO por caminho: as decisões de leitura/comparação veem um `diskText` consistente. */
  #enqueue<T>(path: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(path) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.catch(() => undefined);
    this.#queues.set(path, settled);
    void settled.then(() => {
      if (this.#queues.get(path) === settled) this.#queues.delete(path);
    });
    return run;
  }

  /**
   * Repete o flush enquanto a aba voltar a ficar suja durante a gravação (edição concorrente).
   * Limitado: depois de `MAX_FLUSH_ROUNDS` rodadas a aba continua aberta como "erro" (nada se perde).
   */
  async #flushUntilClean(id: string): Promise<FlushResult> {
    for (let round = 0; round < MAX_FLUSH_ROUNDS; round++) {
      const result = await this.flush(id);
      if (result !== 'ok') return result;
      const status = this.#store.getState().docs[id];
      if (status === undefined || status === 'clean') return 'ok';
    }
    return 'error';
  }

  #save(id: string, mode: 'auto' | 'flush'): Promise<FlushResult> {
    return this.#enqueue(id, async () => {
      const store = this.#store;
      const handle = store.getState().handle;
      const status: DocStatus | undefined = store.getState().docs[id];
      const record = this.#registry.get(id);
      if (!handle || !record || status === undefined || status === 'loading') return 'ok';
      if (status === 'conflict') return 'conflict';
      const snapshot = record.state.doc;
      // Nada a gravar quando o documento é o que foi lido/gravado por último (inclusive depois de
      // desfazer até ele): 0 bytes escritos. Comparar só o texto recodificado não basta: num
      // arquivo com finais de linha mistos a recodificação difere do disco sem edição (CR-01).
      if (snapshot.eq(record.savedDoc)) {
        store.getState().setDocStatus(id, 'clean');
        return 'ok';
      }
      const text = encodeDocument(snapshot.toString(), record.format);
      if (text === record.diskText) {
        record.savedDoc = snapshot;
        store.getState().setDocStatus(id, 'clean');
        return 'ok';
      }
      store.getState().setDocStatus(id, 'saving');
      try {
        // Sempre com base de conteúdo (R-2.9, RR-03): o provider recusa se o disco não tem mais o
        // texto que o app leu ou gravou por último, mesmo com o mesmo mtime.
        const { mtime } = await this.#platform.vault.writeIfUnchanged(handle, id, text, {
          text: record.diskText,
          mtime: record.mtime,
        });
        record.diskText = text;
        record.savedDoc = snapshot;
        record.mtime = mtime;
        this.#retry.delete(id);
        const changed = this.#registry.get(id)?.state.doc !== snapshot;
        store.getState().setDocStatus(id, changed ? 'dirty' : 'clean');
        this.#index?.saved(id, text, mtime);
        this.#events?.emit('file:save', { path: id, mtime });
        return 'ok';
      } catch (error) {
        return this.#onSaveError(id, error, mode);
      }
    });
  }

  #onSaveError(id: string, error: unknown, mode: 'auto' | 'flush'): FlushResult {
    const store = this.#store;
    if (error instanceof ConflictError) {
      this.#enterConflict(id, error.reason === 'deleted' ? 'deleted' : 'save-conflict');
      return 'conflict';
    }
    const code = isVaultError(error) ? error.code : 'IO';
    const attempt = this.#retry.get(id)?.attempt ?? 0;
    const delay = RETRY_DELAYS_MS[attempt];
    if (mode === 'auto' && code === 'IO' && delay !== undefined) {
      store.getState().setDocStatus(id, 'dirty');
      this.#retry.set(id, {
        attempt: attempt + 1,
        handle: this.#clock.setTimeout(() => void this.#save(id, 'auto'), delay),
      });
      return 'error';
    }
    this.#retry.delete(id);
    store.getState().setDocStatus(id, 'error');
    const name = nameOf(id);
    store.getState().pushNotice({
      kind: 'error',
      notice: 'save-failed',
      key: `save-failed:${id}`,
      text:
        code === 'PERMISSION_DENIED'
          ? `Sem permissão para gravar “${name}”. Suas alterações continuam no editor.`
          : `Não foi possível salvar “${name}”. Suas alterações continuam no editor.`,
      detail: id,
      action: { label: 'Tentar novamente', run: () => void this.retrySave(id) },
    });
    return 'error';
  }

  #enterConflict(id: string, reason: 'external-change' | 'save-conflict' | 'deleted'): void {
    this.#cancelDebounce(id);
    this.#cancelRetry(id);
    this.#store.getState().setDocStatus(id, 'conflict');
    this.#store.getState().raiseConflict({ tabId: id, path: id, reason });
  }

  #onDeleted(id: string): void {
    const status = this.#store.getState().docs[id];
    if (status === 'clean') {
      this.#dropTab(id);
      this.#noticeDeleted(id);
    } else if (status !== undefined) {
      this.#enterConflict(id, 'deleted');
    }
    void this.refreshList();
  }

  #noticeDeleted(path: string): void {
    this.#store.getState().pushNotice({
      kind: 'info',
      notice: 'deleted',
      text: 'Arquivo removido fora do simpleMD',
      detail: path,
    });
  }

  /** Lê o original do disco para um estado novo (sem histórico) e marca a aba como limpa. */
  async #reloadOriginal(id: string): Promise<boolean> {
    const handle = this.#store.getState().handle;
    const previous = this.#registry.get(id);
    if (!handle || !previous) return false;
    try {
      const { text, mtime } = await this.#enqueue(id, () => this.#platform.vault.read(handle, id));
      const { doc, format } = decodeDocument(text);
      const state = this.#freshState(id, doc, previous.state);
      const record: DocumentRecord = { state, format, diskText: text, savedDoc: state.doc, mtime };
      this.#registry.replace(id, record);
      this.#store.getState().setDocStatus(id, 'clean');
      return true;
    } catch (error) {
      this.#dropTab(id);
      if (isVaultError(error, 'NOT_FOUND')) this.#noticeDeleted(id);
      else this.#reportOpenFailure(id, error);
      return false;
    }
  }

  #reportOpenFailure(path: string, error: unknown): void {
    const name = nameOf(path);
    const store = this.#store;
    if (isVaultError(error, 'NOT_UTF8')) {
      store.getState().pushNotice({
        kind: 'error',
        notice: 'not-utf8',
        text: 'Arquivo não está em UTF-8; não foi aberto para evitar corrompê-lo',
        detail: path,
      });
      return;
    }
    store.getState().pushNotice({
      kind: 'error',
      notice: 'open-failed',
      text: isVaultError(error, 'PERMISSION_DENIED')
        ? `Sem permissão para ler “${name}”.`
        : `Não foi possível abrir “${name}”.`,
      detail: path,
    });
  }
}
