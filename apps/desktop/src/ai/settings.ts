import {
  DEFAULT_AI_LANGUAGE,
  DEFAULT_OLLAMA_URL,
  PROVIDER_IDS,
  isAiLanguage,
  isProviderId,
  normalizeOllamaUrl,
  type AiLanguage,
  type ProviderId,
} from '@simplemd/ai';
import { isJsonObject } from '@simplemd/vault';

/**
 * Configurações de IA (R-11.6; arch-frontend r2 §11.5): `config.json` `ai` =
 * `{ provider, models, ollamaUrl, language }`. **Nunca** um campo de chave (AC-11.10): as chaves só
 * existem no keychain do sistema.
 */
export interface AiSettings {
  /** `null` até o usuário escolher (UX-R2-D19). */
  readonly provider: ProviderId | null;
  /** Modelo escolhido por provedor. */
  readonly models: Readonly<Partial<Record<ProviderId, string>>>;
  readonly ollamaUrl: string;
  /** Idioma de "Traduzir" (Q-13: English). */
  readonly language: AiLanguage;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: null,
  models: {},
  ollamaUrl: DEFAULT_OLLAMA_URL,
  language: DEFAULT_AI_LANGUAGE,
};

/** Nome de modelo aceito: 1–200 caracteres, sem controle. */
export const isValidModelName = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim() !== '' &&
  value.length <= 200 &&
  ![...value].some((c) => c < ' ');

/**
 * Lê a seção `ai` do `config.json`: campo inválido mantém o valor anterior e gera um aviso que o
 * nomeia (padrão de `normalizeAutocomplete`, AC-8.1).
 */
export function normalizeAiSettings(
  raw: unknown,
  previous: AiSettings,
): { settings: AiSettings; warnings: Array<{ field: string; reason: string }> } {
  if (raw === undefined) return { settings: previous, warnings: [] };
  if (!isJsonObject(raw))
    return { settings: previous, warnings: [{ field: 'ai', reason: 'deve ser um objeto' }] };
  const warnings: Array<{ field: string; reason: string }> = [];
  let { provider, models, ollamaUrl, language } = previous;
  if ('provider' in raw) {
    if (raw.provider === null || isProviderId(raw.provider)) provider = raw.provider;
    else warnings.push({ field: 'ai.provider', reason: 'provedor desconhecido' });
  }
  if ('models' in raw) {
    if (isJsonObject(raw.models)) {
      const next: Partial<Record<ProviderId, string>> = {};
      for (const id of PROVIDER_IDS) {
        const value = raw.models[id];
        if (value === undefined) continue;
        if (isValidModelName(value)) next[id] = value;
        else warnings.push({ field: `ai.models.${id}`, reason: 'nome de modelo inválido' });
      }
      models = next;
    } else warnings.push({ field: 'ai.models', reason: 'deve ser um objeto' });
  }
  if ('ollamaUrl' in raw) {
    const url = typeof raw.ollamaUrl === 'string' ? normalizeOllamaUrl(raw.ollamaUrl) : null;
    if (url) ollamaUrl = url;
    else warnings.push({ field: 'ai.ollamaUrl', reason: 'só endereços locais com porta' });
  }
  if ('language' in raw) {
    if (isAiLanguage(raw.language)) language = raw.language;
    else warnings.push({ field: 'ai.language', reason: 'idioma desconhecido' });
  }
  return { settings: { provider, models, ollamaUrl, language }, warnings };
}
