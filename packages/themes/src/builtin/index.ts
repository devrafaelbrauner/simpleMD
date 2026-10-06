// O pacote é consumido como código-fonte por apps e pacotes sem os tipos do Vite: a referência
// leva a declaração de `*.css?raw` junto com este arquivo.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- ver o comentário acima
/// <reference path="../raw.d.ts" />
import { parseTokensCss } from '../parse-tokens-css';
import type { Theme, Tokens } from '../schema';
import tokensCss from '../tokens.css?raw';
import darkJson from './simplemd-dark.json';

/**
 * Temas embutidos (arch-frontend §7.1, C-18). O claro é a própria `tokens.css` (lida como texto),
 * então nenhum valor existe em dois lugares (D-1). O escuro é `simplemd-dark.json` (cópia byte a
 * byte do handoff do design), composto por cima do claro.
 */
export const lightTokens: Tokens = Object.freeze(parseTokensCss(tokensCss));

/** Só as substituições do grupo de cores do tema escuro, como estão no JSON. */
export const darkOverrides: Tokens = Object.freeze({ ...darkJson.tokens });

export const LIGHT_THEME_ID = 'simplemd-light';
export const DARK_THEME_ID = 'simplemd-dark';

export const simplemdLight: Theme = Object.freeze({
  id: LIGHT_THEME_ID,
  name: 'simpleMD Claro',
  base: 'light',
  builtin: true,
  tokens: lightTokens,
});

export const simplemdDark: Theme = Object.freeze({
  id: DARK_THEME_ID,
  name: darkJson.name,
  base: 'dark',
  builtin: true,
  tokens: Object.freeze({ ...lightTokens, ...darkOverrides }),
});

/** Embutidos na ordem do seletor "Tema" (claro, escuro). */
export const BUILTIN_THEMES: readonly Theme[] = [simplemdLight, simplemdDark];

export const DEFAULT_THEME_ID = LIGHT_THEME_ID;

export const isBuiltinThemeId = (id: string): boolean => BUILTIN_THEMES.some((t) => t.id === id);
