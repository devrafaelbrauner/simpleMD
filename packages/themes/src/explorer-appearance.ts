import { isJsonObject, type Entry } from '@simplemd/vault';
import { FOLDER_COLOR_IDS, type FolderColorId } from './folder-colors';
import type { PreferenceWarning } from './preferences';

/**
 * Estilo do explorador (r13, arch-backend §1; D-R13-01): `config.json` `appearance.explorer`. Listas
 * fechadas de ids ASCII; só esses literais viram `data-*` (B4). Sem a chave = visual do r12.
 */
export const EXPLORER_STYLES = ['dot', 'stripe', 'card', 'gradient'] as const;
export const EXPLORER_AUTO = ['off', 'rainbow'] as const;
export const EXPLORER_INTENSITIES = ['subtle', 'medium', 'strong'] as const;
export const EXPLORER_SCOPES = ['own', 'inherit'] as const;

export type ExplorerStyle = (typeof EXPLORER_STYLES)[number];
export type ExplorerAuto = (typeof EXPLORER_AUTO)[number];
export type ExplorerIntensity = (typeof EXPLORER_INTENSITIES)[number];
export type ExplorerScope = (typeof EXPLORER_SCOPES)[number];

export interface ExplorerAppearance {
  readonly style: ExplorerStyle;
  readonly auto: ExplorerAuto;
  readonly intensity: ExplorerIntensity;
  readonly scope: ExplorerScope;
}

export const DEFAULT_EXPLORER_APPEARANCE: ExplorerAppearance = Object.freeze({
  style: 'dot',
  auto: 'off',
  intensity: 'medium',
  scope: 'own',
});

/** Motivos do aviso: listam os aceitos e nunca ecoam o valor do arquivo (B4). */
const STYLE_REASON = 'use dot, stripe, card ou gradient';
const AUTO_REASON = 'use off ou rainbow';
const INTENSITY_REASON = 'use subtle, medium ou strong';
const SCOPE_REASON = 'use own ou inherit';

/** O literal da lista igual a `value` (nunca a string lida), ou `undefined`. */
function pick<T extends string>(list: readonly T[], value: unknown): T | undefined {
  return list.find((item) => item === value);
}

export interface ParsedExplorerAppearance {
  readonly appearance: ExplorerAppearance;
  readonly warnings: PreferenceWarning[];
}

/**
 * `appearance.explorer` do `config.json` (AC-13.7, arch-backend §2): campo ausente = padrão sem
 * aviso; tipo errado ou fora da lista = padrão só desse campo + 1 aviso que o nomeia; extras são
 * ignorados. Leitura por `Object.hasOwn` (o arquivo não é confiável). Nunca grava.
 */
export function parseExplorerAppearance(config: unknown): ParsedExplorerAppearance {
  const warnings: PreferenceWarning[] = [];
  const appearance =
    isJsonObject(config) && Object.hasOwn(config, 'appearance') ? config.appearance : undefined;
  if (appearance === undefined) return { appearance: DEFAULT_EXPLORER_APPEARANCE, warnings };
  if (!isJsonObject(appearance)) {
    warnings.push({ field: 'appearance', reason: 'deve ser um objeto' });
    return { appearance: DEFAULT_EXPLORER_APPEARANCE, warnings };
  }
  const explorer = Object.hasOwn(appearance, 'explorer') ? appearance.explorer : undefined;
  if (explorer === undefined) return { appearance: DEFAULT_EXPLORER_APPEARANCE, warnings };
  if (!isJsonObject(explorer)) {
    warnings.push({ field: 'appearance.explorer', reason: 'deve ser um objeto' });
    return { appearance: DEFAULT_EXPLORER_APPEARANCE, warnings };
  }
  const field = <K extends keyof ExplorerAppearance>(
    name: K,
    list: readonly ExplorerAppearance[K][],
    reason: string,
  ): ExplorerAppearance[K] => {
    if (!Object.hasOwn(explorer, name)) return DEFAULT_EXPLORER_APPEARANCE[name];
    const value = pick(list, explorer[name]);
    if (value !== undefined) return value;
    warnings.push({ field: `appearance.explorer.${name}`, reason });
    return DEFAULT_EXPLORER_APPEARANCE[name];
  };
  // Literal de objeto: avalia (e avisa) na ordem style, auto, intensity, scope.
  return {
    appearance: {
      style: field('style', EXPLORER_STYLES, STYLE_REASON),
      auto: field('auto', EXPLORER_AUTO, AUTO_REASON),
      intensity: field('intensity', EXPLORER_INTENSITIES, INTENSITY_REASON),
      scope: field('scope', EXPLORER_SCOPES, SCOPE_REASON),
    },
    warnings,
  };
}

/** Mudança vinda da seção Explorador: campo inválido mantém o atual (arch-backend §3). */
export function normalizeExplorerPatch(
  patch: Partial<ExplorerAppearance>,
  current: ExplorerAppearance,
): ExplorerAppearance {
  return {
    style: pick(EXPLORER_STYLES, patch.style) ?? current.style,
    auto: pick(EXPLORER_AUTO, patch.auto) ?? current.auto,
    intensity: pick(EXPLORER_INTENSITIES, patch.intensity) ?? current.intensity,
    scope: pick(EXPLORER_SCOPES, patch.scope) ?? current.scope,
  };
}

/**
 * O que o explorador aplica (D-R13-B3): em Bolinha não há herdeiras (`scope` vale `own`) e a
 * intensidade não tem efeito; o valor guardado não muda e volta ao trocar o estilo.
 */
export function effectiveExplorer(appearance: ExplorerAppearance): ExplorerAppearance {
  return appearance.style === 'dot' && appearance.scope !== 'own'
    ? { ...appearance, scope: 'own' }
    : appearance;
}

/**
 * Arco-íris nas pastas do topo (R-13.3, D-R13-P1/B2): filhas diretas da raiz, sem ocultas, na ordem
 * de `entries` (= ordem do explorador) recebem as 8 cores pelo índice mod 8; pasta com cor própria
 * mantém a sua e ocupa a posição. Devolve só as automáticas; nunca grava. O(n).
 */
export function rainbowColors(
  entries: readonly Pick<Entry, 'kind' | 'path'>[],
  own: ReadonlyMap<string, FolderColorId>,
): Map<string, FolderColorId> {
  const auto = new Map<string, FolderColorId>();
  let index = 0;
  for (const entry of entries) {
    if (entry.kind !== 'dir' || entry.path.includes('/') || entry.path.startsWith('.')) continue;
    if (!own.has(entry.path))
      auto.set(entry.path, FOLDER_COLOR_IDS[index % FOLDER_COLOR_IDS.length]!);
    index++;
  }
  return auto;
}

export type ExplorerColorSource = 'own' | 'auto' | 'inherited';

export interface ExplorerRowColor {
  readonly id: FolderColorId;
  readonly source: ExplorerColorSource;
}

/**
 * Cor de uma linha de pasta (arch-backend §5): própria, senão automática; em `inherit`, a do
 * ancestral colorido mais próximo (próprio ou automático) como herdeira. A raiz nunca colore.
 * O(profundidade) consultas, independente do tamanho dos mapas.
 */
export function explorerRowColor(
  own: ReadonlyMap<string, FolderColorId>,
  auto: ReadonlyMap<string, FolderColorId>,
  path: string,
  scope: ExplorerScope,
): ExplorerRowColor | null {
  const ownId = own.get(path);
  if (ownId !== undefined) return { id: ownId, source: 'own' };
  const autoId = auto.get(path);
  if (autoId !== undefined) return { id: autoId, source: 'auto' };
  if (scope !== 'inherit') return null;
  let ancestor = path;
  for (let slash = ancestor.lastIndexOf('/'); slash > 0; slash = ancestor.lastIndexOf('/')) {
    ancestor = ancestor.slice(0, slash);
    const id = own.get(ancestor) ?? auto.get(ancestor);
    if (id !== undefined) return { id, source: 'inherited' };
  }
  return null;
}
