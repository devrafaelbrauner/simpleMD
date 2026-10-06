# Changelog

Todas as mudanças relevantes deste projeto são registradas aqui.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Adicionado

- Etapa 1 — núcleo do editor:
  - `packages/core`: composição CodeMirror 6 + `@codemirror/lang-markdown` com GFM (`createMarkdownExtensions`, `createMarkdownState`), comandos `toggleBold` (`Mod-B`, `**…**`), `toggleItalic` (`Mod-I`, `*…*`) e `insertLink` (`Mod-K`, `[texto](url)` com `url` selecionado), atalhos com precedência sobre o `Mod-I` padrão, tema do editor só com `var(--…)` e nome acessível "Editor de markdown"; Tab não é capturado;
  - `packages/ui`: `<CodeMirrorEditor>` cria o `EditorView` uma única vez por montagem e se comunica por um handle (`dispatch`, `setState`, `getText`, `focus`); `initialDoc` só é lido na montagem;
  - `packages/ui/src/styles/app.css`: Tailwind v4 mapeado para os tokens (`@theme inline reference`, sem redeclarar nomes de tokens);
  - `apps/demo`: página Vite em `pnpm dev` / `pnpm dev:demo` (porta 5173) que importa `@simplemd/themes/tokens.css`, com `?doc=fixture` (documento de exemplo do live preview) e `?doc=large` (10.000 linhas determinísticas);
  - ESLint impede React, Tauri e Node em `packages/core`, inclusive em `import()` dinâmico;
  - testes Vitest: árvore de sintaxe GFM, comandos e atalhos, gerador do documento grande e o invariante de um único `EditorView`;
  - `@playwright/test` 1.63.0 como dependência de desenvolvimento (mesma revisão do Chromium em cache) para os testes de interface.

- Etapa 0 — repositório e fundação do monorepo:
  - monorepo pnpm (`pnpm-workspace.yaml` com `apps/*` e `packages/*`; `packageManager` fixado em `pnpm@12.8.1`);
  - arquivos de controle: `PLANO.md` (cópia byte a byte do plano), `CHANGELOG.md`, `MELHORIAS.md`, `TAREFAS_PENDENTES.md`, `README.md` com as regras de arquitetura 1–7, `LICENSE` (MIT);
  - TypeScript (`tsconfig.base.json`), ESLint (flat config com as fronteiras entre pacotes), Prettier e Vitest (projetos por pacote e cobertura v8);
  - `.gitignore`, `.gitattributes` (LF em todas as plataformas; `PLANO.md` e fixtures byte a byte) e `.editorconfig`;
  - `packages/vault` com a guarda de caminhos `toVaultPath` e seus testes (roda no Windows desde já);
  - CI no GitHub Actions: lint + typecheck no Ubuntu; testes em matriz Ubuntu, Windows e macOS.
