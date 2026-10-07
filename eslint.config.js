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

// CR-08: o build mira `safari16` (WKWebView do macOS 13). Lookbehind em regex (WebKit 16.4) é erro
// de sintaxe na carga, e `Promise.withResolvers` (WebKit 17.4) não existe lá.
const WEBKIT16_SYNTAX = {
  selector: 'Literal[regex.pattern=/\\(\\?<[=!]/]',
  message: 'CR-08: lookbehind em regex não roda no WKWebView do macOS < 13.3 (alvo safari16).',
};
const WITH_RESOLVERS = {
  object: 'Promise',
  property: 'withResolvers',
  message: 'CR-08: Promise.withResolvers não existe no WKWebView do macOS < 14.4 (alvo safari16).',
};

// Bloqueia também `import('react')` / `import('@tauri-apps/...')` dinâmicos.
const noDynamicReactOrTauri = {
  'no-restricted-syntax': [
    'error',
    {
      selector: 'ImportExpression[source.value=/^(react|react-dom|@tauri-apps)(\\W|$)/]',
      message: 'Regras 2 e 3: este pacote não importa React nem Tauri, nem dinamicamente.',
    },
    WEBKIT16_SYNTAX,
  ],
};

const RULE2 = 'Regra 2: packages/core não conhece React nem Tauri.';
const PLATFORM_FREE = 'Este pacote é livre de plataforma (sem React, Tauri ou Node).';

/** Módulos do host da API v1 (R-6.8): os únicos imports de execução comuns a todo plugin. */
const HOST_MODULES = '@codemirror/(?:state|view|language|autocomplete)';
const INTERNAL_PLUGIN =
  'Plugins internos usam só a API v1 (tipos), os 4 módulos do host, a própria biblioteca e os próprios arquivos (AC-7.1).';

/**
 * Um bloco por pasta de `packages/plugins-internal/src` (arch-frontend r2 §1): `./x` da própria
 * pasta, `../shared/x`, os módulos do host e a biblioteca da pasta; `@simplemd/plugin-api` e
 * `@lezer/common` só com `import type`. Imports dinâmicos só da própria biblioteca, com literal.
 */
function internalPluginBlocks() {
  const folders = [
    { glob: ['packages/plugins-internal/src/shared/**', 'packages/plugins-internal/src/*.ts'] },
    { glob: ['packages/plugins-internal/src/calc/**'], shared: true },
    { glob: ['packages/plugins-internal/src/katex/**'], shared: true, library: 'katex' },
    { glob: ['packages/plugins-internal/src/mermaid/**'], shared: true, library: 'mermaid' },
  ];
  return folders.map(({ glob, shared = false, library }) => {
    const allowed = [
      HOST_MODULES,
      '\\./(?!.*\\.\\.).+',
      ...(shared ? ['\\.\\./shared/(?!.*\\.\\.).+'] : []),
      ...(library ? [`${library}(?:/.+)?`] : []),
    ];
    const typeOnly = '(?:@simplemd/plugin-api|@lezer/common)';
    const dynamic = library
      ? `ImportExpression:not([source.value=/^${library}(\\/.+)?$/])`
      : 'ImportExpression';
    return {
      files: glob,
      rules: {
        '@typescript-eslint/no-restricted-imports': [
          'error',
          {
            patterns: [
              { regex: `^(?!(?:${allowed.join('|')})$)(?!${typeOnly}$)`, message: INTERNAL_PLUGIN },
              { regex: `^${typeOnly}$`, allowTypeImports: true, message: INTERNAL_PLUGIN },
            ],
          },
        ],
        'no-restricted-syntax': [
          'error',
          { selector: dynamic, message: INTERNAL_PLUGIN },
          WEBKIT16_SYNTAX,
        ],
        'no-eval': 'error',
        'no-new-func': 'error',
        'no-implied-eval': 'error',
      },
    };
  });
}

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
    // AC-6.3 (regras 2–3): a API de plugins não conhece React, ReactDOM, Tauri nem outros pacotes
    // do simpleMD (tudo chega por portas) nem Node.
    files: ['packages/plugin-api/src/**'],
    rules: {
      ...restrict(
        'Regras 2 e 3: @simplemd/plugin-api não importa React, Tauri, Node nem pacotes do simpleMD.',
        REACT,
        TAURI,
        ALL_SIMPLEMD,
        NODE,
        APPS,
      ),
      ...noDynamicReactOrTauri,
    },
  },
  {
    // AC-6.24: o exemplo é um ES module puro que só importa os módulos do host.
    files: ['plugins-examples/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!@codemirror/(state|view|language|autocomplete)$)',
              message: 'Plugins v1 só importam os 4 módulos do host (docs/plugins.md).',
            },
          ],
        },
      ],
    },
  },
  // AC-7.1 / R-7.1: plugins internos só importam os tipos da API, os 4 módulos do host, a própria
  // biblioteca (só na pasta dela) e os próprios arquivos; nada de eval (AC-7.7).
  ...internalPluginBlocks(),
  {
    // R-11.2 / AC-11.19: `packages/ai` é TypeScript puro — sem React, Tauri, Node, outros pacotes do
    // simpleMD nem rede própria (o transporte é injetado; HTTP só no Rust).
    files: ['packages/ai/src/**'],
    rules: {
      ...restrict(
        'R-11.2: packages/ai não importa React, Tauri, Node nem pacotes do simpleMD.',
        REACT,
        TAURI,
        ALL_SIMPLEMD,
        NODE,
        APPS,
      ),
      ...noDynamicReactOrTauri,
      'no-restricted-globals': [
        'error',
        ...['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'].map((name) => ({
          name,
          message: 'AC-11.19: packages/ai não faz rede; o transporte é injetado (HTTP só no Rust).',
        })),
      ],
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

  // ---- Compatibilidade com o alvo do build (CR-08): todo código que entra no app desktop ----
  {
    files: ['packages/ui/src/**', 'apps/desktop/src/**'],
    rules: { 'no-restricted-syntax': ['error', WEBKIT16_SYNTAX] },
  },
  {
    files: ['packages/*/src/**', 'apps/desktop/src/**'],
    rules: { 'no-restricted-properties': ['error', WITH_RESOLVERS] },
  },
  {
    // AC-11.19: também `globalThis.fetch`/`window.fetch`/`self.fetch` (o bloco acima vale junto).
    files: ['packages/ai/src/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        WITH_RESOLVERS,
        ...['globalThis', 'window', 'self'].map((object) => ({
          object,
          property: 'fetch',
          message: 'AC-11.19: packages/ai não faz rede; o transporte é injetado (HTTP só no Rust).',
        })),
      ],
    },
  },

  prettier,
]);
