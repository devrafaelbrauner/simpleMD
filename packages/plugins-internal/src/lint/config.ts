import type { ConfigFileRead } from '@simplemd/plugin-api/internal/host';
import { DEFAULT_LINT_CONFIG } from './rules';

/**
 * Configuração do lint (R-I5.2, D-30; arch-frontend r7 §10.2 `config.ts`): `.markdownlint.jsonc`
 * ou `.markdownlint.json` da raiz do vault (≤ 64 KB, lista fechada do backend) SUBSTITUI o padrão
 * do app. Só JSON: `extends` é ignorado, YAML/JS e regras personalizadas nunca são lidos. Arquivo
 * inválido → padrão do app (e um aviso por sessão, de quem chama).
 */
export type LintConfig = Readonly<Record<string, unknown>>;

/** Ordem do markdownlint-cli2 (D-R7-S5-01): o `.jsonc` vence; o `.json` só sem ele. */
export const LINT_CONFIG_FILES = ['.markdownlint.jsonc', '.markdownlint.json'] as const;
export type LintConfigFile = (typeof LINT_CONFIG_FILES)[number];

export type ConfigOrigin =
  | { readonly kind: 'default' }
  | { readonly kind: 'file'; readonly name: LintConfigFile }
  | { readonly kind: 'invalid'; readonly name: LintConfigFile };

export interface LoadedLintConfig {
  readonly config: LintConfig;
  readonly origin: ConfigOrigin;
}

/**
 * Remove comentários `//` e `/* … *\/` e vírgulas finais fora de strings (JSONC), preservando o
 * resto byte a byte. Sem `eval`: um varredor de estados.
 */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i] as string;
    if (char === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      out += text.slice(i, end + 1);
      i = end + 1;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (char === ',') {
      // Vírgula final antes de `}`/`]` (com espaço ou comentários no meio) cai; as outras ficam.
      let next = i + 1;
      for (;;) {
        while (next < text.length && /\s/.test(text[next] as string)) next++;
        if (text.startsWith('//', next)) {
          const end = text.indexOf('\n', next);
          next = end === -1 ? text.length : end;
        } else if (text.startsWith('/*', next)) {
          const end = text.indexOf('*/', next + 2);
          next = end === -1 ? text.length : end + 2;
        } else break;
      }
      if (text[next] !== '}' && text[next] !== ']') out += char;
      i++;
    } else {
      out += char;
      i++;
    }
  }
  return out;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Texto do arquivo → configuração do markdownlint, ou `null` se inválido: JSON (comentários e
 * vírgulas finais só no `.jsonc`) cujo topo é um objeto e cujos valores de regra são booleano,
 * `"error"`/`"warning"` ou objeto de opções. `extends` e `$schema` caem.
 */
export function parseLintConfig(text: string, jsonc: boolean): LintConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonc ? stripJsonc(text) : text);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'extends' || key === '$schema') continue;
    const ok =
      typeof value === 'boolean' ||
      value === 'error' ||
      value === 'warning' ||
      isPlainObject(value);
    if (!ok) return null;
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** Lê a configuração da pasta (o 1º arquivo que existe, na ordem de `LINT_CONFIG_FILES`). */
export async function loadLintConfig(
  read: (name: LintConfigFile) => Promise<ConfigFileRead | null>,
): Promise<LoadedLintConfig> {
  for (const name of LINT_CONFIG_FILES) {
    const file = await read(name);
    if (!file || ('error' in file && file.error === 'missing')) continue;
    const config = 'text' in file ? parseLintConfig(file.text, name.endsWith('c')) : null;
    return config
      ? { config, origin: { kind: 'file', name } }
      : { config: DEFAULT_LINT_CONFIG, origin: { kind: 'invalid', name } };
  }
  return { config: DEFAULT_LINT_CONFIG, origin: { kind: 'default' } };
}

/** STR-165: aviso de arquivo inválido (um por sessão por arquivo, decidido por quem chama). */
export function invalidConfigNotice(name: LintConfigFile): string {
  return `Lint: ${name} é inválido; usando as regras padrão do simpleMD.`;
}

/** Texto da opção "Regras em uso" (DESIGN §R7.6.8, arch-ux §3.3.1; STR-165). */
export function rulesInUseText(origin: ConfigOrigin): string {
  if (origin.kind === 'file') return `Arquivo ${origin.name} desta pasta`;
  if (origin.kind === 'invalid')
    return `Arquivo ${origin.name} desta pasta inválido; usando o padrão do simpleMD`;
  return 'Padrão do simpleMD (MD013, MD033 e MD041 desligadas)';
}
