// Portado de artisticat1/obsidian-latex-suite@5db51cf36abccdbbfa51184bb5fe86be8157cc2f (MIT), © 2022 artisticat1. Modificado para o simpleMD.
// Origem: src/snippets/codemirror/config.ts + os padrões de src/settings/settings.ts. Mudanças: só
// as configurações do escopo D-33 (sem conceal, prévia, colchetes coloridos, `snippetsTrigger`,
// arquivos de snippets do Obsidian); os 4 interruptores de R-I6.6 são lidos a cada tecla (opções
// do plugin, padrão ligado) e os snippets vêm do catálogo (padrão + `.simplemd/latex-snippets.json`).
import { Facet, type EditorState } from '@codemirror/state';
import type { Environment } from '../engine/environment';
import type { SnippetCatalog } from '../catalog';

export interface LatexSuiteSettings {
  readonly catalog: () => SnippetCatalog;
  readonly autofraction: () => boolean;
  readonly matrixShortcuts: () => boolean;
  readonly tabout: () => boolean;
  readonly autoEnlargeBrackets: () => boolean;
  /** Anúncio na região viva do editor (`host.editor.announce`). */
  readonly announce: (text: string) => void;
  readonly platform: 'mac' | 'other';
  /** A frase longa da primeira sessão de paradas já foi dita (por ativação do plugin). */
  readonly hint: { shown: boolean };
}

/** Constantes do upstream (`DEFAULT_SETTINGS`), já processadas. */
export const AUTOFRACTION_SYMBOL = '\\frac';
export const AUTOFRACTION_BREAKING_CHARS = '+-=\t';
export const WORD_DELIMITERS = '., +-\n\t:;!?\\/{}[]()=~$';
export const AUTOFRACTION_EXCLUDED_ENVS: readonly Environment[] = [
  { openSymbol: '^{', closeSymbol: '}' },
  { openSymbol: '\\pu{', closeSymbol: '}' },
];
export const MATRIX_SHORTCUTS_ENV_NAMES: readonly string[] = [
  'pmatrix',
  'cases',
  'align',
  'gather',
  'bmatrix',
  'Bmatrix',
  'vmatrix',
  'Vmatrix',
  'array',
  'matrix',
];
export const AUTO_ENLARGE_BRACKETS_TRIGGERS: readonly string[] = [
  'sum',
  'int',
  'frac',
  'prod',
  'bigcup',
  'bigcap',
];

export const latexSuiteConfig = Facet.define<LatexSuiteSettings, LatexSuiteSettings | null>({
  combine: (input) => input[0] ?? null,
});

export function getLatexSuiteConfig(state: EditorState): LatexSuiteSettings | null {
  return state.facet(latexSuiteConfig);
}
