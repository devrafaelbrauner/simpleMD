import {
  AppEventBus,
  Observable,
  type InternalPlugin,
  type ModuleEvaluator,
} from '@simplemd/plugin-api/runtime';
import { fileTitle, imageSourceFacet, isoDay, type NoteRef } from '@simplemd/core';
import type { Entry } from '@simplemd/vault';
import { copyText } from '../ai/clipboard';
import { AiController } from '../ai/controller';
import { CatalogController } from '../catalog/catalog';
import { ExportController } from '../export/controller';
import type { AppPlatform } from '../platform/types';
import { createBlobEvaluator } from '../plugins/evaluator';
import type { InternalPluginDescriptor } from '../plugins/internal/index';
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
  /** IA: configuração, chaves, chat e cartão de resultado (etapa 11). */
  readonly ai: AiController;
  /** Exportação para `.md`, HTML e PDF pela impressão do WebView (etapa 10). */
  readonly exporter: ExportController;
  /**
   * SED-INVALID (r7 DESIGN §R7.6.7): o `config.json` desta pasta tinha `editor.captureTab`
   * inválido. Vem do aviso `config-field` do carregamento; some quando o usuário muda a chave ou
   * troca de pasta.
   */
  readonly captureTabInvalid: CaptureTabWarning;
}

/** Bandeira observável para `useSyncExternalStore`. */
export class CaptureTabWarning extends Observable<boolean> {
  constructor() {
    super(false);
  }

  set(value: boolean): void {
    if (value !== this.getSnapshot()) this.publish(value);
  }
}

export interface AppControllerOptions {
  /** Avaliador de módulos de plugin (padrão: `blob:`; o Vitest usa arquivos temporários). */
  readonly evaluator?: ModuleEvaluator;
  /** Plugins internos (padrão: Mermaid, KaTeX e calc; os testes antigos passam `[]`). */
  readonly internal?: readonly InternalPlugin[];
  /** Descritores dos internos (o harness embrulha o `load`, H27). */
  readonly internalDescriptors?: readonly InternalPluginDescriptor[];
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
    ...(options.internalDescriptors ? { internalDescriptors: options.internalDescriptors } : {}),
    internalPrefs: {
      enabled: (id, defaultEnabled) => settings.internalPluginEnabled(id, defaultEnabled),
      set: (id, enabled) => settings.setInternalPlugin(id, enabled),
    },
    services: () => {
      if (!sync) throw new Error('sincronização ainda não montada');
      return { platform, store, registry, catalog, sync, editor: plugins.editor };
    },
  });
  // r7 S2: wikilinks resolvem sobre o índice ∪ os `.md` do explorador (D-R7-S2-04).
  const catalog = new CatalogController(platform.vault, clock, {
    entries: () => store.getState().entries,
    subscribe: (listener) => store.subscribe(listener),
  });
  const indexOn = options.catalog ?? true;
  // IA (etapa 11): lê a seleção do editor principal e aplica resultados só por clique (regra 1).
  const ai = new AiController({
    platform,
    store,
    editorView: () => plugins.editor.view,
    tabName: (id) => store.getState().tabs.find((tab) => tab.id === id)?.name ?? id,
    copy: copyText,
  });
  // CR2-01: documento trocado por inteiro (recarga) → a faixa do cartão da IA não vale mais.
  registry.onReplace((id) => ai.onTabReplaced(id));
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
            revalidate: () => catalog.revalidate(),
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
        ai.reset();
      },
      afterOpen: (handle) => {
        if (indexOn) catalog.open(handle);
        return plugins.openVault(handle);
      },
    },
  });
  // Autocompletar (etapa 8): cada mudança das configurações reconfigura o compartimento de
  // sugestões no editor montado (AC-8.5: o `EditorView` nunca é recriado).
  const completionDeps = {
    // Notas `[[`: o catálogo (título do índice) ou, antes dele, os `.md` do explorador (R-8.5).
    notes: () => {
      const indexed = catalog.getSnapshot().entries;
      if (indexed.length > 0) return indexed;
      return notesFromExplorer(store.getState().entries);
    },
    today: () => isoDay(clock.now()),
  };
  let applied = store.getState().autocomplete;
  plugins.editor.setAutocomplete(applied, completionDeps);
  store.subscribe((state) => {
    if (state.autocomplete === applied) return;
    applied = state.autocomplete;
    plugins.editor.setAutocomplete(applied, completionDeps);
  });
  // "Tecla Tab no editor" (r7 R-X7.1): cada mudança reconfigura o compartimento `#hostKeys` (0
  // `EditorView` novos) e liga/desliga o item "Tab:" da barra de status, que espelha T1/T2 (o
  // observador `tabFocusObserver` fica nos serviços do editor, `plugins/runtime.ts`).
  const { statusBar } = plugins;
  let captureTab = store.getState().captureTab;
  const applyCaptureTab = () => {
    plugins.editor.setCaptureTab(captureTab);
    statusBar.set('tab', captureTab ? { mode: 'indent' } : null);
  };
  applyCaptureTab();
  // SED-INVALID: o aviso `config-field` do carregamento cita `editor.captureTab` (D-R7-ST-04).
  const captureTabInvalid = new CaptureTabWarning();
  let seenWarning: string | null = null;
  let warnedHandle = store.getState().handle;
  store.subscribe((state) => {
    if (state.captureTab !== captureTab) {
      captureTab = state.captureTab;
      applyCaptureTab();
      captureTabInvalid.set(false);
    }
    // O `config.json` é lido ANTES de a pasta entrar no store (o aviso chega antes do `handle`): ao
    // trocar de pasta, a bandeira passa a refletir o aviso que está valendo agora.
    const warning = state.notices.find(
      (n) => n.notice === 'config-field' && n.detail?.split(', ').includes('editor.captureTab'),
    );
    if (state.handle !== warnedHandle) {
      warnedHandle = state.handle;
      seenWarning = warning?.id ?? null;
      captureTabInvalid.set(warning !== undefined && state.handle !== null);
    } else if (warning && warning.id !== seenWarning) {
      seenWarning = warning.id;
      captureTabInvalid.set(true);
    }
  });
  const exporter = new ExportController({
    platform,
    store,
    registry,
    clock,
    enabled: (id) => settings.internalPluginEnabled(id),
    // A cache de imagens da janela (S1) é a do editor principal (serviço em `editor/services.ts`).
    imageSource: () => plugins.editor.view?.state.facet(imageSourceFacet) ?? null,
    // Wikilinks exportados como texto; inexistentes com a classe própria (r7 S2, AC-EX.3).
    wikilinks: (notePath) => ({ exists: (target) => catalog.links.exists(target, notePath) }),
  });
  return {
    platform,
    store,
    registry,
    sync,
    settings,
    plugins,
    catalog,
    ai,
    exporter,
    captureTabInvalid,
  };
}

const explorerNotes = new WeakMap<readonly Entry[], NoteRef[]>();

/** `.md` da árvore do explorador como notas (título = nome do arquivo), memorizado por lista. */
function notesFromExplorer(entries: readonly Entry[]): NoteRef[] {
  let notes = explorerNotes.get(entries);
  if (!notes) {
    notes = entries
      .filter((entry) => entry.kind === 'file')
      .map((entry) => ({ path: entry.path, title: fileTitle(entry.path) }));
    explorerNotes.set(entries, notes);
  }
  return notes;
}
