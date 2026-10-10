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

/** r7 R-X7.10 / AC-I9.1: tipos da interface privada do `simplemd.tasks` (arch-frontend r7 §1). */
const TASKS_CATALOG_TYPES = '@simplemd/plugin-api/internal/tasks-catalog';
const TASKS_CATALOG =
  'AC-I9.1: a interface privada do catálogo de tarefas só é importada pelo registro apps/desktop/src/plugins/internal/tasks.ts e por packages/plugins-internal/src/tasks/**.';
/** r7 D-R7-F07: o motor de tabelas é um pedaço sob demanda, carregado num único lugar. */
const TABLES_ENGINE = '@tgrosinger/md-advanced-tables';
const TABLES_ENGINE_FILE = 'packages/core/src/tables/engine.ts';
const TABLES =
  'D-R7-F07: @tgrosinger/md-advanced-tables só entra por import() dinâmico em packages/core/src/tables/engine.ts (import type é livre).';

/** @param {string} name nome de pacote como literal de regex */
const literal = (name) => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Um bloco por pasta de `packages/plugins-internal/src` (arch-frontend r2 §1, r7 §1): `./x` da
 * própria pasta, `../shared/x`, os módulos do host e a(s) biblioteca(s) da pasta; tipos de
 * `@simplemd/plugin-api`, `@simplemd/plugin-api/internal/host` e `@lezer/common` só com
 * `import type` (mais os tipos privados listados na pasta). Imports dinâmicos só da própria
 * biblioteca, com literal. Os globs não se sobrepõem (`ignores` separa arquivos com regra própria).
 */
function internalPluginBlocks() {
  const src = 'packages/plugins-internal/src';
  /** @type {{ glob: string[]; ignores?: string[]; shared?: boolean; libraries?: string[]; dynamic?: string[]; types?: string[] }[]} */
  const folders = [
    {
      glob: [`${src}/shared/**`, `${src}/*.ts`],
      ignores: [`${src}/shared/diagnostics-ui.ts`],
    },
    // UX CF-R7-10 / D-R7-F26: o cartão de diagnóstico compartilhado por lint e LT.
    { glob: [`${src}/shared/diagnostics-ui.ts`], libraries: ['@codemirror/lint'] },
    { glob: [`${src}/calc/**`], shared: true },
    { glob: [`${src}/katex/**`], shared: true, libraries: ['katex(?:/.+)?'], dynamic: ['katex'] },
    {
      glob: [`${src}/mermaid/**`],
      shared: true,
      libraries: ['mermaid(?:/.+)?'],
      dynamic: ['mermaid'],
    },
    { glob: [`${src}/vim/**`], shared: true, libraries: [literal('@replit/codemirror-vim')] },
    {
      glob: [`${src}/lint/**`],
      ignores: [`${src}/lint/worker.ts`],
      shared: true,
      libraries: [literal('@codemirror/lint')],
    },
    // D-R7-F05: o markdownlint roda só no Web Worker.
    {
      glob: [`${src}/lint/worker.ts`],
      shared: true,
      libraries: [literal('@codemirror/lint'), literal('markdownlint/sync')],
    },
    {
      glob: [`${src}/latex-snippets/**`],
      shared: true,
      libraries: [literal('@codemirror/commands')],
    },
    { glob: [`${src}/outliner/**`], shared: true, libraries: [literal('@codemirror/commands')] },
    {
      glob: [`${src}/languagetool/**`],
      shared: true,
      libraries: [literal('@codemirror/lint')],
      types: [literal('@simplemd/plugin-api/internal/languagetool')],
    },
    { glob: [`${src}/tasks/**`], shared: true, types: [literal(TASKS_CATALOG_TYPES)] },
  ];
  return folders.map(({ glob, ignores, shared = false, libraries = [], dynamic = [], types }) => {
    const allowed = [
      HOST_MODULES,
      '\\./(?!.*\\.\\.).+',
      ...(shared ? ['\\.\\./shared/(?!.*\\.\\.).+'] : []),
      ...libraries,
    ];
    const typeOnly = `(?:${[
      '@simplemd/plugin-api',
      literal('@simplemd/plugin-api/internal/host'),
      '@lezer/common',
      ...(types ?? []),
    ].join('|')})`;
    const dynamicSelector =
      dynamic.length > 0
        ? `ImportExpression:not([source.value=/^(?:${dynamic.join('|')})(\\/.+)?$/])`
        : 'ImportExpression';
    return {
      files: glob,
      ...(ignores ? { ignores } : {}),
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
          { selector: dynamicSelector, message: INTERNAL_PLUGIN },
          WEBKIT16_SYNTAX,
        ],
        'no-eval': 'error',
        'no-new-func': 'error',
        'no-implied-eval': 'error',
      },
    };
  });
}

/** Caminhos privados que nem o núcleo nem o resto do app importam (AC-I9.1). */
const privateTasksCatalog = {
  paths: [{ name: TASKS_CATALOG_TYPES, message: TASKS_CATALOG }],
  patterns: [
    { group: ['**/internal/tasks-catalog', '**/catalog/tasks-catalog'], message: TASKS_CATALOG },
  ],
};

/** `packages/core`: o motor de tabelas nunca entra por import estático; tipos são livres. */
const coreImports = {
  '@typescript-eslint/no-restricted-imports': [
    'error',
    {
      paths: [
        { name: TABLES_ENGINE, allowTypeImports: true, message: TABLES },
        ...privateTasksCatalog.paths,
      ],
      patterns: [
        { group: [`${TABLES_ENGINE}/*`], allowTypeImports: true, message: TABLES },
        ...privateTasksCatalog.patterns,
      ],
    },
  ],
};

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
    ignores: [TABLES_ENGINE_FILE],
    rules: {
      ...restrict(RULE2, REACT, TAURI, ALL_SIMPLEMD, NODE, APPS),
      ...coreImports,
      'no-restricted-syntax': [
        ...noDynamicReactOrTauri['no-restricted-syntax'],
        {
          selector: `ImportExpression[source.value=/^${literal(TABLES_ENGINE)}(\\/|$)/]`,
          message: TABLES,
        },
      ],
    },
  },
  {
    // D-R7-F07: o único `import()` do motor de tabelas.
    files: [TABLES_ENGINE_FILE],
    rules: {
      ...restrict(RULE2, REACT, TAURI, ALL_SIMPLEMD, NODE, APPS),
      ...coreImports,
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
    // r7 R-X7.10 / AC-I9.1: fora do registro do `simplemd.tasks` e da pasta do plugin, nada do
    // código de produção alcança a interface privada nem a implementação do catálogo de tarefas
    // (os testes ficam livres). Regra própria (`@typescript-eslint/…`) para somar às de cada pasta.
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    ignores: [
      'packages/core/**',
      'packages/plugins-internal/src/**',
      'apps/desktop/src/plugins/internal/tasks.ts',
      '**/test/**',
      '**/e2e/**',
      '**/*.test.{ts,tsx}',
      '**/*.test-d.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', privateTasksCatalog],
    },
  },
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
