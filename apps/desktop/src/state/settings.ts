import {
  BUILTIN_THEMES,
  DEFAULT_PREFERENCES,
  THEME_MAX_BYTES,
  clampFontSize,
  exportThemeBytes,
  fontOption,
  importTheme,
  listUserThemes,
  loadPreferences,
  resolveTokens,
  savePreferences,
  saveTheme,
  simplemdLight,
  type FontFamilyName,
  type LoadedPreferences,
  type PreferenceWarning,
  type Theme,
  type ThemeBase,
  type ThemeDraft,
  type Tokens,
  type UserThemeWarning,
} from '@simplemd/themes';
import { isJsonObject, type JsonObject, type VaultHandle } from '@simplemd/vault';
import type { AppPlatform, PickedFile } from '../platform/types';
import type { AppStore, EditorPrefs } from './store';
import type { Clock } from './sync';

const byName = new Intl.Collator('pt-BR', { sensitivity: 'base' });
const sortThemes = (themes: Theme[]) =>
  [...themes].sort((a, b) => byName.compare(a.name, b.name) || (a.id < b.id ? -1 : 1));

/**
 * Onde o tema e as fontes são aplicados: o `<html>` no app (com a janela de supressão de
 * transições, DESIGN §10) ou um dublê nos testes.
 */
export interface RootTarget {
  applyTheme(tokens: Tokens, base: ThemeBase, mark: string): void;
  setLigatures(on: boolean): void;
  /** Espera a fonte embutida carregar (`document.fonts.load`) antes de medir/verificar. */
  loadFont(family: string, sizePx: number): Promise<void>;
}

/** Gravação do `config.json`: debounce de 300 ms depois da última mudança (arch-frontend §7.4). */
export const PREFS_SAVE_DEBOUNCE_MS = 300;
/** Chave dos avisos do `config.json` (substituídos a cada pasta aberta). */
const CONFIG_NOTICE_KEY = 'config';

const DEFAULT_EDITOR_PREFS: EditorPrefs = {
  fontFamily: DEFAULT_PREFERENCES.fontFamily,
  fontSize: DEFAULT_PREFERENCES.fontSize,
  fontLigatures: DEFAULT_PREFERENCES.fontLigatures,
};

export interface SettingsDeps {
  readonly platform: AppPlatform;
  readonly store: AppStore;
  readonly clock: Clock;
  readonly root: RootTarget;
}

/**
 * Tema e preferências do editor (R-4.3…R-4.7; arch-frontend §7.4, arch-backend §1.6). Cada mudança
 * vale na hora (store + `<html>`); com uma pasta aberta, vai para `.simplemd/config.json` com
 * ler-mesclar-gravar. Sem pasta, ou com o `config.json` malformado, as mudanças valem só na sessão
 * e o arquivo nunca é tocado (F-9, STR-47).
 */
export class SettingsController {
  readonly #platform: AppPlatform;
  readonly #store: AppStore;
  readonly #clock: Clock;
  readonly #root: RootTarget;
  #saveTimer: unknown = null;
  #saving: Promise<void> | null = null;
  #saveAgain = false;
  /** Geração da pasta: uma gravação atrasada da pasta anterior nunca muda o estado atual. */
  #generation = 0;
  /**
   * Tema e fontes escolhidos antes de abrir uma pasta (só da sessão, R-4.6). Se a primeira abertura
   * falhar e o app voltar às boas-vindas, eles voltam também, em vez dos padrões (UIF F-03).
   */
  #sessionChoice: { themeId: string; prefs: EditorPrefs } | null = null;
  /**
   * Plugins internos ligados/desligados (`config.json` `plugins.internal.<id>`, padrão ligado;
   * R-7.6). Só as escolhas explícitas: um `config.json` sem a seção continua sem ela.
   */
  #internalPlugins: Record<string, boolean> = {};

  constructor({ platform, store, clock, root }: SettingsDeps) {
    this.#platform = platform;
    this.#store = store;
    this.#clock = clock;
    this.#root = root;
  }

  /** Temas do seletor: embutidos primeiro (claro, escuro), depois os do vault por nome. */
  themes(): readonly Theme[] {
    return [...BUILTIN_THEMES, ...this.#store.getState().userThemes];
  }

  /** Na partida, sem pasta: só o atributo de ligaduras; o claro vem de tokens.css (DV-10). */
  init(): void {
    this.#root.setLigatures(this.#store.getState().prefs.fontLigatures);
  }

  /**
   * Pasta aberta: lê `config.json` (nunca grava) e aplica tema e fontes ANTES de a casca aparecer
   * (A-20, SET-RESTORED). Malformado → padrões + aviso persistente; erro de leitura → padrões +
   * alerta; campos inválidos → padrão do campo + aviso.
   */
  async loadForVault(handle: VaultHandle): Promise<void> {
    this.#cancelSave();
    const generation = ++this.#generation;
    const current = this.#store.getState();
    if (current.persistence === 'session') {
      this.#sessionChoice = { themeId: current.themeId, prefs: current.prefs };
    }
    const listed = await listUserThemes(this.#platform.vault, handle).catch(() => ({
      themes: [],
      warnings: [] as UserThemeWarning[],
    }));
    if (generation !== this.#generation) return;
    this.#store.setState({ userThemes: sortThemes(listed.themes) });
    const loaded = await loadPreferences(
      this.#platform.vault,
      handle,
      (id) => this.#find(id) !== undefined,
    );
    if (generation !== this.#generation) return;
    this.#reportThemeWarnings(listed.warnings);
    const sectionWarnings = this.#readInternalPlugins(loaded.config);
    const { prefs } = loaded;
    this.#store.setState({
      themeId: prefs.theme,
      prefs: {
        fontFamily: prefs.fontFamily,
        fontSize: prefs.fontSize,
        fontLigatures: prefs.fontLigatures,
      },
      persistence:
        loaded.status === 'malformed'
          ? 'malformed'
          : loaded.status === 'unreadable'
            ? 'failed'
            : 'saved',
    });
    this.#reportLoad({ ...loaded, warnings: [...loaded.warnings, ...sectionWarnings] });
    this.#applyTheme('simplemd:theme-applied');
    this.#root.setLigatures(prefs.fontLigatures);
  }

  /** Plugin interno ligado? (padrão: sim). Lido pelo host de plugins ao abrir a pasta. */
  internalPluginEnabled(id: string): boolean {
    return this.#internalPlugins[id] ?? true;
  }

  /** Interruptor de um plugin interno no gerenciador (sem aviso): vale já e vai para o config.json. */
  setInternalPlugin(id: string, enabled: boolean): void {
    if (this.#internalPlugins[id] === enabled) return;
    this.#internalPlugins = { ...this.#internalPlugins, [id]: enabled };
    this.#scheduleSave();
  }

  /**
   * A pasta não chegou a abrir (volta às boas-vindas): o que estava valendo na sessão antes dela,
   * ou os padrões. Nada é gravado (sem pasta).
   */
  reset(): void {
    this.#cancelSave();
    this.#generation++;
    this.#store.getState().dismissNoticeKey(CONFIG_NOTICE_KEY);
    const restored = this.#sessionChoice ?? {
      themeId: DEFAULT_PREFERENCES.theme,
      prefs: DEFAULT_EDITOR_PREFS,
    };
    this.#sessionChoice = null;
    this.#internalPlugins = {};
    this.#store.setState({ ...restored, persistence: 'session', userThemes: [] });
    this.#applyTheme('simplemd:theme-applied');
    this.#root.setLigatures(restored.prefs.fontLigatures);
  }

  setTheme(id: string): void {
    if (this.#find(id) === undefined || id === this.#store.getState().themeId) return;
    this.#store.setState({ themeId: id });
    this.#applyTheme('simplemd:theme-applied');
    this.#scheduleSave();
  }

  setFontFamily(fontFamily: FontFamilyName): void {
    const { prefs } = this.#store.getState();
    if (fontFamily === prefs.fontFamily) return;
    this.#store.setState({ prefs: { ...prefs, fontFamily } });
    this.#applyTheme('simplemd:font-applied');
    const font = fontOption(fontFamily);
    if (font.bundled) void this.#root.loadFont(font.family, prefs.fontSize);
    this.#scheduleSave();
  }

  /** Limita a 10–32 (UX-D17, AC-4.6). */
  setFontSize(size: number): void {
    const { prefs } = this.#store.getState();
    const fontSize = clampFontSize(size);
    if (!Number.isFinite(fontSize) || fontSize === prefs.fontSize) return;
    this.#store.setState({ prefs: { ...prefs, fontSize } });
    this.#applyTheme('simplemd:font-applied');
    this.#scheduleSave();
  }

  setLigatures(fontLigatures: boolean): void {
    const { prefs } = this.#store.getState();
    if (fontLigatures === prefs.fontLigatures) return;
    this.#store.setState({ prefs: { ...prefs, fontLigatures } });
    this.#root.setLigatures(fontLigatures);
    this.#scheduleSave();
  }

  /** Grava agora o que estiver pendente (fechar a janela, trocar de pasta). */
  async flush(): Promise<void> {
    if (this.#saveTimer !== null) {
      this.#cancelSave();
      await this.#save();
    } else {
      await this.#saving;
    }
  }

  dispose(): void {
    this.#cancelSave();
    this.#generation++;
  }

  // ---- Etapa 5: editor de temas, importar e exportar ----------------------------------------

  /**
   * "Salvar como novo tema" (R-5.4, AC-5.4): grava `.simplemd/themes/<slug>/theme.json` (nunca
   * sobrescreve; `-2`, `-3`…), ativa o tema na raiz e o persiste em `config.json`. `false` = falhou
   * e nada foi ativado (STR-38).
   */
  async saveNewTheme(draft: ThemeDraft): Promise<boolean> {
    const handle = this.#store.getState().handle;
    if (!handle) return false;
    const file = { name: draft.name, base: draft.base, tokens: draft.tokens };
    let id: string;
    try {
      ({ id } = await saveTheme(this.#platform.vault, handle, file));
    } catch {
      return false;
    }
    if (this.#store.getState().handle !== handle) return false;
    this.#addUserTheme({ ...file, id, builtin: false });
    this.setTheme(id);
    this.#store.getState().pushNotice({
      kind: 'info',
      notice: 'theme-saved',
      text: `Tema “${draft.name}” salvo em .simplemd/themes/${id}/ e ativado.`,
    });
    return true;
  }

  /** "Importar tema…" pelo diálogo nativo (Tauri). Cancelar não muda nada nem avisa. */
  async importFromDialog(): Promise<void> {
    const pick = this.#platform.pickFile;
    if (!pick || !this.#store.getState().handle) return;
    this.#store.setState({ importError: null });
    let file: PickedFile | null;
    try {
      file = await pick();
    } catch {
      this.#store.setState({ importError: 'Não foi possível abrir o arquivo. Nada foi gravado.' });
      return;
    }
    if (file) await this.importFile(file);
  }

  /**
   * Importa um `theme.json` (R-5.6, AC-5.8/5.9): mais de 256 KB é recusado ANTES de ler; inválido
   * mostra o primeiro campo que falhou e grava 0 bytes; válido é copiado para o vault e entra no
   * seletor SEM ser ativado (UX-D16). O campo `css` é preservado e nunca carregado (D-5).
   */
  async importFile(file: PickedFile): Promise<void> {
    const handle = this.#store.getState().handle;
    if (!handle) return;
    this.#store.setState({ importError: null });
    const invalid = (field: string, reason: string) =>
      this.#store.setState({
        importError: `Tema inválido — campo “${field}”: ${reason}. Nada foi gravado.`,
      });
    if (file.size > THEME_MAX_BYTES) {
      // O alerta muda num quadro seguinte, então ele recebe o foco mesmo repetindo o erro.
      await Promise.resolve();
      invalid('arquivo', 'maior que 256 KB');
      return;
    }
    try {
      const result = await importTheme(this.#platform.vault, handle, await file.read());
      if (!result.ok) {
        invalid(result.error.field, result.error.message);
        return;
      }
      if (this.#store.getState().handle !== handle) return;
      this.#addUserTheme(result.theme);
      this.#store.getState().pushNotice({
        kind: 'info',
        notice: 'theme-imported',
        text: `Tema “${result.theme.name}” importado.`,
      });
    } catch {
      this.#store.setState({ importError: 'Não foi possível importar o tema. Nada foi gravado.' });
    }
  }

  /**
   * "Exportar tema…" do tema selecionado (R-5.5, AC-5.7): um tema do vault sai com os bytes
   * gravados; um embutido, com o conjunto completo composto (U-6). Nome sugerido `<id>.theme.json`.
   */
  async exportTheme(): Promise<void> {
    const { themeId, handle } = this.#store.getState();
    const theme = this.#find(themeId) ?? simplemdLight;
    try {
      const bytes = await exportThemeBytes(this.#platform.vault, handle, theme);
      const path = await this.#platform.saveFile(`${theme.id}.theme.json`, bytes);
      if (path === null) return;
      this.#store.getState().pushNotice({
        kind: 'info',
        notice: 'theme-exported',
        text: `Tema exportado para “${path}”.`,
      });
    } catch {
      this.#store.getState().pushNotice({
        kind: 'error',
        notice: 'theme-export-failed',
        text: 'Não foi possível exportar o tema.',
      });
    }
  }

  // ---- Internos -----------------------------------------------------------------------------

  #find(id: string): Theme | undefined {
    return this.themes().find((theme) => theme.id === id);
  }

  #addUserTheme(theme: Theme): void {
    const { userThemes } = this.#store.getState();
    this.#store.setState({
      userThemes: sortThemes([...userThemes.filter((t) => t.id !== theme.id), theme]),
    });
  }

  /** `plugins.internal` do config.json; valor que não é true/false → padrão + aviso do campo. */
  #readInternalPlugins(config: JsonObject | null): PreferenceWarning[] {
    this.#internalPlugins = {};
    const plugins = config?.plugins;
    if (plugins === undefined) return [];
    const internal = isJsonObject(plugins) ? plugins.internal : undefined;
    if (!isJsonObject(plugins) || (internal !== undefined && !isJsonObject(internal)))
      return [{ field: 'plugins.internal', reason: 'deve ser um objeto' }];
    const warnings: PreferenceWarning[] = [];
    for (const [id, value] of Object.entries(internal ?? {})) {
      if (typeof value === 'boolean') this.#internalPlugins[id] = value;
      else warnings.push({ field: `plugins.internal.${id}`, reason: 'deve ser true ou false' });
    }
    return warnings;
  }

  /** Mescla `plugins.internal` (só as escolhas explícitas; outras chaves ficam). */
  #writeSections(obj: JsonObject): void {
    const entries = Object.entries(this.#internalPlugins);
    if (entries.length === 0) return;
    const plugins = isJsonObject(obj.plugins) ? obj.plugins : {};
    const internal = isJsonObject(plugins.internal) ? plugins.internal : {};
    for (const [id, enabled] of entries) internal[id] = enabled;
    plugins.internal = internal;
    obj.plugins = plugins;
  }

  #reportThemeWarnings(warnings: readonly UserThemeWarning[]): void {
    if (warnings.length === 0) return;
    this.#store.getState().pushNotice({
      kind: 'info',
      notice: 'theme-invalid',
      text: 'Alguns temas de .simplemd/themes são inválidos e foram ignorados.',
      detail: warnings.map((w) => `${w.id}: ${w.field}`).join(', '),
    });
  }

  #applyTheme(mark: string): void {
    const { themeId, prefs } = this.#store.getState();
    const theme = this.#find(themeId) ?? simplemdLight;
    this.#root.applyTheme(resolveTokens(theme, prefs), theme.base, mark);
  }

  #reportLoad(loaded: LoadedPreferences): void {
    const state = this.#store.getState();
    state.dismissNoticeKey(CONFIG_NOTICE_KEY);
    if (loaded.status === 'malformed') {
      state.pushNotice({
        kind: 'info',
        notice: 'config-malformed',
        key: CONFIG_NOTICE_KEY,
        persistent: true,
        text: 'O arquivo .simplemd/config.json é inválido; usando as preferências padrão. O arquivo não foi alterado.',
      });
      return;
    }
    if (loaded.status === 'unreadable') {
      state.pushNotice({
        kind: 'error',
        notice: 'prefs-failed',
        key: CONFIG_NOTICE_KEY,
        text: 'Não foi possível ler .simplemd/config.json; usando as preferências padrão. Elas valem só nesta sessão.',
      });
      return;
    }
    const themeWarning = loaded.warnings.find((w) => w.field === 'theme');
    if (themeWarning) {
      state.pushNotice({
        kind: 'info',
        notice: 'theme-missing',
        text: `O tema salvo em .simplemd/config.json não foi encontrado; usando “${simplemdLight.name}”.`,
      });
    }
    const fields = loaded.warnings.filter((w) => w.field !== 'theme').map((w) => w.field);
    if (fields.length > 0) {
      state.pushNotice({
        kind: 'info',
        notice: 'config-field',
        key: CONFIG_NOTICE_KEY,
        text: 'Valores inválidos em .simplemd/config.json foram trocados pelo padrão.',
        detail: fields.join(', '),
      });
    }
  }

  #scheduleSave(): void {
    const { persistence } = this.#store.getState();
    if (persistence === 'session' || persistence === 'malformed') return;
    this.#cancelSave();
    this.#saveTimer = this.#clock.setTimeout(() => {
      this.#saveTimer = null;
      void this.#save();
    }, PREFS_SAVE_DEBOUNCE_MS);
  }

  #cancelSave(): void {
    if (this.#saveTimer !== null) this.#clock.clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
  }

  /** Uma gravação por vez; mudanças durante a gravação geram mais uma, com o estado mais novo. */
  #save(): Promise<void> {
    if (this.#saving) {
      this.#saveAgain = true;
      return this.#saving;
    }
    const generation = this.#generation;
    this.#saving = (async () => {
      do {
        this.#saveAgain = false;
        await this.#saveOnce(generation);
      } while (this.#saveAgain && generation === this.#generation);
    })().finally(() => {
      this.#saving = null;
    });
    return this.#saving;
  }

  async #saveOnce(generation: number): Promise<void> {
    const state = this.#store.getState();
    const handle = state.handle;
    if (!handle || state.persistence === 'session' || state.persistence === 'malformed') return;
    const prefs = { theme: state.themeId, ...state.prefs };
    try {
      const result = await savePreferences(this.#platform.vault, handle, prefs, (obj) =>
        this.#writeSections(obj),
      );
      if (generation !== this.#generation) return;
      if (result.status === 'malformed') {
        this.#store.setState({ persistence: 'malformed' });
        this.#reportLoad({ status: 'malformed', prefs, warnings: [], config: null });
        return;
      }
      if (this.#store.getState().persistence === 'failed')
        state.dismissNoticeKey(CONFIG_NOTICE_KEY);
      this.#store.setState({ persistence: 'saved' });
    } catch {
      if (generation !== this.#generation) return;
      this.#store.setState({ persistence: 'failed' });
      state.pushNotice({
        kind: 'error',
        notice: 'prefs-failed',
        key: CONFIG_NOTICE_KEY,
        text: 'Não foi possível salvar as preferências em .simplemd/config.json. Elas valem só nesta sessão.',
      });
    }
  }
}
