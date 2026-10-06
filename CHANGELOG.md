# Changelog

Todas as mudanças relevantes deste projeto são registradas aqui.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Adicionado

- Etapa 0 — repositório e fundação do monorepo:
  - monorepo pnpm (`pnpm-workspace.yaml` com `apps/*` e `packages/*`; `packageManager` fixado em `pnpm@12.8.1`);
  - arquivos de controle: `PLANO.md` (cópia byte a byte do plano), `CHANGELOG.md`, `MELHORIAS.md`, `TAREFAS_PENDENTES.md`, `README.md` com as regras de arquitetura 1–7, `LICENSE` (MIT);
  - TypeScript (`tsconfig.base.json`), ESLint (flat config com as fronteiras entre pacotes), Prettier e Vitest (projetos por pacote e cobertura v8);
  - `.gitignore`, `.gitattributes` (LF em todas as plataformas; `PLANO.md` e fixtures byte a byte) e `.editorconfig`;
  - `packages/vault` com a guarda de caminhos `toVaultPath` e seus testes (roda no Windows desde já);
  - CI no GitHub Actions: lint + typecheck no Ubuntu; testes em matriz Ubuntu, Windows e macOS.
