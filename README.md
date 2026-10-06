# simpleMD

Editor de markdown open source (MIT), extensível por plugins e temas, em que o **markdown fica visível** (modelo Obsidian / VSCodium), com renderização inline. Os arquivos são `.md` puros em uma pasta do usuário ("vault").

O plano completo está em [`PLANO.md`](PLANO.md). O andamento por etapa está em [`TAREFAS_PENDENTES.md`](TAREFAS_PENDENTES.md), as mudanças em [`CHANGELOG.md`](CHANGELOG.md) e as ideias para depois em [`MELHORIAS.md`](MELHORIAS.md).

## Regras de arquitetura

1. **Markdown no disco é a fonte da verdade.** Nenhum motor, cache ou índice pode alterar um `.md` sem ação do usuário.
2. **`packages/core` não conhece Tauri nem React.** Só JavaScript/TypeScript puro + CodeMirror/Milkdown.
3. **A API de plugins não expõe React nem Tauri.** `registerPanel` recebe um `HTMLElement`; acesso a arquivos passa por `api.vault`.
4. **Feature nova nasce no modo fonte.** O modo WYSIWYG recebe depois, ou nunca, se não fizer sentido.
5. **`<CodeMirrorEditor>` cria o `EditorView` uma única vez.** Comunicação por `dispatch`, não por props.
6. **Nunca sobrescrever silenciosamente** um arquivo cujo `mtime` mudou fora do app: detectar e oferecer "manter ambos".
7. **Chaves e tokens só no keychain do SO.** Nunca em arquivo de configuração.

As fronteiras entre pacotes (regras 2 e 3) são verificadas pelo ESLint (`no-restricted-imports` em `eslint.config.js`): um import proibido faz `pnpm lint` falhar.

## Estrutura

```
apps/
  demo/          página Vite de demonstração do editor (etapa 1)
packages/
  core/          editor CodeMirror 6 + lang-markdown (GFM), comandos e atalhos; sem React/Tauri
  themes/        tokens CSS (packages/themes/src/tokens.css) e temas
  ui/            componentes React compartilhados, como <CodeMirrorEditor>
  vault/         acesso ao vault (VaultProvider); guarda de caminhos desde a etapa 0
```

Os pacotes internos são consumidos como código-fonte TypeScript (sem etapa de build por pacote).

## Desenvolvimento

Requisitos: Node.js ≥ 22 e pnpm 12 (a versão exata está em `packageManager` no `package.json`).

```sh
pnpm install          # instala as dependências do monorepo
pnpm lint             # ESLint + prettier --check
pnpm typecheck        # tsc --noEmit em cada pacote
pnpm test             # Vitest em todos os pacotes
pnpm test:coverage    # Vitest com cobertura (relatório em build/coverage)
pnpm format           # prettier --write
pnpm dev              # demo do editor em http://localhost:5173 (o mesmo que pnpm dev:demo)
pnpm dev:demo         # demo do editor; continua disponível quando `dev` passar ao app desktop
```

### Demo do editor

`pnpm dev` (ou `pnpm dev:demo`) abre a demo em <http://localhost:5173>. Atalhos: `Mod-B` alterna negrito (`**…**`), `Mod-I` alterna itálico (`*…*`) e `Mod-K` insere um link (`[texto](url)`, com `url` selecionado). `Mod` é Cmd no macOS e Ctrl no Windows/Linux. Parâmetros de URL:

- `?doc=fixture` abre o documento de exemplo do live preview (`packages/core/test/fixtures/live-preview.md`);
- `?doc=large` gera um documento de 10.000 linhas para medir desempenho.

O CI (`.github/workflows/ci.yml`) roda lint e typecheck no Ubuntu e os testes no Ubuntu, Windows e macOS.

## Licença

[MIT](LICENSE) © 2026 Rafael Brauner
