import type { AutocompleteSettings, SnippetPrefix } from '@simplemd/core';
import { useState, type Ref } from 'react';
import { Switch } from '../components/ui/switch';
import { isMac } from '../lib/platform-keys';

export interface AutocompleteSectionProps {
  settings: AutocompleteSettings;
  onChange(patch: Partial<AutocompleteSettings>): void;
  /** Foco inicial do L2 nesta seção: o interruptor (SAC-OPEN). */
  switchRef?: Ref<HTMLButtonElement>;
}

/**
 * L2 "Autocompletar" (R-8.2; DESIGN §8.13; STR-93): interruptor com "Ligado"/"Desligado", "Quando
 * sugerir", "Mínimo de letras" (2–5, limitado ao confirmar), fieldset "Fontes" e "Prefixo dos
 * snippets". Os controles seguem habilitados com o interruptor desligado (os valores ficam).
 */
export function AutocompleteSection({ settings, onChange, switchRef }: AutocompleteSectionProps) {
  const [minDraft, setMinDraft] = useState<string | null>(null);
  const commitMin = () => {
    if (minDraft === null) return;
    const value = Number(minDraft);
    setMinDraft(null);
    if (Number.isFinite(value) && minDraft.trim() !== '') onChange({ minChars: value });
  };
  const source = (key: keyof AutocompleteSettings['sources'], label: string) => (
    <label className="smd-check">
      <input
        type="checkbox"
        id={`set-ac-${key}`}
        checked={settings.sources[key]}
        onChange={(event) =>
          onChange({ sources: { ...settings.sources, [key]: event.target.checked } })
        }
      />
      {label}
    </label>
  );
  return (
    <div className="smd-section" data-testid="settings-autocomplete">
      <div className="smd-field-inline">
        <Switch
          ref={switchRef}
          id="set-ac-enabled"
          label="Autocompletar"
          checked={settings.enabled}
          onChange={(enabled) => onChange({ enabled })}
        />
        <span>Autocompletar</span>
        <span className="smd-switch-state" aria-hidden="true">
          {settings.enabled ? 'Ligado' : 'Desligado'}
        </span>
      </div>
      <div className="smd-field">
        <label htmlFor="set-ac-mode">Quando sugerir</label>
        <select
          id="set-ac-mode"
          className="smd-input"
          value={settings.mode}
          onChange={(event) =>
            onChange({ mode: event.target.value === 'manual' ? 'manual' : 'auto' })
          }
        >
          <option value="auto">Ao digitar</option>
          <option value="manual">Só pelo atalho</option>
        </select>
      </div>
      <div className="smd-field">
        <label htmlFor="set-ac-min">Mínimo de letras</label>
        <input
          id="set-ac-min"
          type="number"
          min={2}
          max={5}
          step={1}
          className="smd-input smd-input-number"
          aria-describedby="set-ac-min-hint"
          value={minDraft ?? String(settings.minChars)}
          onChange={(event) => setMinDraft(event.target.value)}
          onBlur={commitMin}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitMin();
          }}
        />
        <span id="set-ac-min-hint" className="smd-hint">
          Entre 2 e 5.
        </span>
      </div>
      <fieldset className="smd-section smd-ac-sources">
        <legend className="smd-section-title">Fontes</legend>
        {source('words', 'Palavras do documento')}
        {source('snippets', 'Snippets')}
        {source('notes', 'Notas ([[)')}
      </fieldset>
      <div className="smd-field">
        <label htmlFor="set-ac-prefix">Prefixo dos snippets</label>
        <select
          id="set-ac-prefix"
          className="smd-input"
          value={settings.snippetPrefix}
          onChange={(event) => onChange({ snippetPrefix: event.target.value as SnippetPrefix })}
        >
          <option value="/">/</option>
          <option value=";">;</option>
          <option value="\">\</option>
        </select>
      </div>
      <p className="smd-hint">
        Para sugerir na hora: <kbd className="smd-kbd">Ctrl+Espaço</kbd> ou{' '}
        <kbd className="smd-kbd">{isMac ? '⌘⇧Espaço' : 'Ctrl+Shift+Espaço'}</kbd>.
      </p>
    </div>
  );
}
