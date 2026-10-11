import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts'],
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'build/coverage',
      // apps/desktop/src entra só no relatório (CR-16); os limites valem só para NFR-16 e NFR-39.
      include: ['packages/*/src/**', 'apps/desktop/src/**'],
      // Só código: os `SOURCE.md` das fontes geravam PARSE_ERROR em toda execução (TA-5).
      exclude: [
        '**/testing/**',
        '**/*.test-d.ts',
        '**/*.md',
        '**/*.json',
        '**/*.woff2',
        '**/*.txt',
      ],
      thresholds: {
        'packages/vault/src/**': { lines: 80 }, // NFR-16
        'packages/plugin-api/src/**': { lines: 80 }, // NFR-39 (API de plugins)
        'packages/ai/src/**': { lines: 80 }, // NFR-39 (camada de IA)
        'packages/plugins-internal/src/calc/**': { branches: 90 }, // NFR-39 (avaliador do calc)
        'packages/core/src/metadata/yaml.ts': { branches: 90 }, // NFR-39 (validador do front matter)
        'apps/desktop/src/plugins/internal/**': { lines: 80 }, // r7 NFR-59 (registro dos plugins internos, S0)
        'packages/vault/src/image-type.ts': { branches: 90 }, // NFR-59 (r7 SN, tipos de imagem)
        'packages/core/src/keys/**': { lines: 90 }, // r7 ST (cadeia de contexto, modo de foco; WCAG 2.1.2)
        'apps/desktop/src/app/{status-bar,global-keys}.ts': { lines: 90 }, // r7 ST
        // r7 S1 (NFR-59): linhas ≥ 80 % por módulo novo; ramos ≥ 90 % na validação de URL/esquema,
        // resolução de caminho e parser de tarefas.
        'packages/core/src/live-preview/**': { lines: 80 },
        'packages/core/src/links/**': { lines: 80 },
        'packages/core/src/links/url-policy.ts': { branches: 90 },
        'packages/core/src/links/vault-path.ts': { branches: 90 },
        'packages/core/src/links/target.ts': { branches: 90 },
        'packages/core/src/tasks/syntax.ts': { lines: 80, branches: 90 },
        'packages/core/src/tasks/semantics.ts': { lines: 80 },
        'apps/desktop/src/app/link-opener.ts': { lines: 80 },
        'apps/desktop/src/editor/image-service.ts': { lines: 80 },
        'apps/desktop/src/export/images.ts': { lines: 80 },
        // r7 S10 (NFR-59): linhas ≥ 80 % no módulo novo; ramos ≥ 90 % na política do sanitizador.
        'packages/core/src/sanitize/**': { lines: 80 },
        'packages/core/src/sanitize/{policy,style,sanitizer}.ts': { branches: 90 },
        // r7 S2 (NFR-59): linhas ≥ 80 % por módulo novo; ramos ≥ 90 % no nome de nota nova e na
        // resolução de wikilinks.
        'packages/core/src/wikilinks/**': { lines: 80 },
        'packages/core/src/wikilinks/resolve.ts': { branches: 90 },
        'packages/core/src/live-preview/wikilinks.ts': { lines: 80 },
        'packages/vault/src/catalog/schema.ts': { lines: 80 },
        'packages/vault/src/note-name.ts': { lines: 80, branches: 90 },
        'apps/desktop/src/catalog/links.ts': { lines: 80 },
        'apps/desktop/src/app/useLinksPanel.ts': { lines: 80 },
        'packages/ui/src/sidepanel/LinksPanel.tsx': { lines: 80 },
        'packages/core/src/tables/**': { lines: 90 }, // r7 S3 (adaptador e comandos de tabela, AC-I3.1/I3.2)
        'packages/plugins-internal/src/vim/**': { lines: 90 }, // r7 S4 (modo Vim: indicador, ex, painel W6)
        // r7 S7 (NFR-59, JEV D-R7-S7-04): linhas ≥ 80 % no conjunto do outliner; arrastar e guias
        // dependem de layout (o resto é coberto pelo smoke Playwright).
        'packages/plugins-internal/src/outliner/**': { lines: 80 },
        'packages/plugins-internal/src/latex-snippets/**': { lines: 90 }, // r7 S6 (motor, paradas e snippets do usuário, AC-I6.1–I6.6)
        // r7 S9a (NFR-59): linhas ≥ 80 % por módulo novo; ramos ≥ 90 % no parser de tarefas.
        'packages/core/src/tasks/line.ts': { lines: 80, branches: 90 },
        'packages/core/src/tasks/{dates,recurrence,complete}.ts': { lines: 80 },
        'apps/desktop/src/catalog/tasks-catalog.ts': { lines: 80 },
        // r7 S9b (NFR-59): linhas ≥ 80 % no plugin de consultas; ramos ≥ 90 % nos dois parsers.
        'packages/plugins-internal/src/tasks/**': { lines: 80 },
        'packages/plugins-internal/src/tasks/query/{tasks-parser,dql-parser}.ts': { branches: 90 },
        // r7 S5 (NFR-59): lint e UI de diagnósticos ≥ 80 % de linhas; leitura da configuração ≥ 90 % de ramos.
        'packages/plugins-internal/src/lint/**': { lines: 80 },
        'packages/plugins-internal/src/lint/config.ts': { branches: 90 },
        'packages/plugins-internal/src/shared/diagnostics-ui.ts': { lines: 80 },
        // r7 S8 (NFR-59): linhas ≥ 80 % no plugin do LanguageTool; ramos ≥ 90 % no validador de resposta.
        'packages/plugins-internal/src/languagetool/**': { lines: 80 },
        'packages/plugins-internal/src/languagetool/response.ts': { branches: 90 },
      },
    },
  },
});
