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
  desktop/       app Tauri 2 (src/), harness de testes no Chromium (harness/) e casca Rust (src-tauri/)
packages/
  core/          editor CodeMirror 6 + lang-markdown (GFM), comandos e atalhos; sem React/Tauri
  themes/        tokens CSS (packages/themes/src/tokens.css) e temas
  ui/            componentes React compartilhados, como <CodeMirrorEditor>
  vault/         VaultProvider + LocalFsProvider sobre uma porta de arquivos injetável (Tauri,
                 Node nos testes, memória no harness); guarda de caminhos, conflitos, EOL/BOM
scripts/         check-tauri-security.mjs e assert-no-harness.mjs (portões do CI)
```

Os pacotes internos são consumidos como código-fonte TypeScript (sem etapa de build por pacote).

## Desenvolvimento

Requisitos: Node.js ≥ 22, pnpm 12 (a versão exata está em `packageManager` no `package.json`) e, para o app desktop, Rust ≥ 1.90 com os pré-requisitos do Tauri 2 (Xcode CLT no macOS; WebView2 e MSVC no Windows).

```sh
pnpm install          # instala as dependências do monorepo
pnpm lint             # ESLint + prettier --check
pnpm typecheck        # tsc --noEmit em cada pacote
pnpm test             # Vitest em todos os pacotes
pnpm test:coverage    # Vitest com cobertura (relatório em build/coverage)
pnpm format           # prettier --write
pnpm check:security   # portão estático do Tauri: capabilities sem escopo fixo, sem shell/process, CSP
pnpm dev              # app desktop (tauri dev; o mesmo que pnpm dev:desktop)
pnpm dev:harness      # a mesma interface no navegador, com vault em memória (http://localhost:5174)
pnpm dev:demo         # demo do editor em http://localhost:5173
pnpm tauri build --no-bundle   # binário de release em apps/desktop/src-tauri/target/release/
```

### App desktop

`pnpm dev` abre a janela do simpleMD. "Abrir pasta…" (`Mod-O`) mostra o diálogo nativo; o app só recebe acesso à pasta escolhida (e à `.simplemd/` dentro dela) durante a sessão. Arquivos `.md` aparecem no explorador; clique ou Enter abre uma aba. As alterações são salvas 1 s depois da última tecla, e também ao fechar a aba (`Mod-W`) ou a janela. Se o arquivo mudar fora do app com alterações pendentes, o diálogo de conflito oferece "Manter ambos" (as suas alterações vão para `<nome> (conflito AAAA-MM-DD HH-mm-ss).md`) ou "Recarregar do disco"; nada é sobrescrito sem você ver. No terminal, o app imprime `simplemd:ready <ms>` no primeiro quadro e `simplemd:conflict-shown <ms>` quando o diálogo de conflito aparece.

### Harness de testes (Chromium)

`pnpm dev:harness` serve a interface do desktop com o `LocalFsProvider` real sobre um vault em memória (nunca entra no build do Tauri). Parâmetros: `?vault=FX-SMALL` (ou `FX-EMPTY`, `FX-2000`, `FX-LP`, `FX-DUP`, `FX-LONG`, `FX-10K`, `FX-1MB`, `FX-CFG-BAD`, `FX-CFG-UNK`, `FX-LATIN1`), `&expand=all` e `&persist=1`. O objeto `window.__simplemdHarness` simula mudanças externas (`externalWrite`, `touch`, `remove`), injeta falhas (`fault('write', { error: 'IO' })`), registra as chamadas (`calls()`), troca o resultado do diálogo de pasta (`dialogs.open`), fixa o relógio (`setClock`) e simula o fechamento da janela (`requestWindowClose()`).

### Demo do editor

`pnpm dev` (ou `pnpm dev:demo`) abre a demo em <http://localhost:5173>. Atalhos: `Mod-B` alterna negrito (`**…**`), `Mod-I` alterna itálico (`*…*`) e `Mod-K` insere um link (`[texto](url)`, com `url` selecionado). `Mod` é Cmd no macOS e Ctrl no Windows/Linux. Parâmetros de URL:

- `?doc=fixture` abre o documento de exemplo do live preview (`packages/core/test/fixtures/live-preview.md`);
- `?doc=large` gera um documento de 10.000 linhas para medir desempenho.

O CI (`.github/workflows/ci.yml`) roda lint, typecheck e `check:security` no Ubuntu, os testes no Ubuntu, Windows e macOS (os testes do vault usam pastas temporárias reais em cada sistema) e compila o app Tauri no macOS e no Windows.

## Licença

[MIT](LICENSE) © 2026 Rafael Brauner
