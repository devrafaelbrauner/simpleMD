import {
  EXPLORER_INTENSITIES,
  EXPLORER_SCOPES,
  EXPLORER_STYLES,
  FONT_FAMILY_NAMES,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  clampFontSize,
  isFontFamilyName,
  type ExplorerAppearance,
  type FontFamilyName,
} from '@simplemd/themes';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import {
  EXPLORER_INTENSITY_LABELS,
  EXPLORER_SCOPE_LABELS,
  EXPLORER_STYLE_LABELS,
  STR_EXPLORER_DOT_HINT,
  STR_EXPLORER_RAINBOW_HINT,
  STR_EXPLORER_SCOPE_HINT,
  STR_EXPLORER_STYLE_HINT,
} from '../lib/explorer-appearance';
import { Icon } from '../lib/icons';

/** Onde as preferências vão parar (linha de persistência, STR-29 / STR-47). */
export type PersistenceState = 'session' | 'saved' | 'malformed' | 'failed';

export interface SettingsThemeOption {
  readonly id: string;
  readonly name: string;
}

export interface SettingsDialogProps {
  open: boolean;
  onClose(): void;
  /** Embutidos primeiro, depois os do vault por nome (arch-ux §2.3). */
  themes: readonly SettingsThemeOption[];
  themeId: string;
  onThemeChange(id: string): void;
  fontFamily: FontFamilyName;
  onFontFamilyChange(name: FontFamilyName): void;
  fontSize: number;
  /** Já limitado a 10–32 (UX-D17). */
  onFontSizeChange(size: number): void;
  ligatures: boolean;
  onLigaturesChange(on: boolean): void;
  persistence: PersistenceState;
  /** Etapa 5: abre o editor de temas (L3). */
  onOpenThemeEditor(): void;
  /** Há uma pasta aberta: sem ela, importar fica indisponível (STR-39). */
  canImport: boolean;
  /**
   * Importar pelo diálogo nativo (Tauri). Sem ele (harness no Chromium), o botão aciona um
   * `<input type=file>` escondido (`set-import-input`) e o arquivo chega por `onImportFile`.
   */
  onImport?: () => void;
  onImportFile(file: File): void;
  /** Mensagem STR-32 do último erro de importação; recebe o foco quando aparece (AC-5.9). */
  importError: string | null;
  onExport(): void;
  /** Seção ativa; a engrenagem e `Mod-,` abrem "Aparência" (r1 SET-OPEN). */
  section: SettingsSectionId;
  onSectionChange(section: SettingsSectionId): void;
  /**
   * Estilo do explorador GUARDADO (r13 F5; não o efetivo: em Bolinha os controles desabilitados
   * mostram o valor que volta ao trocar o estilo, D-R13-U2).
   */
  explorer: ExplorerAppearance;
  /** Cada controle da seção Explorador manda só o campo que mudou; vale na hora (AC-13.2). */
  onExplorerChange(patch: Partial<ExplorerAppearance>): void;
  /** Conteúdo da seção "Plugins" (o gerenciador). */
  plugins: ReactNode;
  /** Conteúdo da seção "Editor" (r7 R-X7.1) e o foco inicial dela (o interruptor). */
  editor?: ReactNode;
  editorInitialFocus?: RefObject<HTMLButtonElement | null>;
  /** Conteúdo da seção "Autocompletar" (etapa 8) e o foco inicial dela (o interruptor). */
  autocomplete?: ReactNode;
  autocompleteInitialFocus?: RefObject<HTMLButtonElement | null>;
  /** Conteúdo da seção "IA" (etapa 11) e o foco inicial dela ("Provedor"). */
  ai?: ReactNode;
  aiInitialFocus?: RefObject<HTMLSelectElement | null>;
  /** Foco inicial quando aberto em "Plugins" ("Recarregar lista", arch-ux r2 UX-R2-D8). */
  pluginsInitialFocus?: RefObject<HTMLButtonElement | null>;
  /** Região viva local do diálogo (UX-R2-D21): mudanças causadas por ações dentro do L2. */
  liveMessage: string;
}

/**
 * Seções do L2 (arch-ux r2 §3.3; r7 UX-R7-D10): Aparência, Editor (r7, em segundo),
 * Autocompletar (etapa 8), IA (etapa 11), Plugins.
 */
export type SettingsSectionId = 'appearance' | 'editor' | 'autocomplete' | 'ai' | 'plugins';

const SECTIONS: ReadonlyArray<{ id: SettingsSectionId; label: string }> = [
  { id: 'appearance', label: 'Aparência' },
  { id: 'editor', label: 'Editor' },
  { id: 'autocomplete', label: 'Autocompletar' },
  { id: 'ai', label: 'IA' },
  { id: 'plugins', label: 'Plugins' },
];

const PERSISTENCE_TEXT: Record<PersistenceState, string> = {
  session: 'Sem pasta aberta: as preferências valem só nesta sessão.',
  saved: 'As preferências são salvas em .simplemd/config.json.',
  malformed: 'O arquivo .simplemd/config.json é inválido; as preferências valem só nesta sessão.',
  failed:
    'Não foi possível salvar as preferências em .simplemd/config.json. Elas valem só nesta sessão.',
};

/**
 * L2 CONFIGURAÇÕES (arch-ux §2.3 e r2 §3.3, DESIGN §8.2/§8.7/§8.13): abas de seção "Seções"
 * (Aparência = conteúdo do r1, Plugins = gerenciador), faixa de status fixa com a linha de
 * persistência e uma região viva local (UX-R2-D21). Cada mudança vale na hora (R-4.7). Foco
 * inicial no "Tema" (ou em "Recarregar lista" quando aberto em "Plugins"); Esc e "Fechar" devolvem
 * o foco a quem abriu.
 */
export function SettingsDialog(props: SettingsDialogProps) {
  const { open, onClose, themes, themeId, fontFamily, fontSize, ligatures, persistence } = props;
  const { section, onSectionChange, explorer, onExplorerChange } = props;
  const dot = explorer.style === 'dot';
  const themeSelect = useRef<HTMLSelectElement>(null);
  /** Texto cru enquanto o usuário digita o tamanho; `null` = mostra o valor aplicado. */
  const [sizeDraft, setSizeDraft] = useState<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const importAlert = useRef<HTMLDivElement>(null);
  const { importError } = props;

  // O alerta de importação recebe o foco programaticamente para ser lido (arch-ux F7).
  useEffect(() => {
    if (importError !== null) importAlert.current?.focus();
  }, [importError]);

  const commitSize = () => {
    if (sizeDraft === null) return;
    const typed = Number(sizeDraft);
    setSizeDraft(null);
    if (sizeDraft.trim() === '' || !Number.isFinite(typed)) return;
    const size = clampFontSize(typed);
    if (size !== fontSize) props.onFontSizeChange(size);
  };

  const warn = persistence === 'failed' || persistence === 'malformed';

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = SECTIONS.findIndex((s) => s.id === section);
    const target =
      event.key === 'ArrowRight'
        ? SECTIONS[(index + 1) % SECTIONS.length]
        : event.key === 'ArrowLeft'
          ? SECTIONS[(index - 1 + SECTIONS.length) % SECTIONS.length]
          : event.key === 'Home'
            ? SECTIONS[0]
            : event.key === 'End'
              ? SECTIONS[SECTIONS.length - 1]
              : undefined;
    if (!target) return;
    event.preventDefault();
    onSectionChange(target.id);
    requestAnimationFrame(() => document.getElementById(`settings-tab-${target.id}`)?.focus());
  };

  const appearance = (
    <>
      {/* Sem aria-labelledby: o nome "Tema" fica só no select (getByLabel('Tema') sem ambiguidade). */}
      <section className="smd-section">
        <h3 id="settings-theme-heading" className="smd-section-title">
          Tema
        </h3>
        <div className="smd-field">
          <label htmlFor="settings-theme">Tema</label>
          <select
            id="settings-theme"
            ref={themeSelect}
            className="smd-input"
            value={themeId}
            onChange={(event) => props.onThemeChange(event.target.value)}
          >
            {themes.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.name}
              </option>
            ))}
          </select>
        </div>
        <div className="smd-actions">
          <Button data-testid="open-theme-editor" onClick={props.onOpenThemeEditor}>
            Editor de temas…
          </Button>
          <Button
            data-testid="set-import"
            aria-disabled={!props.canImport || undefined}
            aria-describedby={props.canImport ? undefined : 'set-novault'}
            onClick={() => (props.onImport ? props.onImport() : importInput.current?.click())}
          >
            Importar tema…
          </Button>
          <Button data-testid="set-export" onClick={props.onExport}>
            Exportar tema…
          </Button>
        </div>
        {!props.onImport && (
          <input
            ref={importInput}
            type="file"
            accept=".json,application/json"
            hidden
            tabIndex={-1}
            data-testid="set-import-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) props.onImportFile(file);
            }}
          />
        )}
        {!props.canImport && (
          <p id="set-novault" className="smd-hint">
            Abra uma pasta para salvar ou importar temas.
          </p>
        )}
        <div
          ref={importAlert}
          className="smd-ialert"
          role="alert"
          tabIndex={-1}
          data-testid="set-import-error"
        >
          {importError !== null && (
            <>
              <Icon name="warn" />
              <p>{importError}</p>
            </>
          )}
        </div>
      </section>

      <section className="smd-section">
        <h3 id="settings-font-heading" className="smd-section-title">
          Fonte do editor
        </h3>
        <div className="smd-field">
          <label htmlFor="settings-font-family">Família</label>
          <select
            id="settings-font-family"
            className="smd-input"
            value={fontFamily}
            onChange={(event) => {
              if (isFontFamilyName(event.target.value))
                props.onFontFamilyChange(event.target.value);
            }}
          >
            {FONT_FAMILY_NAMES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="smd-field">
          <label htmlFor="settings-font-size">Tamanho (px)</label>
          <input
            id="settings-font-size"
            className="smd-input smd-input-number"
            type="number"
            inputMode="numeric"
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            step={1}
            aria-describedby="settings-font-size-hint"
            value={sizeDraft ?? String(fontSize)}
            onChange={(event) => setSizeDraft(event.target.value)}
            onBlur={commitSize}
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter') commitSize();
            }}
          />
          <span id="settings-font-size-hint" className="smd-hint">
            Entre 10 e 32.
          </span>
        </div>
        <div className="smd-field smd-field-inline">
          <input
            id="settings-ligatures"
            className="smd-switch"
            type="checkbox"
            role="switch"
            checked={ligatures}
            onChange={(event) => props.onLigaturesChange(event.target.checked)}
          />
          <label htmlFor="settings-ligatures">Ligaduras</label>
          <span className="smd-switch-state" aria-hidden="true">
            {ligatures ? 'Ativadas' : 'Desativadas'}
          </span>
        </div>
      </section>

      {/* r13 (DESIGN r13 §6.6, D-R13-U1/U2): aplica no onChange; Esc não desfaz. */}
      <section className="smd-section">
        <h3 id="settings-explorer-heading" className="smd-section-title">
          Explorador
        </h3>
        <div className="smd-field">
          <label htmlFor="settings-explorer-style">Estilo</label>
          <select
            id="settings-explorer-style"
            className="smd-input"
            value={explorer.style}
            aria-describedby={
              dot
                ? 'settings-explorer-style-hint settings-explorer-dot-hint'
                : 'settings-explorer-style-hint'
            }
            onChange={(event) => {
              const style = EXPLORER_STYLES.find((id) => id === event.target.value);
              if (style) onExplorerChange({ style });
            }}
          >
            {EXPLORER_STYLES.map((id) => (
              <option key={id} value={id}>
                {EXPLORER_STYLE_LABELS[id]}
              </option>
            ))}
          </select>
          <span id="settings-explorer-style-hint" className="smd-hint">
            {STR_EXPLORER_STYLE_HINT}
          </span>
        </div>
        <div className="smd-field">
          <div className="smd-field-inline">
            <input
              id="settings-explorer-rainbow"
              className="smd-switch"
              type="checkbox"
              role="switch"
              checked={explorer.auto === 'rainbow'}
              aria-describedby="settings-explorer-rainbow-hint"
              onChange={(event) =>
                onExplorerChange({ auto: event.target.checked ? 'rainbow' : 'off' })
              }
            />
            <label htmlFor="settings-explorer-rainbow">Arco-íris nas pastas do topo</label>
            <span className="smd-switch-state" aria-hidden="true">
              {explorer.auto === 'rainbow' ? 'Ligado' : 'Desligado'}
            </span>
          </div>
          <span id="settings-explorer-rainbow-hint" className="smd-hint">
            {STR_EXPLORER_RAINBOW_HINT}
          </span>
        </div>
        {/* STR-R13-04 logo acima do par desabilitado (D-R13-D06); só existe em Bolinha. */}
        {dot && (
          <p id="settings-explorer-dot-hint" className="smd-hint">
            {STR_EXPLORER_DOT_HINT}
          </p>
        )}
        <div className="smd-field">
          <label htmlFor="settings-explorer-intensity">Intensidade</label>
          <select
            id="settings-explorer-intensity"
            className="smd-input"
            value={explorer.intensity}
            disabled={dot}
            aria-describedby={dot ? 'settings-explorer-dot-hint' : undefined}
            onChange={(event) => {
              const intensity = EXPLORER_INTENSITIES.find((id) => id === event.target.value);
              if (intensity) onExplorerChange({ intensity });
            }}
          >
            {EXPLORER_INTENSITIES.map((id) => (
              <option key={id} value={id}>
                {EXPLORER_INTENSITY_LABELS[id]}
              </option>
            ))}
          </select>
        </div>
        <div className="smd-field">
          <label htmlFor="settings-explorer-scope">Onde aplicar</label>
          <select
            id="settings-explorer-scope"
            className="smd-input"
            value={explorer.scope}
            disabled={dot}
            aria-describedby={
              dot
                ? 'settings-explorer-scope-hint settings-explorer-dot-hint'
                : 'settings-explorer-scope-hint'
            }
            onChange={(event) => {
              const scope = EXPLORER_SCOPES.find((id) => id === event.target.value);
              if (scope) onExplorerChange({ scope });
            }}
          >
            {EXPLORER_SCOPES.map((id) => (
              <option key={id} value={id}>
                {EXPLORER_SCOPE_LABELS[id]}
              </option>
            ))}
          </select>
          <span id="settings-explorer-scope-hint" className="smd-hint">
            {STR_EXPLORER_SCOPE_HINT}
          </span>
        </div>
      </section>
    </>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Configurações"
      data-testid="settings-dialog"
      className="smd-settings"
      initialFocus={
        section === 'plugins' && props.pluginsInitialFocus
          ? props.pluginsInitialFocus
          : section === 'editor' && props.editorInitialFocus
            ? props.editorInitialFocus
            : section === 'autocomplete' && props.autocompleteInitialFocus
              ? props.autocompleteInitialFocus
              : section === 'ai' && props.aiInitialFocus
                ? props.aiInitialFocus
                : themeSelect
      }
      footer={
        <Button variant="secondary" data-testid="settings-close" onClick={onClose}>
          Fechar
        </Button>
      }
      status={
        <>
          <p
            className="smd-persistence"
            role={persistence === 'failed' ? 'alert' : 'status'}
            data-testid="settings-persistence"
            data-state={persistence}
          >
            <Icon name={warn ? 'warn' : 'info'} className={warn ? 'smd-danger' : 'smd-muted'} />
            <span>{PERSISTENCE_TEXT[persistence]}</span>
          </p>
          <p className="sr-only" role="status" data-testid="settings-live">
            {props.liveMessage}
          </p>
        </>
      }
    >
      <div role="tablist" aria-label="Seções" className="smd-sections" onKeyDown={onTabKey}>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            id={`settings-tab-${s.id}`}
            className="smd-section-tab"
            aria-selected={s.id === section}
            aria-controls={`settings-panel-${s.id}`}
            tabIndex={s.id === section ? 0 : -1}
            data-testid="settings-tab"
            data-section={s.id}
            onClick={() => onSectionChange(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`settings-panel-${section}`}
        aria-labelledby={`settings-tab-${section}`}
        className="smd-section-panel"
      >
        {section === 'plugins'
          ? props.plugins
          : section === 'editor'
            ? props.editor
            : section === 'autocomplete'
              ? props.autocomplete
              : section === 'ai'
                ? props.ai
                : appearance}
      </div>
    </Dialog>
  );
}
