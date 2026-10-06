// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const REACT = { paths: ['react', 'react-dom'], patterns: ['react/*', 'react-dom/*'] };
const TAURI = { patterns: ['@tauri-apps/*'] };
const NODE = { paths: ['fs', 'path', 'os'], patterns: ['node:*'] };
const ALL_SIMPLEMD = { patterns: ['@simplemd/*'] };
const VAULT_TEST_PORTS = { paths: ['@simplemd/vault/testing', '@simplemd/vault/node'] };
// Pacotes nunca importam apps.
const APPS = { patterns: ['**/apps/**'] };

/**
 * Monta exatamente UM bloco `no-restricted-imports` por glob. No flat config, um bloco
 * posterior com a mesma regra para os mesmos arquivos substitui o anterior em vez de
 * mesclar; por isso os globs abaixo não se sobrepõem.
 * @param {string} message
 * @param {...{ paths?: string[]; patterns?: string[] }} groups
 */
function restrict(message, ...groups) {
  const paths = groups.flatMap((g) => g.paths ?? []).map((name) => ({ name, message }));
  const patterns = groups.flatMap((g) => g.patterns ?? []);
  return {
    'no-restricted-imports': [
      'error',
      { paths, patterns: patterns.length > 0 ? [{ group: patterns, message }] : [] },
    ],
  };
}

// Bloqueia também `import('react')` / `import('@tauri-apps/...')` dinâmicos.
const noDynamicReactOrTauri = {
  'no-restricted-syntax': [
    'error',
    {
      selector: 'ImportExpression[source.value=/^(react|react-dom|@tauri-apps)(\\W|$)/]',
      message: 'Regras 2 e 3: este pacote não importa React nem Tauri, nem dinamicamente.',
    },
  ],
};

const RULE2 = 'Regra 2: packages/core não conhece React nem Tauri.';
const PLATFORM_FREE = 'Este pacote é livre de plataforma (sem React, Tauri ou Node).';

export default defineConfig([
  globalIgnores([
    '**/dist/**',
    '**/build/**',
    '**/coverage/**',
    'apps/desktop/src-tauri/target/**',
    'apps/desktop/src-tauri/gen/**',
    '.nexus/**',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },
  {
    files: ['*.{js,mjs,cjs,ts}', 'scripts/**', '**/vite*.config.ts', '**/vitest.config.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['packages/ui/**/*.{ts,tsx}', 'apps/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat['recommended-latest'],
  },

  // ---- Fronteiras entre pacotes (arch-backend §1.1; arch-frontend §1) ----
  {
    files: ['packages/core/**'],
    rules: {
      ...restrict(RULE2, REACT, TAURI, ALL_SIMPLEMD, NODE, APPS),
      ...noDynamicReactOrTauri,
    },
  },
  {
    files: ['packages/vault/src/**'],
    ignores: ['packages/vault/src/ports/node.ts'],
    rules: {
      ...restrict(PLATFORM_FREE, REACT, TAURI, ALL_SIMPLEMD, NODE, APPS),
      ...noDynamicReactOrTauri,
      'no-restricted-globals': ['error', 'window', 'document', 'localStorage'],
    },
  },
  {
    files: ['packages/vault/src/ports/node.ts'],
    rules: {
      ...restrict(
        'A porta Node não importa React, Tauri nem outros pacotes.',
        REACT,
        TAURI,
        ALL_SIMPLEMD,
        APPS,
      ),
      ...noDynamicReactOrTauri,
    },
  },
  {
    files: ['packages/vault/*', 'packages/vault/test/**'],
    rules: {
      ...restrict(
        'Testes do vault não importam React, Tauri nem pacotes de UI.',
        REACT,
        TAURI,
        { paths: ['@simplemd/core', '@simplemd/ui', '@simplemd/themes'] },
        APPS,
      ),
    },
  },
  {
    files: ['packages/themes/src/**'],
    rules: {
      ...restrict(
        PLATFORM_FREE,
        REACT,
        TAURI,
        NODE,
        { paths: ['@simplemd/ui', '@simplemd/core'], patterns: ['@codemirror/*'] },
        VAULT_TEST_PORTS,
        APPS,
      ),
      ...noDynamicReactOrTauri,
    },
  },
  {
    files: ['packages/themes/*', 'packages/themes/test/**'],
    rules: {
      ...restrict(
        'Testes de temas não importam React, Tauri nem pacotes de UI.',
        REACT,
        TAURI,
        { paths: ['@simplemd/ui', '@simplemd/core'] },
        APPS,
      ),
    },
  },
  {
    files: ['packages/ui/**'],
    rules: {
      ...restrict(
        'packages/ui não importa Tauri nem as portas de teste do vault.',
        TAURI,
        VAULT_TEST_PORTS,
        APPS,
      ),
    },
  },
  {
    files: ['apps/desktop/src/**'],
    ignores: ['apps/desktop/src/platform/**'],
    rules: {
      ...restrict(
        'Só apps/desktop/src/platform importa Tauri; o harness e as portas de teste nunca entram no app.',
        TAURI,
        VAULT_TEST_PORTS,
        { patterns: ['**/harness/**'] },
      ),
    },
  },
  {
    files: ['apps/desktop/src/platform/**'],
    rules: {
      ...restrict('A plataforma não usa as portas de teste do vault.', VAULT_TEST_PORTS),
    },
  },
  {
    files: ['apps/desktop/harness/**', 'apps/demo/**'],
    rules: {
      ...restrict('O harness e a demo rodam no Chromium, sem Tauri.', TAURI),
    },
  },

  prettier,
]);
