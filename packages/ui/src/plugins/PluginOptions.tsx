import { useEffect, useId, useState, type ReactNode } from 'react';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';

/** Uma opção de plugin interno (dados simples; o `packages/ui` não conhece o runtime). */
export interface PluginOptionField {
  readonly key: string;
  readonly kind: 'boolean' | 'select' | 'number' | 'info' | 'list';
  readonly label: string;
  readonly help?: string;
  readonly choices?: readonly {
    readonly value: string;
    readonly label: string;
    readonly lang?: string;
  }[];
  readonly min?: number;
  readonly max?: number;
  /** `list`: nome do botão de cada item (ex.: "Reativar <ID>") e o texto da lista vazia. */
  removeLabel?(item: string): string;
  readonly emptyText?: string;
}

/** Resultado de uma mudança: aplicada, ou a mensagem do campo (`aria-invalid`). */
export type PluginOptionResult =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

export interface PluginOptionsData {
  readonly fields: readonly PluginOptionField[];
  readonly values: Readonly<Record<string, unknown>>;
  /** Texto de uma opção `info` (calculado pelo app; pode ler um arquivo do vault). */
  info(key: string): Promise<string>;
}

export interface PluginOptionsProps {
  /** Id DOM do grupo (alvo do `aria-controls` do botão "Opções"). */
  id: string;
  pluginId: string;
  pluginName: string;
  data: PluginOptionsData;
  onChange(key: string, value: unknown): Promise<PluginOptionResult>;
}

/**
 * Grupo "Opções de “<nome>”" de um plugin interno (r7 R-X7.4; DA-R7-12; DESIGN §R7.6.8): um
 * controle por opção, renderizado pelo tipo — `boolean` interruptor, `select` lista (idiomas com
 * `lang`, A-46), `number` com faixa e `aria-invalid`, `info` texto, `list` itens com botão. Editável
 * com o plugin desligado; cada mudança é anunciada pelo diálogo (STR-180).
 */
export function PluginOptions({ id, pluginId, pluginName, data, onChange }: PluginOptionsProps) {
  const title = `Opções de “${pluginName}”`;
  return (
    <div
      id={id}
      role="group"
      aria-labelledby={`${id}-title`}
      className="smd-plugin-options"
      data-testid="plugin-options"
      data-plugin-id={pluginId}
    >
      <p id={`${id}-title`} className="sr-only">
        {title}
      </p>
      {data.fields.map((field) => (
        <OptionRow
          key={field.key}
          field={field}
          value={data.values[field.key]}
          info={data.info}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

function OptionRow({
  field,
  value,
  info,
  onChange,
}: {
  field: PluginOptionField;
  value: unknown;
  info: PluginOptionsData['info'];
  onChange: PluginOptionsProps['onChange'];
}) {
  const base = useId();
  const controlId = `${base}-control`;
  const helpId = `${base}-help`;
  const errorId = `${base}-error`;
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [infoText, setInfoText] = useState('');
  useEffect(() => {
    if (field.kind !== 'info') return;
    let alive = true;
    void info(field.key).then((text) => {
      if (alive) setInfoText(text);
    });
    return () => {
      alive = false;
    };
  }, [field.kind, field.key, info]);
  const change = async (next: unknown) => {
    const result = await onChange(field.key, next);
    setError(result.ok ? null : result.message);
  };
  const describedBy = [field.help ? helpId : '', error ? errorId : ''].filter(Boolean).join(' ');
  const label = (
    <label htmlFor={controlId} className="smd-plugin-option-label">
      {field.label}
    </label>
  );
  let control: ReactNode;
  switch (field.kind) {
    case 'boolean':
      control = (
        <span className="smd-plugin-option-switch">
          <Switch
            id={controlId}
            label={field.label}
            checked={value === true}
            {...(describedBy ? { describedBy } : {})}
            onChange={(next) => void change(next)}
          />
          <span className="smd-switch-state" aria-hidden="true">
            {value === true ? 'Ligado' : 'Desligado'}
          </span>
        </span>
      );
      break;
    case 'select':
      control = (
        <select
          id={controlId}
          className="smd-input"
          value={typeof value === 'string' ? value : ''}
          aria-describedby={describedBy || undefined}
          onChange={(event) => void change(event.target.value)}
        >
          {(field.choices ?? []).map((choice) => (
            <option key={choice.value} value={choice.value} lang={choice.lang}>
              {choice.label}
            </option>
          ))}
        </select>
      );
      break;
    case 'number':
      control = (
        <input
          id={controlId}
          type="number"
          className="smd-input smd-input-number"
          min={field.min}
          max={field.max}
          step={1}
          aria-invalid={error !== null || undefined}
          aria-describedby={describedBy || undefined}
          value={draft ?? (typeof value === 'number' ? String(value) : '')}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft === null) return;
            const typed = draft;
            setDraft(null);
            void change(typed);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      );
      break;
    case 'info':
      control = (
        <span id={controlId} className="smd-plugin-option-info">
          {infoText}
        </span>
      );
      break;
    case 'list': {
      const items = Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
      control =
        items.length === 0 ? (
          <span id={controlId} className="smd-muted">
            {field.emptyText ?? ''}
          </span>
        ) : (
          <ul id={controlId} className="smd-plugin-option-list">
            {items.map((item) => (
              <li key={item}>
                <span className="smd-mono">{item}</span>
                <Button
                  className="smd-btn-compact"
                  onClick={() => void change(items.filter((other) => other !== item))}
                >
                  {field.removeLabel?.(item) ?? item}
                </Button>
              </li>
            ))}
          </ul>
        );
      break;
    }
  }
  return (
    <div className="smd-plugin-option" data-testid="plugin-option" data-key={field.key}>
      <div className="smd-plugin-option-text">
        {field.kind === 'info' || field.kind === 'list' ? (
          <span className="smd-plugin-option-label">{field.label}</span>
        ) : (
          label
        )}
        {field.help && (
          <p id={helpId} className="smd-hint">
            {field.help}
          </p>
        )}
        {error && (
          <p id={errorId} className="smd-plugin-option-error">
            {error}
          </p>
        )}
      </div>
      {control}
    </div>
  );
}
