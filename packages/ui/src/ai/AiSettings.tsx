import { AI_LANGUAGES, type AiLanguage, type ProviderId } from '@simplemd/ai';
import { useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { Button } from '../components/ui/button';
import { Icon } from '../lib/icons';

export type AiKeyedProvider = 'openai' | 'anthropic';
export type AiKeyStatus = 'unknown' | 'saved' | 'none';

export interface AiModelsView {
  readonly state: 'idle' | 'loading' | 'ok' | 'empty' | 'fail' | 'offline';
  readonly list: readonly string[];
  readonly message: string;
}

export interface AiSettingsProps {
  provider: ProviderId | null;
  /** Modelo salvo para o provedor ('' = nenhum). */
  model: string;
  models: AiModelsView;
  keys: Readonly<Record<AiKeyedProvider, AiKeyStatus>>;
  keyErrors: Readonly<Partial<Record<AiKeyedProvider, string>>>;
  ollamaUrl: string;
  language: AiLanguage;
  /** Foco inicial do L2 nesta seção ("Provedor", AIS-NOPROVIDER). */
  providerRef?: Ref<HTMLSelectElement>;
  onProviderChange(provider: ProviderId | null): void;
  onModelChange(model: string): void;
  onRefreshModels(): void;
  /**
   * "Salvar no keychain": recebe o valor lido UMA vez do campo, que já foi esvaziado (R-11.4). Quem
   * chama não guarda o valor.
   */
  onSaveKey(provider: AiKeyedProvider, value: string): void;
  onRemoveKey(provider: AiKeyedProvider): void;
  /** Endereço confirmado; `false` = fora do loopback (STR-127), nada é gravado. */
  onOllamaUrlChange(url: string): boolean;
  onLanguageChange(language: AiLanguage): void;
}

const OTHER = '__other';
const KEY_GROUPS: ReadonlyArray<{ provider: AiKeyedProvider; label: string }> = [
  { provider: 'openai', label: 'Chave da OpenAI' },
  { provider: 'anthropic', label: 'Chave da Anthropic' },
];

/**
 * Um grupo de chave (DESIGN §8.13 IA, item 3): campo `password` NÃO controlado (sem `value`, sem
 * `onChange` guardando nada). Ao salvar, o valor é lido uma vez e o campo é esvaziado na hora —
 * no sucesso e na falha — antes de o valor seguir para o keychain. O status nunca mostra
 * caractere algum da chave.
 */
function KeyGroup({
  provider,
  label,
  status,
  error,
  onSave,
  onRemove,
}: {
  provider: AiKeyedProvider;
  label: string;
  status: AiKeyStatus;
  error: string | undefined;
  onSave(provider: AiKeyedProvider, value: string): void;
  onRemove(provider: AiKeyedProvider): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const id = `set-ai-key-${provider}`;
  const save = () => {
    const field = input.current;
    if (!field) return;
    const value = field.value;
    field.value = '';
    if (value.trim() === '') return;
    onSave(provider, value);
  };
  const saved = status === 'saved';
  return (
    <div className="smd-ai-key" data-provider={provider}>
      <div className="smd-field">
        <label htmlFor={id}>{label}</label>
        <input
          ref={input}
          id={id}
          className="smd-input smd-ai-wide"
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${id}-status ${id}-help`}
          data-testid="set-ai-key-input"
          data-provider={provider}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === 'Enter') save();
          }}
        />
      </div>
      <div className="smd-actions">
        <Button data-testid="set-ai-key-save" data-provider={provider} onClick={save}>
          Salvar no keychain
        </Button>
        <Button
          data-testid="set-ai-key-remove"
          data-provider={provider}
          aria-disabled={!saved || undefined}
          onClick={() => onRemove(provider)}
        >
          Remover chave
        </Button>
      </div>
      <p
        id={`${id}-status`}
        className="smd-ai-status"
        data-state={saved ? 'saved' : 'none'}
        data-testid="set-ai-key-status"
        data-provider={provider}
      >
        {saved && <Icon name="check" />}
        {saved ? 'Chave salva' : 'Sem chave'}
      </p>
      {error && (
        <div className="smd-ialert" role="alert" data-testid="set-ai-key-error">
          <Icon name="warn" />
          <p>{error}</p>
        </div>
      )}
      <p id={`${id}-help`} className="smd-hint">
        A chave fica só no keychain do sistema; o simpleMD não a mostra de novo.
      </p>
    </div>
  );
}

/**
 * L2 "IA" (R-11.6; DESIGN §8.13 IA; arch-frontend r2 §11.5; STR-123…128). Grupos sempre
 * visíveis (ordem de Tab estável): Provedor · Modelo (+ "Atualizar lista", a ÚNICA origem de
 * `listModels`) · chaves da OpenAI e da Anthropic · endereço do Ollama + idioma de "Traduzir" +
 * nota de privacidade.
 */
export function AiSettings(props: AiSettingsProps) {
  const { provider, model, models, keys, keyErrors, ollamaUrl, language, providerRef } = props;
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherDraft, setOtherDraft] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [urlInvalid, setUrlInvalid] = useState(false);
  const cloudWithoutKey = provider !== null && provider !== 'ollama' && keys[provider] === 'none';
  const refreshReason =
    provider === null
      ? 'Escolha um provedor primeiro.'
      : cloudWithoutKey
        ? 'Salve uma chave primeiro.'
        : null;
  const options = [...models.list];
  if (model !== '' && !options.includes(model)) options.unshift(model);
  const showOther = otherOpen || options.length === 0;
  const commitOther = () => {
    if (otherDraft === null) return;
    const value = otherDraft.trim();
    setOtherDraft(null);
    if (value !== '' && value !== model) props.onModelChange(value);
  };
  const commitUrl = () => {
    if (urlDraft === null) return;
    const ok = props.onOllamaUrlChange(urlDraft);
    setUrlInvalid(!ok);
    if (ok) setUrlDraft(null);
  };
  const status =
    models.state === 'loading'
      ? 'Buscando modelos…'
      : models.state === 'empty'
        ? 'Nenhum modelo encontrado.'
        : models.state === 'idle' && provider !== null
          ? cloudWithoutKey
            ? 'Salve uma chave primeiro.'
            : 'Clique em “Atualizar lista” para buscar os modelos.'
          : '';
  return (
    <div className="smd-ai-settings" data-testid="settings-ai">
      <section className="smd-ai-group">
        <div className="smd-field">
          <label htmlFor="set-ai-provider">Provedor</label>
          <select
            ref={providerRef}
            id="set-ai-provider"
            className="smd-input"
            data-testid="set-ai-provider"
            value={provider ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              setOtherOpen(false);
              props.onProviderChange(
                value === 'openai' || value === 'anthropic' || value === 'ollama' ? value : null,
              );
            }}
          >
            <option value="">Escolha um provedor</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="ollama">Ollama (local)</option>
          </select>
        </div>
      </section>

      <section className="smd-ai-group" aria-labelledby="set-ai-model-heading">
        <h3 id="set-ai-model-heading" className="smd-section-title">
          Modelo
        </h3>
        <div className="smd-ai-row">
          <label htmlFor="set-ai-model" className="sr-only">
            Modelo
          </label>
          <select
            id="set-ai-model"
            className="smd-input"
            data-testid="set-ai-model"
            value={showOther ? OTHER : model}
            onChange={(event) => {
              if (event.target.value === OTHER) setOtherOpen(true);
              else {
                setOtherOpen(false);
                props.onModelChange(event.target.value);
              }
            }}
          >
            {options.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
            <option value={OTHER}>Outro modelo…</option>
          </select>
          <Button
            data-testid="set-ai-refresh"
            aria-disabled={refreshReason !== null || models.state === 'loading' || undefined}
            aria-describedby={refreshReason !== null ? 'set-ai-refresh-why' : undefined}
            onClick={props.onRefreshModels}
          >
            <Icon name="refresh" />
            Atualizar lista
          </Button>
        </div>
        {refreshReason !== null && (
          <p id="set-ai-refresh-why" className="smd-hint">
            {refreshReason}
          </p>
        )}
        {showOther && (
          <div className="smd-field">
            <label htmlFor="set-ai-model-other">Nome do modelo</label>
            <input
              id="set-ai-model-other"
              className="smd-input smd-ai-wide smd-mono"
              type="text"
              autoComplete="off"
              spellCheck={false}
              data-testid="set-ai-model-other"
              value={otherDraft ?? model}
              onChange={(event) => setOtherDraft(event.target.value)}
              onBlur={commitOther}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitOther();
              }}
            />
          </div>
        )}
        {models.state === 'fail' || models.state === 'offline' ? (
          <div className="smd-ialert" role="alert" data-testid="set-ai-models-error">
            <Icon name="warn" />
            <p>{models.message}</p>
          </div>
        ) : (
          <p className="smd-ai-status" role="status" data-testid="set-ai-models-status">
            {status}
          </p>
        )}
      </section>

      <section className="smd-ai-group">
        {KEY_GROUPS.map((group) => (
          <KeyGroup
            key={group.provider}
            provider={group.provider}
            label={group.label}
            status={keys[group.provider]}
            error={keyErrors[group.provider]}
            onSave={props.onSaveKey}
            onRemove={props.onRemoveKey}
          />
        ))}
      </section>

      <section className="smd-ai-group">
        <div className="smd-field">
          <label htmlFor="set-ai-ollama-url">Endereço do Ollama</label>
          <input
            id="set-ai-ollama-url"
            className="smd-input smd-ai-wide smd-mono"
            type="text"
            spellCheck={false}
            autoComplete="off"
            data-testid="set-ai-ollama-url"
            aria-invalid={urlInvalid || undefined}
            aria-describedby="set-ai-ollama-hint set-ai-ollama-error"
            value={urlDraft ?? ollamaUrl}
            onChange={(event) => setUrlDraft(event.target.value)}
            onBlur={commitUrl}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitUrl();
            }}
          />
          <span id="set-ai-ollama-hint" className="smd-hint">
            Só endereços locais: 127.0.0.1, localhost ou [::1].
          </span>
          <p id="set-ai-ollama-error" className="smd-field-error">
            {urlInvalid && (
              <>
                <Icon name="warn" />
                Use um endereço local com http: 127.0.0.1, localhost ou [::1], com porta.
              </>
            )}
          </p>
        </div>
        <div className="smd-field">
          <label htmlFor="set-ai-language">Idioma de “Traduzir”</label>
          <select
            id="set-ai-language"
            className="smd-input"
            data-testid="set-ai-language"
            value={language}
            onChange={(event) => {
              const next = AI_LANGUAGES.find((l) => l.id === event.target.value);
              if (next) props.onLanguageChange(next.id);
            }}
          >
            {AI_LANGUAGES.map((language) => (
              <option key={language.id} value={language.id} lang={language.id}>
                {language.label}
              </option>
            ))}
          </select>
        </div>
        <p className="smd-hint smd-ai-privacy">
          <Icon name="info" />
          <span>O chat e os comandos enviam ao provedor só o que você digita ou seleciona.</span>
        </p>
      </section>
    </div>
  );
}
