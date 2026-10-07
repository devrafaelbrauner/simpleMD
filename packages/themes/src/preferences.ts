import {
  isJsonObject,
  isVaultError,
  updateJsonFile,
  type JsonObject,
  type ReadLimit,
  type UpdateJsonResult,
  type VaultHandle,
  type VaultProvider,
} from '@simplemd/vault';
import { DEFAULT_THEME_ID, lightTokens } from './builtin';
import { FONT_OPTIONS, isFontFamilyName, type FontFamilyName } from './fonts';
import { isThemeId } from './schema';
import { THEME_MAX_BYTES } from './validate';

/**
 * Preferências do vault em `<vault>/.simplemd/config.json` (R-4.6; arch-backend §1.6):
 * `{ "theme": "<id>", "editor": { "fontFamily", "fontSize", "fontLigatures" } }`. Outras chaves, em
 * qualquer nível, são de etapas futuras e ficam intocadas.
 */
export const CONFIG_PATH = '.simplemd/config.json';
/** Teto de leitura do `config.json` (NFR-15). */
export const CONFIG_MAX_BYTES = 1_048_576;
export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 32;

/**
 * Limites de leitura do provider (o tamanho é checado pelo `lstat` antes de ler, então bytes
 * grandes demais nunca atravessam o IPC): `config.json` 1 MB e cada `theme.json` 256 KB.
 */
export const VAULT_READ_LIMITS: readonly ReadLimit[] = [
  { match: (path) => path === CONFIG_PATH, maxBytes: CONFIG_MAX_BYTES },
  {
    match: (path) => /^\.simplemd\/themes\/[^/]+\/theme\.json$/.test(path),
    maxBytes: THEME_MAX_BYTES,
  },
];

export interface Preferences {
  readonly theme: string;
  readonly fontFamily: FontFamilyName;
  readonly fontSize: number;
  readonly fontLigatures: boolean;
}

/**
 * Padrões = o tema claro como está em tokens.css: a família cuja pilha é igual a
 * `--fontFamily-mono` e o tamanho de `--dimension-font-size` (design-ack §5.5). Assim, aplicar as
 * preferências padrão reproduz exatamente os valores congelados.
 */
export const DEFAULT_PREFERENCES: Preferences = Object.freeze({
  theme: DEFAULT_THEME_ID,
  fontFamily:
    FONT_OPTIONS.find((font) => font.stack === lightTokens['--fontFamily-mono'])?.label ??
    'JetBrains Mono',
  fontSize: Number.parseInt(lightTokens['--dimension-font-size'] ?? '', 10),
  fontLigatures: true,
});

/** Tamanho inteiro entre 10 e 32 (UX-D17: 9 vira 10, 33 vira 32). */
export function clampFontSize(size: number): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size)));
}

export interface PreferenceWarning {
  /** `arquivo` (o arquivo inteiro), `theme`, `editor`, `editor.fontSize`… */
  readonly field: string;
  readonly reason: string;
}

export type ConfigStatus =
  /** Não existe: padrões; a primeira mudança cria o arquivo. */
  | 'missing'
  | 'ok'
  /** Ilegível ou JSON malformado: padrões e o arquivo NUNCA é regravado nesta sessão (F-9). */
  | 'malformed'
  /** Erro de E/S ou permissão ao ler: padrões; só uma nova leitura bem-sucedida libera a gravação. */
  | 'unreadable';

export interface LoadedPreferences {
  readonly status: ConfigStatus;
  readonly prefs: Preferences;
  readonly warnings: readonly PreferenceWarning[];
}

/**
 * Lê as preferências do vault. Nunca lança e nunca grava (AC-4.11: o sha256 do arquivo não muda).
 * Problemas de campo usam o padrão daquele campo e geram um aviso que o nomeia; `fontSize` fora de
 * 10–32 é limitado. Um `theme` bem formado que não existe (`isKnownTheme`) volta ao tema padrão.
 */
export async function loadPreferences(
  provider: VaultProvider,
  handle: VaultHandle,
  isKnownTheme: (id: string) => boolean,
): Promise<LoadedPreferences> {
  let data: unknown;
  try {
    // Um BOM inicial (Bloco de Notas do Windows e outros editores) não torna o JSON inválido (API-02).
    data = JSON.parse((await provider.read(handle, CONFIG_PATH)).text.replace(/^\uFEFF/, ''));
  } catch (error) {
    if (isVaultError(error, 'NOT_FOUND'))
      return { status: 'missing', prefs: DEFAULT_PREFERENCES, warnings: [] };
    const reason = isVaultError(error, 'TOO_LARGE')
      ? 'maior que 1 MB'
      : isVaultError(error, 'NOT_UTF8') || error instanceof SyntaxError
        ? 'JSON malformado'
        : null;
    if (reason === null)
      return {
        status: 'unreadable',
        prefs: DEFAULT_PREFERENCES,
        warnings: [{ field: 'arquivo', reason: 'não foi possível ler' }],
      };
    return {
      status: 'malformed',
      prefs: DEFAULT_PREFERENCES,
      warnings: [{ field: 'arquivo', reason }],
    };
  }
  if (!isJsonObject(data)) {
    return {
      status: 'malformed',
      prefs: DEFAULT_PREFERENCES,
      warnings: [{ field: 'arquivo', reason: 'o conteúdo não é um objeto JSON' }],
    };
  }

  const warnings: PreferenceWarning[] = [];
  let { theme, fontFamily, fontSize, fontLigatures } = DEFAULT_PREFERENCES;
  if ('theme' in data) {
    if (!isThemeId(data.theme)) warnings.push({ field: 'theme', reason: 'id de tema inválido' });
    else if (!isKnownTheme(data.theme))
      warnings.push({ field: 'theme', reason: 'tema não encontrado' });
    else theme = data.theme;
  }
  if ('editor' in data) {
    const editor = data.editor;
    if (!isJsonObject(editor)) {
      warnings.push({ field: 'editor', reason: 'deve ser um objeto' });
    } else {
      if ('fontFamily' in editor) {
        if (isFontFamilyName(editor.fontFamily)) fontFamily = editor.fontFamily;
        else warnings.push({ field: 'editor.fontFamily', reason: 'família desconhecida' });
      }
      if ('fontSize' in editor) {
        const size = editor.fontSize;
        if (typeof size !== 'number' || !Number.isFinite(size)) {
          warnings.push({ field: 'editor.fontSize', reason: 'deve ser um número' });
        } else {
          fontSize = clampFontSize(size);
          if (fontSize !== size)
            warnings.push({ field: 'editor.fontSize', reason: 'fora de 10–32; ajustado' });
        }
      }
      if ('fontLigatures' in editor) {
        if (typeof editor.fontLigatures === 'boolean') fontLigatures = editor.fontLigatures;
        else warnings.push({ field: 'editor.fontLigatures', reason: 'deve ser true ou false' });
      }
    }
  }
  return { status: 'ok', prefs: { theme, fontFamily, fontSize, fontLigatures }, warnings };
}

/**
 * Grava as preferências com ler-mesclar-gravar (`updateJsonFile`): só `theme` e
 * `editor.{fontFamily,fontSize,fontLigatures}` mudam; chaves desconhecidas ficam (AC-4.9). Um
 * arquivo que ficou malformado devolve `malformed` sem gravar.
 */
export function savePreferences(
  provider: VaultProvider,
  handle: VaultHandle,
  prefs: Preferences,
): Promise<UpdateJsonResult> {
  return updateJsonFile(provider, handle, CONFIG_PATH, (obj: JsonObject) => {
    obj.theme = prefs.theme;
    const editor = isJsonObject(obj.editor) ? obj.editor : {};
    editor.fontFamily = prefs.fontFamily;
    editor.fontSize = prefs.fontSize;
    editor.fontLigatures = prefs.fontLigatures;
    obj.editor = editor;
  });
}
