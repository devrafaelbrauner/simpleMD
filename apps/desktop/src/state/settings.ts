import {
  BUILTIN_THEMES,
  DEFAULT_PREFERENCES,
  clampFontSize,
  fontOption,
  loadPreferences,
  resolveTokens,
  savePreferences,
  simplemdLight,
  type FontFamilyName,
  type LoadedPreferences,
  type Theme,
  type ThemeBase,
  type Tokens,
} from '@simplemd/themes';
import type { VaultHandle } from '@simplemd/vault';
import type { AppPlatform } from '../platform/types';
import type { AppStore, EditorPrefs } from './store';
import type { Clock } from './sync';

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

  constructor({ platform, store, clock, root }: SettingsDeps) {
    this.#platform = platform;
    this.#store = store;
    this.#clock = clock;
    this.#root = root;
  }

  /** Temas do seletor: embutidos primeiro (claro, escuro). */
  themes(): readonly Theme[] {
    return BUILTIN_THEMES;
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
    const loaded = await loadPreferences(
      this.#platform.vault,
      handle,
      (id) => this.#find(id) !== undefined,
    );
    if (generation !== this.#generation) return;
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
    this.#reportLoad(loaded);
    this.#applyTheme('simplemd:theme-applied');
    this.#root.setLigatures(prefs.fontLigatures);
  }

  /** Pasta fechada (volta às boas-vindas): padrões, só na sessão. */
  reset(): void {
    this.#cancelSave();
    this.#generation++;
    this.#store.getState().dismissNoticeKey(CONFIG_NOTICE_KEY);
    this.#store.setState({
      themeId: DEFAULT_PREFERENCES.theme,
      prefs: DEFAULT_EDITOR_PREFS,
      persistence: 'session',
    });
    this.#applyTheme('simplemd:theme-applied');
    this.#root.setLigatures(DEFAULT_EDITOR_PREFS.fontLigatures);
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

  // ---- Internos -----------------------------------------------------------------------------

  #find(id: string): Theme | undefined {
    return this.themes().find((theme) => theme.id === id);
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
      const result = await savePreferences(this.#platform.vault, handle, prefs);
      if (generation !== this.#generation) return;
      if (result.status === 'malformed') {
        this.#store.setState({ persistence: 'malformed' });
        this.#reportLoad({ status: 'malformed', prefs, warnings: [] });
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
