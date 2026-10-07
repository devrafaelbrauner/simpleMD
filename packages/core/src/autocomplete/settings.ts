/**
 * Configuração do autocompletar (R-8.2; arch-frontend r2 §8.1), gravada em `config.json`
 * `autocomplete` com ler-mesclar-gravar (chaves desconhecidas ficam).
 */
export type AutocompleteMode = 'auto' | 'manual';
export type SnippetPrefix = '/' | ';' | '\\';

export interface AutocompleteSettings {
  readonly enabled: boolean;
  readonly mode: AutocompleteMode;
  /** Letras digitadas antes de sugerir palavras no modo "Ao digitar" (2–5). */
  readonly minChars: number;
  readonly sources: {
    readonly words: boolean;
    readonly snippets: boolean;
    readonly notes: boolean;
  };
  readonly snippetPrefix: SnippetPrefix;
}

export const DEFAULT_AUTOCOMPLETE: AutocompleteSettings = Object.freeze({
  enabled: true,
  mode: 'auto',
  minChars: 3,
  sources: Object.freeze({ words: true, snippets: true, notes: true }),
  snippetPrefix: '/',
});

export const SNIPPET_PREFIXES: readonly SnippetPrefix[] = ['/', ';', '\\'];
export const MIN_CHARS_MIN = 2;
export const MIN_CHARS_MAX = 5;

/** Inteiro entre 2 e 5 (1 → 2, 9 → 5; AC-8.1). */
export function clampMinChars(value: number): number {
  return Math.min(MIN_CHARS_MAX, Math.max(MIN_CHARS_MIN, Math.round(value)));
}

export interface AutocompleteField {
  readonly field: string;
  readonly reason: string;
}

/**
 * Lê um valor desconhecido (o `config.json` ou uma mudança da interface) sobre `previous`: campo
 * inválido mantém o valor anterior e gera um aviso que o nomeia; `minChars` é limitado.
 */
export function normalizeAutocomplete(
  raw: unknown,
  previous: AutocompleteSettings = DEFAULT_AUTOCOMPLETE,
): { settings: AutocompleteSettings; warnings: AutocompleteField[] } {
  const warnings: AutocompleteField[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      settings: previous,
      warnings: raw === undefined ? [] : [{ field: 'autocomplete', reason: 'deve ser um objeto' }],
    };
  }
  const data = raw as Record<string, unknown>;
  let { enabled, mode, minChars, snippetPrefix } = previous;
  const sources = { ...previous.sources };
  if ('enabled' in data) {
    if (typeof data.enabled === 'boolean') enabled = data.enabled;
    else warnings.push({ field: 'autocomplete.enabled', reason: 'deve ser true ou false' });
  }
  if ('mode' in data) {
    if (data.mode === 'auto' || data.mode === 'manual') mode = data.mode;
    else warnings.push({ field: 'autocomplete.mode', reason: 'deve ser "auto" ou "manual"' });
  }
  if ('minChars' in data) {
    if (typeof data.minChars === 'number' && Number.isFinite(data.minChars))
      minChars = clampMinChars(data.minChars);
    else warnings.push({ field: 'autocomplete.minChars', reason: 'deve ser um número' });
  }
  if ('snippetPrefix' in data) {
    if (SNIPPET_PREFIXES.includes(data.snippetPrefix as SnippetPrefix))
      snippetPrefix = data.snippetPrefix as SnippetPrefix;
    else warnings.push({ field: 'autocomplete.snippetPrefix', reason: 'deve ser /, ; ou \\' });
  }
  if ('sources' in data) {
    const raw = data.sources;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      warnings.push({ field: 'autocomplete.sources', reason: 'deve ser um objeto' });
    } else {
      for (const key of ['words', 'snippets', 'notes'] as const) {
        const value = (raw as Record<string, unknown>)[key];
        if (value === undefined) continue;
        if (typeof value === 'boolean') sources[key] = value;
        else
          warnings.push({ field: `autocomplete.sources.${key}`, reason: 'deve ser true ou false' });
      }
    }
  }
  return { settings: { enabled, mode, minChars, sources, snippetPrefix }, warnings };
}
