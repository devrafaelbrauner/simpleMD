import {
  AppEventBus,
  Observable,
  type InternalPlugin,
  type ModuleEvaluator,
} from '@simplemd/plugin-api/runtime';
import { fileTitle, imageSourceFacet, isoDay, tabFocusMode, type NoteRef } from '@simplemd/core';
import type { Entry } from '@simplemd/vault';
import { copyText } from '../ai/clipboard';
import { AiController } from '../ai/controller';
import { CatalogController } from '../catalog/catalog';
import { ExportController } from '../export/controller';
import type { AppPlatform, SpellReloadScope } from '../platform/types';
import { createBlobEvaluator } from '../plugins/evaluator';
import { SPELL_PLUGIN_ID, type NoteLanguageService } from '../plugins/internal/define';
import type { InternalPluginDescriptor } from '../plugins/internal/index';
import { createPluginRuntime, type PluginRuntime } from '../plugins/runtime';
import { PreviewController } from '../preview/controller';
import { DictionaryService } from '../state/dictionary';
import { DocumentRegistry } from '../state/documents';
import { SettingsController, type RootTarget } from '../state/settings';
import { DEFAULT_SPELL_LANGUAGE, SpellCoverageService } from '../state/spell-coverage';
import { createAppStore, type AppState, type AppStore } from '../state/store';
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
  /** Prévia lado a lado, só leitura (r38a): motor; a UI liga host, visibilidade e mudanças. */
  readonly preview: PreviewController;
  /**
   * Dicionário do usuário (r32b): camada global deste computador ∪ camada da pasta aberta. O
   * LanguageTool o recebe pelo arquivo de registro; a lista das Configurações usa o mesmo objeto.
   */
  readonly dictionary: DictionaryService;
  /**
   * Corretor offline (r35a): a cobertura de línguas (escrita pelo registro do `simplemd.spell`, lida
   * pelo do LanguageTool) e o caminho único do app para `spell_reload`.
   */
  readonly spellCoverage: SpellCoverageService;
  /**
   * SED-INVALID (r7 DESIGN §R7.6.7): o `config.json` desta pasta tinha `editor.captureTab`
   * inválido. Vem do aviso `config-field` do carregamento; some quando o usuário muda a chave ou
   * troca de pasta.
   */
  readonly captureTabInvalid: ConfigFieldWarning;
  /** SED-INVALID de `editor.defaultMode` (r27b), com as mesmas regras de `captureTabInvalid`. */
  readonly defaultModeInvalid: ConfigFieldWarning;
}

/** Bandeira observável para `useSyncExternalStore`. */
export class ConfigFieldWarning extends Observable<boolean> {
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
 * O LanguageTool (`plugins/internal/languagetool.ts`): o "Idioma padrão" dele, com ele ligado, é a
 * língua das notas sem `lang:` para o corretor offline (D-R35B-01).
 */
const LANGUAGETOOL_PLUGIN_ID = 'simplemd.languagetool';

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
  // r35c (AppSec r35a N4): uma camada de pasta pode estar no motor do corretor offline (houve
  // `spell_reload` com `folder`, do app ou da ativação do `simplemd.spell`).
  let spellFolderLayer = false;
  // D-R35B-01: quem acompanha a língua das notas sem `lang:` (o corretor offline ligado).
  const noteLanguageListeners = new Set<() => void>();
  const noteLanguage: NoteLanguageService = {
    get: () => {
      if (!settings.internalPluginEnabled(LANGUAGETOOL_PLUGIN_ID)) return null;
      const option = plugins.host.internalOptions(LANGUAGETOOL_PLUGIN_ID)?.values.language;
      return typeof option === 'string' && option !== 'auto' ? option : DEFAULT_SPELL_LANGUAGE;
    },
    subscribe: (listener) => {
      noteLanguageListeners.add(listener);
      const offOption = plugins.host.onInternalOption(LANGUAGETOOL_PLUGIN_ID, (key) => {
        if (key === 'language') listener();
      });
      return () => {
        noteLanguageListeners.delete(listener);
        offOption();
      };
    },
  };
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
      set: (id, enabled) => {
        settings.setInternalPlugin(id, enabled);
        // r35c: o corretor que liga recarrega o motor com a camada desta pasta (na ativação); o
        // LanguageTool que liga ou desliga muda a língua das notas sem `lang:` (D-R35B-01).
        if (id === SPELL_PLUGIN_ID && enabled) spellFolderLayer = true;
        if (id === LANGUAGETOOL_PLUGIN_ID)
          for (const listener of [...noteLanguageListeners]) listener();
      },
    },
    services: () => {
      if (!sync) throw new Error('sincronização ainda não montada');
      return {
        platform,
        store,
        registry,
        catalog,
        sync,
        editor: plugins.editor,
        dictionary,
        spellCoverage,
        noteLanguage,
      };
    },
  });
  // r32b: nada é lido até o primeiro uso (o LanguageTool ligado ou a lista das Configurações); os
  // avisos de teto das camadas vão à área de avisos do app (D-R32-7, r35b).
  const dictionary = new DictionaryService({
    port: platform.dictionaries,
    vault: platform.vault,
    clock,
    store,
  });
  // r35a: o corretor offline (r34) visto pelo app — a cobertura de línguas e as recargas do motor.
  const spellCoverage = new SpellCoverageService(platform.spell);
  /** `spell_reload` pelo caminho único do app; `folder` deixa a camada da pasta aberta no motor. */
  const reloadSpell = (scope: SpellReloadScope) => {
    spellFolderLayer = scope === 'folder';
    void spellCoverage.reload(scope).catch(() => undefined);
  };
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
    // r30: o diálogo "Enviar para …?" e "Revogar" gravam em `config.json` `ai.consent`.
    setConsent: (provider, granted) => settings.setAiConsent(provider, granted),
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
    // r27b: aba nova nasce no modo das Configurações (`editor.defaultMode`, fonte por padrão); a
    // recarga do disco ou do conflito recria o estado de uma aba que já está no registro e mantém o
    // modo dela.
    createState: (doc, path) =>
      plugins.editor.createState(
        doc,
        path,
        plugins.editor.modeOf(path, registry.get(path)?.state) ??
          store.getState().editorDefaultMode,
      ),
    hooks: {
      beforeOpen: async (handle) => {
        await settings.loadForVault(handle);
        // r35a/r35c (contrato da r34; AppSec r35a N4): o motor — e o dicionário embutido de ~29 MiB
        // que ele carrega na primeira recarga — só com o corretor offline ligado nesta pasta. Ligado:
        // `spell_reload` com a camada dela (`folder`, o token da pasta nova, já ativa na porta),
        // antes da listagem e dos plugins; a ativação do `simplemd.spell` recarrega de novo para a
        // cobertura. Desligado: só a camada global, e só se a de outra pasta pode estar no motor —
        // ele nunca fica com as camadas de uma pasta que saiu (a base já carregada não carrega de
        // novo). Um `CANCELLED` vindo de fora repete; uma falha não muda a tela (o corretor avisa
        // na recarga dele).
        if (settings.internalPluginEnabled(SPELL_PLUGIN_ID)) reloadSpell('folder');
        else if (spellFolderLayer) reloadSpell('global');
      },
      afterClose: () => {
        settings.reset();
        // Volta às boas-vindas sem token (`global`): o do `TauriFsPort` nunca zera e ainda seria o
        // da pasta que não abriu, que o Rust trata como ativa (code-review r35a N1; AppSec r35a N2).
        if (spellFolderLayer) reloadSpell('global');
      },
      flush: async () => {
        await Promise.all([settings.flush(), catalog.flush()]);
      },
      beforeClose: () => {
        plugins.host.disposeAll();
        catalog.close();
        ai.reset();
        dictionary.close();
      },
      afterOpen: (handle) => {
        if (indexOn) catalog.open(handle);
        dictionary.open(handle);
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
  store.subscribe((state) => {
    if (state.captureTab === captureTab) return;
    captureTab = state.captureTab;
    applyCaptureTab();
  });
  // r39a (design-r39 §1): o grupo com foco do store é o `view` do montador. Comandos, ⌘E, IA, prévia
  // e a barra de status (modo, "Tab:" com o T1/T2 desse view) passam a ele.
  let focusedGroup = store.getState().focusedGroup;
  store.subscribe((state) => {
    if (state.focusedGroup === focusedGroup) return;
    focusedGroup = state.focusedGroup;
    plugins.editor.focusGroup(focusedGroup);
    const view = plugins.editor.view;
    if (captureTab) statusBar.set('tab', { mode: view ? tabFocusMode(view) : 'indent' });
  });
  // r39c: o que o view de um grupo que saiu guardou (`takeParked`) só vale para aba aberta; fechar
  // a aba sem mostrá-la ou trocar de pasta (abas zeradas) o descarta.
  const tabOpen = (path: string) => store.getState().tabs.some((tab) => tab.id === path);
  let parkedTabs = store.getState().tabs;
  plugins.editor.retainParked(tabOpen);
  store.subscribe((state) => {
    if (state.tabs === parkedTabs) return;
    parkedTabs = state.tabs;
    plugins.editor.retainParked(tabOpen);
  });
  // "Indexar notas só na nuvem" (r36b, `index.cloudOnly` da pasta, carregado antes de o índice
  // abrir): o catálogo lê a preferência na abertura e, ligada depois, relê as notas que entraram só
  // pelo nome.
  let indexCloudOnly = store.getState().indexCloudOnly;
  store.subscribe((state) => {
    if (state.indexCloudOnly === indexCloudOnly) return;
    indexCloudOnly = state.indexCloudOnly;
    catalog.setIndexCloudOnly(indexCloudOnly);
  });
  // Contador de IA da sessão (r31, D-R31-05): o Rust publica o total acumulado a cada pedido que
  // passa pelo `ai_send` — também os de plugins, que alcançam o IPC. Vale até o app fechar.
  platform.ai.onUsage((usage) => statusBar.set('ai', usage));
  // SED-INVALID: o aviso `config-field` do carregamento cita o campo (D-R7-ST-04).
  const captureTabInvalid = watchFieldWarning(store, 'editor.captureTab', (s) => s.captureTab);
  const defaultModeInvalid = watchFieldWarning(
    store,
    'editor.defaultMode',
    (s) => s.editorDefaultMode,
  );
  // r12 (arch-backend §4, D-R12-B3): cada listagem pronta reconcilia as cores de pasta com as
  // pastas que existem (abertura e mudanças vistas pelo observador), sem tocar a sincronização.
  let listedEntries = store.getState().entries;
  store.subscribe((state) => {
    if (state.entries === listedEntries || state.listStatus !== 'ready') return;
    listedEntries = state.entries;
    settings.reconcileFolders(state.entries);
  });
  const imageSource = () => plugins.editor.view?.state.facet(imageSourceFacet) ?? null;
  // Wikilinks exportados como texto; inexistentes com a classe própria (r7 S2, AC-EX.3).
  const wikilinks = (notePath: string) => ({
    exists: (target: string) => catalog.links.exists(target, notePath),
  });
  const exporter = new ExportController({
    platform,
    store,
    registry,
    clock,
    enabled: (id) => settings.internalPluginEnabled(id),
    // A cache de imagens da janela (S1) é a do editor principal (serviço em `editor/services.ts`).
    imageSource,
    wikilinks,
  });
  // A mesma cache, os mesmos plugins ligados e o mesmo resolvedor de wikilinks da exportação.
  const preview = new PreviewController({
    store,
    registry,
    clock,
    enabled: (id) => settings.internalPluginEnabled(id),
    imageSource,
    wikilinks,
    view: () => plugins.editor.view,
    onViewChange: (listener) => plugins.editor.onApplied(listener),
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
    preview,
    dictionary,
    spellCoverage,
    captureTabInvalid,
    defaultModeInvalid,
  };
}

/**
 * SED-INVALID de um campo do `config.json`: acende com o aviso `config-field` que cita `field` e
 * apaga quando o valor do campo muda (o usuário escolheu outro) ou a pasta troca.
 */
function watchFieldWarning(
  store: AppStore,
  field: string,
  valueOf: (state: AppState) => unknown,
): ConfigFieldWarning {
  const flag = new ConfigFieldWarning();
  let value = valueOf(store.getState());
  let seenWarning: string | null = null;
  let warnedHandle = store.getState().handle;
  store.subscribe((state) => {
    if (valueOf(state) !== value) {
      value = valueOf(state);
      flag.set(false);
    }
    // O `config.json` é lido ANTES de a pasta entrar no store (o aviso chega antes do `handle`): ao
    // trocar de pasta, a bandeira passa a refletir o aviso que está valendo agora.
    const warning = state.notices.find(
      (n) => n.notice === 'config-field' && n.detail?.split(', ').includes(field),
    );
    if (state.handle !== warnedHandle) {
      warnedHandle = state.handle;
      seenWarning = warning?.id ?? null;
      flag.set(warning !== undefined && state.handle !== null);
    } else if (warning && warning.id !== seenWarning) {
      seenWarning = warning.id;
      flag.set(true);
    }
  });
  return flag;
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
