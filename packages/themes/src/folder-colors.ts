import { isJsonObject, toVaultPath } from '@simplemd/vault';
import type { PreferenceWarning } from './preferences';

/**
 * Cores de pasta (r12, D-R12-P4): lista fechada de ids ASCII. Cada id vira o token opcional
 * `--color-folder-<id>` (claro em `tokens.css`, escuro em `builtin/simplemd-dark.json`); fora
 * desses dois arquivos a cor só aparece como `var(--color-folder-<id>)`, nunca como valor.
 */
export const FOLDER_COLOR_IDS = [
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
] as const;

export type FolderColorId = (typeof FOLDER_COLOR_IDS)[number];

export function isFolderColorId(value: unknown): value is FolderColorId {
  return typeof value === 'string' && (FOLDER_COLOR_IDS as readonly string[]).includes(value);
}

/** Teto de entradas lidas de `folderColors` (D-R12-P7); as excedentes são ignoradas com aviso. */
export const FOLDER_COLORS_MAX = 500;

const CONFIG_DIR = '.simplemd';
/** Caracteres de chave/valor citados no aviso (N4, AppSec R12-aviso-tamanho); o resto vira "…". */
const SHOWN_MAX = 64;
/** Controles bidi (U+202A–U+202E, U+2066–U+2069): o texto citado não pode reordenar o aviso. */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

/** Trecho do `config.json` como o aviso o mostra: sem controles bidi, até 64 caracteres. */
function shown(text: string): string {
  const chars = [...text.replace(BIDI_CONTROLS, '')];
  return chars.length <= SHOWN_MAX ? chars.join('') : `${chars.slice(0, SHOWN_MAX - 1).join('')}…`;
}

/** Campo do aviso STR-R12-03 para uma chave de `folderColors` (`folderColors["a/b"]`, cortado). */
export function folderColorField(key: string): string {
  return `folderColors["${shown(key)}"]`;
}

export interface ParsedFolderColors {
  /** Válidas, na ordem do arquivo; chave = caminho da pasta como `Entry.path`. */
  readonly colors: Map<string, FolderColorId>;
  /** Uma por entrada ignorada (campo + motivo, textos STR-R12-03). */
  readonly warnings: PreferenceWarning[];
}

/**
 * `config.json` `folderColors` (arch-backend r12 §2): o arquivo é não confiável, então cada valor
 * tem de ser um dos 8 ids e cada chave um caminho de pasta do vault (sem `..`, ocultos, `.simplemd`
 * nem a raiz). Só as 500 primeiras entradas do arquivo contam, válidas ou não. `Map` e nunca objeto
 * indexado: `__proto__` e `constructor` são nomes de pasta como outros.
 */
export function parseFolderColors(raw: unknown): ParsedFolderColors {
  const colors = new Map<string, FolderColorId>();
  const warnings: PreferenceWarning[] = [];
  if (raw === undefined) return { colors, warnings };
  if (!isJsonObject(raw)) {
    warnings.push({ field: 'folderColors', reason: 'deve ser um objeto' });
    return { colors, warnings };
  }
  const entries = Object.entries(raw);
  for (const [key, value] of entries.slice(0, FOLDER_COLORS_MAX)) {
    const field = folderColorField(key);
    const path = folderKey(key);
    if (path === null) warnings.push({ field, reason: 'a pasta não existe' });
    else if (typeof value !== 'string') warnings.push({ field, reason: 'deve ser texto' });
    else if (value.startsWith('#')) warnings.push({ field, reason: 'use um nome de cor, não hex' });
    else if (!isFolderColorId(value))
      warnings.push({ field, reason: `cor desconhecida “${shown(value)}”` });
    else if (!colors.has(path)) colors.set(path, value);
  }
  if (entries.length > FOLDER_COLORS_MAX) {
    warnings.push({
      field: 'folderColors',
      reason: `mais de ${FOLDER_COLORS_MAX} entradas; as excedentes foram ignoradas`,
    });
  }
  return { colors, warnings };
}

/** Caminho da pasta da chave (1 `/` final tirado), ou `null` se não pode ser pasta do vault. */
function folderKey(key: string): string | null {
  const trimmed = key.endsWith('/') ? key.slice(0, -1) : key;
  try {
    const path = toVaultPath(trimmed);
    return path === CONFIG_DIR || path.startsWith(`${CONFIG_DIR}/`) ? null : path;
  } catch {
    return null;
  }
}

export interface ResolvedFolderColor {
  /** Pasta que define a cor (origem mostrada na aba, P3). */
  readonly folder: string;
  readonly id: FolderColorId;
}

/**
 * Cor efetiva de uma nota (AC-12.4, P2): a da pasta colorida mais próxima subindo os ancestrais;
 * a raiz nunca colore. O(profundidade) consultas ao mapa, independente do tamanho dele.
 */
export function resolveFolderColor(
  map: ReadonlyMap<string, FolderColorId>,
  notePath: string,
): ResolvedFolderColor | null {
  if (map.size === 0) return null;
  let path = notePath;
  for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/')) {
    path = path.slice(0, slash);
    const id = map.get(path);
    if (id !== undefined) return { folder: path, id };
  }
  return null;
}
