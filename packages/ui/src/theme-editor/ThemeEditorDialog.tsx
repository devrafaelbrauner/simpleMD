import {
  FONT_OPTIONS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  lightTokens,
  resolveTokens,
  type RequiredToken,
  type Theme,
  type ThemeDraft,
} from '@simplemd/themes';
import { useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Icon } from '../lib/icons';
import {
  COLOR_TOKENS,
  SIZE_TOKEN,
  SUMMARY_ERROR,
  draftReducer,
  firstInvalid,
  pickerValue,
  startDraft,
  type DraftField,
} from './draft';
import { ThemePreview } from './ThemePreview';
import { TOKEN_LABELS } from './token-labels';

export interface ThemeEditorDialogProps {
  open: boolean;
  onClose(): void;
  /** Todos os temas ("Começar de"): embutidos primeiro, depois os do vault. */
  themes: readonly Theme[];
  /** Tema de partida inicial: o ativo. */
  initialThemeId: string;
  /** Documento da prévia (`@simplemd/core/samples/theme-preview.md`). */
  previewDoc: string;
  /** Há uma pasta aberta: sem ela, salvar fica indisponível (STR-39). */
  canSave: boolean;
  /** Grava como tema novo e o ativa; `false` = falhou (STR-38), o diálogo continua aberto. */
  onSave(draft: ThemeDraft): Promise<boolean>;
}

interface FontChoice {
  readonly label: string;
  readonly value: string;
}

/** "Fonte da interface": a pilha do sistema (CF-3) e as famílias de R-4.4. */
const UI_FONTS: readonly FontChoice[] = [
  { label: 'Interface do sistema', value: lightTokens['--fontFamily-ui'] ?? '' },
  ...FONT_OPTIONS.map((f) => ({ label: f.label, value: f.stack })),
];
const MONO_FONTS: readonly FontChoice[] = FONT_OPTIONS.map((f) => ({
  label: f.label,
  value: f.stack,
}));

/** Um tema importado pode trazer uma pilha fora da lista: ela vira uma opção a mais. */
function withCurrent(choices: readonly FontChoice[], value: string): readonly FontChoice[] {
  if (choices.some((c) => c.value === value)) return choices;
  const first =
    value
      .split(',')[0]
      ?.trim()
      .replace(/^["']|["']$/g, '') ?? value;
  return [...choices, { label: `Do tema: ${first}`, value }];
}

/** `--fontFamily-ui` → `font-family-ui` (ids de elementos). */
const tokenSlug = (token: RequiredToken) =>
  token.slice(2).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const fieldId = (field: DraftField) =>
  field === 'name' ? 'te-name' : `te-hex-${tokenSlug(field)}`;

/**
 * L3 EDITOR DE TEMAS (arch-ux §2.4, arch-frontend §10, DESIGN §8.2/§8.7): formulário com os 11
 * tokens obrigatórios, nome e base, prévia ao vivo restrita ao próprio contêiner e "Salvar como
 * novo tema". Embutidos nunca são alterados: salvar sempre cria um tema novo (R-5.1, R-5.4).
 */
export function ThemeEditorDialog(props: ThemeEditorDialogProps) {
  const { open, onClose, themes, previewDoc, canSave } = props;
  const findTheme = (id: string) => themes.find((t) => t.id === id) ?? themes[0];
  const toStart = (theme: Theme | undefined) => ({
    id: theme?.id ?? '',
    name: theme?.name ?? '',
    base: theme?.base ?? 'light',
    tokens: theme ? resolveTokens(theme) : lightTokens,
  });
  const [draft, dispatch] = useReducer(draftReducer, undefined, () =>
    startDraft(toStart(findTheme(props.initialThemeId))),
  );
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const startSelect = useRef<HTMLSelectElement>(null);
  const saveError = useRef<HTMLDivElement>(null);

  // A falha ao salvar recebe o foco, como o alerta de importação do L2: quem usa teclado ou leitor
  // de tela fica sabendo na hora (UIF F-01). Sem `role=alert` aqui (QR-05): o VoiceOver lia a
  // mensagem duas vezes, pelo foco e pela região viva; o foco sozinho a lê uma vez.
  useEffect(() => {
    if (saveFailed) saveError.current?.focus();
  }, [saveFailed]);

  const previewTokens = useMemo(
    () => resolveTokens({ base: draft.base, tokens: draft.tokens }),
    [draft.base, draft.tokens],
  );

  const save = async () => {
    if (!canSave || saving) return;
    const checked = draftReducer(draft, { type: 'validate-all' });
    dispatch({ type: 'validate-all' });
    const invalid = firstInvalid(checked);
    if (invalid) {
      setShowSummary(true);
      document.getElementById(fieldId(invalid))?.focus();
      return;
    }
    setShowSummary(false);
    setSaveFailed(false);
    setSaving(true);
    const ok = await props.onSave({
      name: draft.name.trim(),
      base: draft.base,
      tokens: { ...draft.tokens },
    });
    setSaving(false);
    if (!ok) setSaveFailed(true);
  };

  const errorIds = (field: DraftField) => (draft.errors[field] ? `${fieldId(field)}-error` : '');
  const commitOnEnter = (field: DraftField) => (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter não envia o formulário (AC-5.12): só confirma o campo.
    if (event.key === 'Enter') {
      event.preventDefault();
      dispatch({ type: 'commit', field });
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      nested
      keepOnOutsideClick
      title="Editor de temas"
      data-testid="theme-editor"
      className="smd-te"
      initialFocus={startSelect}
      status={
        <>
          <div className="smd-ialert" role="alert" data-testid="te-error-summary">
            {showSummary && firstInvalid(draft) && (
              <>
                <Icon name="warn" />
                <p>{SUMMARY_ERROR}</p>
              </>
            )}
          </div>
          <div ref={saveError} className="smd-ialert" tabIndex={-1} data-testid="te-save-error">
            {saveFailed && (
              <>
                <Icon name="warn" />
                <p>Não foi possível salvar o tema. Nenhum tema foi ativado.</p>
              </>
            )}
          </div>
          {!canSave && (
            <p id="te-novault" className="smd-hint">
              Abra uma pasta para salvar ou importar temas.
            </p>
          )}
        </>
      }
      footer={
        <>
          <span className="smd-hint smd-te-helper" id="te-save-helper">
            Salvar sempre cria um novo tema; nenhum arquivo existente é substituído.
          </span>
          <Button variant="secondary" data-testid="te-close" onClick={onClose}>
            Fechar
          </Button>
          <Button
            variant="primary"
            data-testid="te-save"
            aria-disabled={!canSave || saving || undefined}
            aria-describedby={canSave ? 'te-save-helper' : 'te-save-helper te-novault'}
            onClick={() => void save()}
          >
            {saving ? 'Salvando…' : 'Salvar como novo tema'}
          </Button>
        </>
      }
    >
      <div className="smd-te-grid">
        <fieldset className="smd-te-form" disabled={saving}>
          <div className="smd-field">
            <label htmlFor="te-start">Começar de</label>
            <select
              id="te-start"
              ref={startSelect}
              className="smd-input"
              value={draft.startId}
              onChange={(event) =>
                dispatch({ type: 'start', theme: toStart(findTheme(event.target.value)) })
              }
            >
              {themes.map((theme) => (
                <option key={theme.id} value={theme.id}>
                  {theme.name}
                </option>
              ))}
            </select>
          </div>

          <div className="smd-field">
            <label htmlFor="te-name">Nome</label>
            <input
              id="te-name"
              className="smd-input smd-te-name"
              value={draft.name}
              aria-invalid={draft.errors.name ? true : undefined}
              aria-describedby={errorIds('name') || undefined}
              onChange={(event) => dispatch({ type: 'name', value: event.target.value })}
              onBlur={() => dispatch({ type: 'commit', field: 'name' })}
              onKeyDown={commitOnEnter('name')}
            />
            <FieldError id={errorIds('name')} text={draft.errors.name} />
          </div>

          <fieldset className="smd-te-group" aria-describedby="te-base-help">
            <legend>Base</legend>
            <div className="smd-field-inline">
              {(['light', 'dark'] as const).map((base) => (
                <label key={base} className="smd-radio">
                  <input
                    id={`te-base-${base}`}
                    type="radio"
                    name="te-base"
                    value={base}
                    checked={draft.base === base}
                    onChange={() => dispatch({ type: 'base', base })}
                  />
                  {base === 'light' ? 'Claro' : 'Escuro'}
                </label>
              ))}
            </div>
            <span id="te-base-help" className="smd-hint">
              Tokens não definidos aqui são herdados do tema base.
            </span>
          </fieldset>

          <fieldset className="smd-te-group">
            <legend>Cores</legend>
            {COLOR_TOKENS.map((token) => {
              const label = TOKEN_LABELS[token];
              const hexId = fieldId(token);
              const chipId = `te-chip-${tokenSlug(token)}`;
              return (
                <div key={token} className="smd-te-row" data-testid="token-row" data-token={token}>
                  <label htmlFor={hexId} className="smd-te-row-label">
                    {label}
                    <span className="sr-only"> (hex)</span>
                  </label>
                  <code id={chipId} className="smd-te-chip">
                    {token}
                  </code>
                  <input
                    id={hexId}
                    className="smd-input smd-te-hex"
                    value={draft.inputs[token]}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={draft.errors[token] ? true : undefined}
                    aria-describedby={`${chipId} ${errorIds(token)}`.trim()}
                    onChange={(event) =>
                      dispatch({ type: 'input', token, value: event.target.value })
                    }
                    onBlur={() => dispatch({ type: 'commit', field: token })}
                    onKeyDown={commitOnEnter(token)}
                  />
                  <input
                    type="color"
                    className="smd-te-picker"
                    aria-label={`${label} (seletor)`}
                    value={pickerValue(draft.tokens[token])}
                    onChange={(event) =>
                      dispatch({ type: 'picker', token, value: event.target.value })
                    }
                  />
                  <FieldError id={errorIds(token)} text={draft.errors[token]} />
                </div>
              );
            })}
          </fieldset>

          <fieldset className="smd-te-group">
            <legend>Fontes</legend>
            <FontSelect
              token="--fontFamily-ui"
              choices={withCurrent(UI_FONTS, draft.tokens['--fontFamily-ui'])}
              value={draft.tokens['--fontFamily-ui']}
              onChange={(value) => dispatch({ type: 'input', token: '--fontFamily-ui', value })}
            />
            <FontSelect
              token="--fontFamily-mono"
              choices={withCurrent(MONO_FONTS, draft.tokens['--fontFamily-mono'])}
              value={draft.tokens['--fontFamily-mono']}
              onChange={(value) => dispatch({ type: 'input', token: '--fontFamily-mono', value })}
            />
            <div className="smd-field" data-testid="token-row" data-token={SIZE_TOKEN}>
              <label htmlFor="te-size">{TOKEN_LABELS[SIZE_TOKEN]}</label>
              <input
                id="te-size"
                className="smd-input smd-input-number"
                type="number"
                inputMode="numeric"
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                step={1}
                aria-describedby="te-size-hint"
                value={draft.inputs[SIZE_TOKEN]}
                onChange={(event) =>
                  dispatch({ type: 'input', token: SIZE_TOKEN, value: event.target.value })
                }
                onBlur={() => dispatch({ type: 'commit', field: SIZE_TOKEN })}
                onKeyDown={commitOnEnter(SIZE_TOKEN)}
              />
              <span id="te-size-hint" className="smd-hint">
                Entre 10 e 32.
              </span>
            </div>
          </fieldset>
        </fieldset>

        <ThemePreview tokens={previewTokens} base={draft.base} doc={previewDoc} />
      </div>
    </Dialog>
  );
}

function FieldError({ id, text }: { id: string; text: string | undefined }) {
  if (!text) return null;
  return (
    <p id={id} className="smd-field-error">
      <Icon name="warn" />
      {text}
    </p>
  );
}

function FontSelect({
  token,
  choices,
  value,
  onChange,
}: {
  token: '--fontFamily-ui' | '--fontFamily-mono';
  choices: readonly FontChoice[];
  value: string;
  onChange(value: string): void;
}) {
  const id = `te-${tokenSlug(token)}`;
  return (
    <div className="smd-field" data-testid="token-row" data-token={token}>
      <label htmlFor={id}>{TOKEN_LABELS[token]}</label>
      <select
        id={id}
        className="smd-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    </div>
  );
}
