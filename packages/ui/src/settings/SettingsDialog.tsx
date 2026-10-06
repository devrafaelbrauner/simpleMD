import {
  FONT_FAMILY_NAMES,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  clampFontSize,
  isFontFamilyName,
  type FontFamilyName,
} from '@simplemd/themes';
import { useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
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
}

const PERSISTENCE_TEXT: Record<PersistenceState, string> = {
  session: 'Sem pasta aberta: as preferências valem só nesta sessão.',
  saved: 'As preferências são salvas em .simplemd/config.json.',
  malformed: 'O arquivo .simplemd/config.json é inválido; as preferências valem só nesta sessão.',
  failed:
    'Não foi possível salvar as preferências em .simplemd/config.json. Elas valem só nesta sessão.',
};

/**
 * L2 CONFIGURAÇÕES (arch-ux §2.3, DESIGN §8.2/§8.7): tema, família, tamanho e ligaduras. Cada
 * mudança vale na hora, sem botão "Aplicar" (R-4.7). Foco inicial no "Tema"; Esc e "Fechar"
 * devolvem o foco a quem abriu.
 */
export function SettingsDialog(props: SettingsDialogProps) {
  const { open, onClose, themes, themeId, fontFamily, fontSize, ligatures, persistence } = props;
  const themeSelect = useRef<HTMLSelectElement>(null);
  /** Texto cru enquanto o usuário digita o tamanho; `null` = mostra o valor aplicado. */
  const [sizeDraft, setSizeDraft] = useState<string | null>(null);

  const commitSize = () => {
    if (sizeDraft === null) return;
    const typed = Number(sizeDraft);
    setSizeDraft(null);
    if (sizeDraft.trim() === '' || !Number.isFinite(typed)) return;
    const size = clampFontSize(typed);
    if (size !== fontSize) props.onFontSizeChange(size);
  };

  const warn = persistence === 'failed' || persistence === 'malformed';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Configurações"
      data-testid="settings-dialog"
      className="smd-settings"
      initialFocus={themeSelect}
      footer={
        <Button variant="secondary" data-testid="settings-close" onClick={onClose}>
          Fechar
        </Button>
      }
    >
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

      <p
        className="smd-persistence"
        role={persistence === 'failed' ? 'alert' : 'status'}
        data-testid="settings-persistence"
        data-state={persistence}
      >
        <Icon name={warn ? 'warn' : 'info'} className={warn ? 'smd-danger' : 'smd-muted'} />
        <span>{PERSISTENCE_TEXT[persistence]}</span>
      </p>
    </Dialog>
  );
}
