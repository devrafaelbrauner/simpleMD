import {
  createWithFreeName,
  isVaultError,
  type VaultHandle,
  type VaultProvider,
} from '@simplemd/vault';
import { BUILTIN_THEMES } from './builtin';
import { isThemeId, type Theme, type ThemeBase, type ThemeFile, type Tokens } from './schema';
import { serializeTheme } from './serialize';
import { validateTheme, type ThemeValidationError } from './validate';

/**
 * Temas do vault em `<vault>/.simplemd/themes/<id>/theme.json` (arch-backend §1.7.4). Toda E/S passa
 * pelo `VaultProvider`; nada aqui sobrescreve um arquivo (gravação só-criação).
 */
export const THEMES_DIR = '.simplemd/themes';
/** Espaço para o sufixo `-NNN` dentro do limite de 64 caracteres de um id. */
const SLUG_BASE_MAX = 60;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

export const themeFilePath = (id: string): string => `${THEMES_DIR}/${id}/theme.json`;

/**
 * Nome → slug ASCII em kebab-case (R-5.4): decomposição NFKD sem acentos, minúsculas, qualquer
 * sequência fora de `[a-z0-9]` vira `-`. Vazio vira `tema`. Ex.: "Meu Tema" → `meu-tema`.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, SLUG_BASE_MAX)
    .replace(/^-+|-+$/g, '');
  if (slug === '') return 'tema';
  // Nomes reservados do Windows ("con", "nul", "com1"…) são recusados pela guarda de caminhos
  // (regra 8); o sufixo mantém o tema salvável e o vault portável (API-01).
  return WINDOWS_RESERVED.test(slug) ? `${slug}-tema` : slug;
}

/** Rascunho do editor de temas (R-5.3): o arquivo gerado nunca tem o campo `css`. */
export interface ThemeDraft {
  readonly name: string;
  readonly base: ThemeBase;
  readonly tokens: Tokens;
}

/** `theme.json` determinístico do rascunho (AC-5.3). */
export function generateThemeJson(draft: ThemeDraft): string {
  return serializeTheme({ name: draft.name, base: draft.base, tokens: draft.tokens });
}

export interface UserThemeWarning extends ThemeValidationError {
  readonly id: string;
}

/**
 * Temas do vault (arch-frontend C-11): pastas de `.simplemd/themes` com nome de id válido que não
 * seja de um embutido. Cada `theme.json` é lido (teto de 256 KB pelo provider) e validado; um tema
 * inválido fica de fora com um aviso que nomeia o id e o campo.
 */
export async function listUserThemes(
  provider: VaultProvider,
  handle: VaultHandle,
): Promise<{ themes: Theme[]; warnings: UserThemeWarning[] }> {
  const themes: Theme[] = [];
  const warnings: UserThemeWarning[] = [];
  for (const id of await themeDirs(provider, handle)) {
    if (BUILTIN_THEMES.some((t) => t.id === id)) continue;
    let text: string;
    try {
      ({ text } = await provider.read(handle, themeFilePath(id)));
    } catch (error) {
      if (isVaultError(error, 'NOT_FOUND')) continue;
      const tooLarge = isVaultError(error, 'TOO_LARGE');
      warnings.push({
        id,
        field: 'arquivo',
        message: tooLarge ? 'maior que 256 KB' : 'não foi possível ler',
      });
      continue;
    }
    const result = validateTheme(text);
    if (result.ok) themes.push({ ...result.theme, id, builtin: false });
    else warnings.push({ id, ...result.error });
  }
  return { themes, warnings };
}

/** Ids (nomes de pasta) já usados em `.simplemd/themes`; pasta inexistente = nenhum. */
async function themeDirs(provider: VaultProvider, handle: VaultHandle): Promise<string[]> {
  try {
    const prefix = `${THEMES_DIR}/`;
    return (await provider.list(handle, THEMES_DIR))
      .filter((e) => e.kind === 'dir' && !e.path.slice(prefix.length).includes('/'))
      .map((e) => e.name)
      .filter(isThemeId);
  } catch (error) {
    if (isVaultError(error, 'NOT_FOUND')) return [];
    throw error;
  }
}

/**
 * Grava um tema novo (R-5.4, AC-5.6): id = slug do nome; se já existir (ou for de um embutido),
 * `<slug>-2`, `<slug>-3`… Cada tentativa é só-criação (`createWithFreeName`), então nenhum arquivo
 * existente é tocado, nem numa corrida com outro programa. Devolve o id e o texto gravado.
 */
export async function saveTheme(
  provider: VaultProvider,
  handle: VaultHandle,
  theme: ThemeFile,
): Promise<{ id: string; text: string }> {
  const slug = slugify(theme.name);
  const taken = new Set([
    ...BUILTIN_THEMES.map((t) => t.id),
    ...(await themeDirs(provider, handle)),
  ]);
  const free: string[] = [];
  let k = 1;
  const candidate = (n: number): string => {
    while (free.length < n) {
      const id = k === 1 ? slug : `${slug}-${k}`;
      k++;
      if (!taken.has(id)) free.push(id);
    }
    return themeFilePath(free[n - 1] ?? slug);
  };
  const text = serializeTheme(theme);
  const { path } = await createWithFreeName(provider, handle, candidate, text);
  return { id: path.slice(THEMES_DIR.length + 1, -'/theme.json'.length), text };
}

/**
 * Importa os bytes de um `theme.json` (R-5.6): inválido → o primeiro campo que falhou e NENHUMA
 * chamada ao provider (AC-5.9); válido → gravado com a serialização canônica, com `css` preservado
 * e nunca carregado (D-5, AC-5.10).
 */
export async function importTheme(
  provider: VaultProvider,
  handle: VaultHandle,
  bytes: Uint8Array,
): Promise<{ ok: true; theme: Theme } | { ok: false; error: ThemeValidationError }> {
  const result = validateTheme(bytes);
  if (!result.ok) return result;
  const { id } = await saveTheme(provider, handle, result.theme);
  return { ok: true, theme: { ...result.theme, id, builtin: false } };
}

/**
 * Bytes para exportar (R-5.5, AC-5.7, U-6): um tema do vault sai exatamente como está no disco
 * (relido, não reserializado); um embutido sai como o conjunto completo de tokens composto.
 */
export async function exportThemeBytes(
  provider: VaultProvider,
  handle: VaultHandle | null,
  theme: Theme,
): Promise<Uint8Array> {
  if (theme.builtin) {
    return new TextEncoder().encode(
      serializeTheme({ name: theme.name, base: theme.base, tokens: theme.tokens }),
    );
  }
  if (handle === null) throw new Error(`tema do vault sem pasta aberta: ${theme.id}`);
  const { text } = await provider.read(handle, themeFilePath(theme.id));
  return new TextEncoder().encode(text);
}
