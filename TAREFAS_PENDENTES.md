# Tarefas pendentes

Espelho do plano de execução (`PLANO.md` §6). Cada etapa é marcada no commit que a conclui.

## Fase A — Fundação (v0.1 desktop, modo fonte)

- [x] **Etapa 0** — Confirmar com `gh repo view` que `simpleMD` não existe; criar repo (MIT); monorepo pnpm; `CHANGELOG.md`, `MELHORIAS.md`, `TAREFAS_PENDENTES.md`, `PLANO.md`, `README.md`, `.gitignore`, `LICENSE`; ESLint + Prettier + Vitest; CI básico (lint + test)
  - Arquivos: raiz, `.github/workflows/ci.yml` · Depende de: — · Validar: repo acessível; `pnpm install && pnpm lint && pnpm test` passam no CI
- [ ] **Etapa 1** — Núcleo do editor: `packages/core` com CodeMirror 6 + `lang-markdown`; componente `<CodeMirrorEditor>` em `packages/ui`; página Vite de demonstração
  - Arquivos: `packages/core`, `packages/ui` · Depende de: 0 · Validar: `pnpm dev` abre a demo; digitar markdown funciona; atalhos básicos (negrito, itálico, link)
- [ ] **Etapa 2** — Casca desktop Tauri 2: janela, `LocalFsProvider` (abrir pasta, listar, ler, salvar com checagem de `mtime`), explorador de arquivos virtualizado, abas, autosave, estado com Zustand
  - Arquivos: `apps/desktop`, `packages/vault` · Depende de: 1 · Validar: critério 1 em Windows e macOS; editar o arquivo fora do app dispara aviso de conflito
- [ ] **Etapa 3** — Live preview: decorações para cabeçalhos, ênfase, links, listas, blocos de código, tabelas; cursor sobre o elemento revela o markdown
  - Arquivos: `packages/core` · Depende de: 1 · Validar: arquivo de teste com todos os elementos renderiza; testes de decoração no Vitest
- [ ] **Etapa 4** — Sistema de temas: tokens CSS, temas claro/escuro padrão, seletor de fontes (família, tamanho, ligaduras), fontes mono embutidas
  - Arquivos: `packages/themes`, `packages/ui` · Depende de: 2 · Validar: trocar tema/fonte reflete sem reload; preferência persiste em `.simplemd/config.json`
- [ ] **Etapa 5** — Editor de temas visual: formulário gera `theme.json`, preview ao vivo, salvar/exportar/importar
  - Arquivos: `packages/themes` · Depende de: 4 · Validar: critério 3
- [ ] **Etapa 6** — Sistema de plugins: loader de `manifest.json` + `main.js` a partir de `.simplemd/plugins/`, API v1 **com o slot `{ source?, wysiwyg? }`**, isolamento (plugin não acessa Tauri nem `window`), tela de gerenciamento com aviso de segurança ao ativar
  - Arquivos: `packages/plugin-api`, `plugins-examples/hello-world`, `docs/plugins.md` · Depende de: 2, 3 · Validar: critério 2; o tipo da API documenta `wysiwyg` antes de existir
- [ ] **Etapa 7** — Mermaid, KaTeX e plugin `calc` implementados **como plugins internos usando a API v1** (prova de suficiência da API)
  - Arquivos: `packages/core`, `plugins-examples/calc` · Depende de: 6 · Validar: diagrama, fórmula e `=2+3` renderizam inline
- [ ] **Etapa 8** — Autocomplete configurável: `@codemirror/autocomplete`; fontes: palavras do documento, snippets, `[[` para notas do vault; toggle on/off e gatilhos nas configurações
  - Arquivos: `packages/core` · Depende de: 2 · Validar: critério 5
- [ ] **Etapa 9** — Front matter YAML: parse e validação, painel de propriedades, TOC do documento, catálogo do vault por título/tags/data com busca; índice persistido em `.simplemd/index.json`
  - Arquivos: `packages/core`, `packages/vault`, `packages/ui` · Depende de: 2, 3 · Validar: critério 6; catálogo com 2.000 notas de teste abre em < 1 s
- [ ] **Etapa 10** — Export básico: `.md` limpo (sem front matter opcional), HTML, PDF via impressão do WebView com CSS de impressão
  - Arquivos: `packages/core/export`, `apps/desktop` · Depende de: 7 · Validar: critério 4 em WebView2 e WKWebView
- [ ] **Etapa 11** — IA: `AIProvider` + adaptadores OpenAI, Anthropic, Ollama (streaming nos três); seletor de provedor/modelo; chave no keychain (`tauri-plugin-stronghold` ou `keyring`); chat lateral; comandos sobre seleção (reescrever, resumir, continuar, traduzir)
  - Arquivos: `packages/ai`, `apps/desktop` · Depende de: 6 · Validar: critério 7; testes de contrato de cada adaptador contra fixtures gravadas
- [ ] **Etapa 12** — **`/seguranca`**: chaves, permissões Tauri (`capabilities`), plugins como código de terceiros, dependências, SAST
  - Arquivos: — · Depende de: 11 · Validar: relatório sem achados bloqueantes
- [ ] **Etapa 13** — **Release desktop v0.1** (só modo fonte): build assinado Windows e macOS, GitHub Releases, auto-update opcional
  - Arquivos: `apps/desktop`, `.github/workflows/release.yml` · Depende de: 12 · Validar: critérios 1–7 em máquina limpa

## Fase B — Expansão (v0.2)

- [ ] **Etapa 14** — Export Pandoc embutido: sidecar por plataforma (`externalBin`), script de download com checksum SHA-256 no CI, versão fixada em `package.json`, menu DOCX/ODT/EPUB/LaTeX, PDF via Pandoc como alternativa, licença do Pandoc no instalador, versão exibida em "Sobre"
  - Arquivos: `src-tauri/tauri.conf.json`, `src-tauri/binaries/`, `.github/workflows/`, `packages/core/export/` · Depende de: 10, 13 · Validar: critério 10; checksum errado quebra o build; sidecar assinado no macOS
- [ ] **Etapa 15** — Modo WYSIWYG: Milkdown em `packages/core`; toggle fonte ↔ WYSIWYG preservando posição do cursor; mesmos tokens de tema; Mermaid/KaTeX/tabelas no Milkdown
  - Arquivos: `packages/core`, `packages/themes` · Depende de: 7, 13 · Validar: critério 9 com corpus de arquivos reais; teste automático de round-trip
- [ ] **Etapa 16** — Plugins de exemplo nos dois motores (`hello-world`, `calc`) + documentação de como um plugin suporta ambos
  - Arquivos: `plugins-examples`, `docs/plugins.md` · Depende de: 15 · Validar: os dois exemplos funcionam nos dois modos
- [ ] **Etapa 17** — Web (PWA): `apps/web` reaproveita `packages/*`; `GoogleDriveProvider` e `OneDriveProvider` com OAuth PKCE (sem segredo no cliente); export restrito a `.md`/HTML/PDF
  - Arquivos: `apps/web`, `packages/vault` · Depende de: 13 · Validar: critério 8 no navegador
- [ ] **Etapa 18** — Android: target mobile do Tauri 2; UI de toque, teclado virtual, barra de ferramentas markdown; providers da etapa 17
  - Arquivos: `apps/desktop/src-tauri` (target android) · Depende de: 17 · Validar: critério 8 no Android; abrir/editar/salvar
- [ ] **Etapa 19** — **`/seguranca`** (OAuth, escopos Drive/OneDrive, sidecar) + **release v0.2** desktop/web/Android
  - Arquivos: — · Depende de: 14, 16, 18 · Validar: relatório aprovado

## Pontos de decisão (consultar o usuário antes de prosseguir)

- [ ] Antes da etapa 6: aprovar a API v1 de plugins (mudar depois quebra plugins)
- [ ] Antes da etapa 13: assinatura de código — certificado Windows (custo) e Apple Developer para notarização
- [ ] Antes da etapa 15: confirmar se vale manter dois motores com a v0.1 na mão
