# Tarefas pendentes

Espelho do plano de execução (`PLANO.md` §6). Cada etapa é marcada no commit que a conclui.

## Fase A — Fundação (v0.1 desktop, modo fonte)

- [x] **Etapa 0** — Confirmar com `gh repo view` que `simpleMD` não existe; criar repo (MIT); monorepo pnpm; `CHANGELOG.md`, `MELHORIAS.md`, `TAREFAS_PENDENTES.md`, `PLANO.md`, `README.md`, `.gitignore`, `LICENSE`; ESLint + Prettier + Vitest; CI básico (lint + test)
  - Arquivos: raiz, `.github/workflows/ci.yml` · Depende de: — · Validar: repo acessível; `pnpm install && pnpm lint && pnpm test` passam no CI
- [x] **Etapa 1** — Núcleo do editor: `packages/core` com CodeMirror 6 + `lang-markdown`; componente `<CodeMirrorEditor>` em `packages/ui`; página Vite de demonstração
  - Arquivos: `packages/core`, `packages/ui` · Depende de: 0 · Validar: `pnpm dev` abre a demo; digitar markdown funciona; atalhos básicos (negrito, itálico, link)
- [x] **Etapa 2** — Casca desktop Tauri 2: janela, `LocalFsProvider` (abrir pasta, listar, ler, salvar com checagem de `mtime`), explorador de arquivos virtualizado, abas, autosave, estado com Zustand
  - Arquivos: `apps/desktop`, `packages/vault` · Depende de: 1 · Validar: critério 1 em Windows e macOS; editar o arquivo fora do app dispara aviso de conflito
  - [ ] **Em aberto (AC-2.22):** critério 1 em Windows interativo: NÃO TESTADO nesta fase (só build + testes do vault no runner Windows do CI). Fechar antes da etapa 13.
  - [ ] **Em aberto (TA-3):** a porta de produção `TauriFsPort` (`apps/desktop/src/platform/tauri/`) não roda em nenhum teste: mapa de erros do Windows (2/3/5/80/183), `join` com `sep()` e o caminho só-criação não têm evidência. Criar testes com `vi.mock('@tauri-apps/plugin-fs')` antes da etapa 13.
  - [ ] **Em aberto (EC F-12):** V-MAC-1 (negação de pastas ocultas como `.git/` pelo escopo do Tauri) e V-MAC-2 (console sem violações de CSP) só podem ser verificados num build com devtools; NFR-7 (mediana de 5 partidas a frio) não foi medido como especificado.
- [x] **Etapa 3** — Live preview: decorações para cabeçalhos, ênfase, links, listas, blocos de código, tabelas; cursor sobre o elemento revela o markdown
  - Arquivos: `packages/core` · Depende de: 1 · Validar: arquivo de teste com todos os elementos renderiza; testes de decoração no Vitest
  - [x] **Fechado (AC-3.11):** axe na demo com a fixture nos dois temas embutidos — 0 violações (QA da fase 4, rodada 2, em `66159f5`: AX-2 claro/escuro). A correção de `scrollable-region-focusable` (a11y F-1) entrou no commit da correção da QA.
- [x] **Etapa 4** — Sistema de temas: tokens CSS, temas claro/escuro padrão, seletor de fontes (família, tamanho, ligaduras), fontes mono embutidas
  - Arquivos: `packages/themes`, `packages/ui` · Depende de: 2 · Validar: trocar tema/fonte reflete sem reload; preferência persiste em `.simplemd/config.json`
  - [x] **Fechado (QA, fase 4):** AC-4.4–4.8 e AC-4.11 em Playwright, AC-4.15 e AC-3.11 com axe nos dois temas e AC-4.10 no app real (macOS) — verificados pela QA da fase 4, rodada 2, em `66159f5`.
- [x] **Etapa 5** — Editor de temas visual: formulário gera `theme.json`, preview ao vivo, salvar/exportar/importar
  - Arquivos: `packages/themes` · Depende de: 4 · Validar: critério 3
  - [x] **Fechado (QA, fase 4):** AC-5.1, 5.2, 5.4, 5.7–5.9 e 5.12 em Playwright no harness, AC-5.13 com axe e AC-5.5 (critério 3) no app real (macOS) — verificados pela QA da fase 4, rodada 2, em `66159f5`.
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

- [ ] Antes da etapa 6 (plugins): rever os achados CR-09 (escopo de arquivos), CR-11 (preferências), CR-13 (memória do vault), RR-01 (explorador após remoção em conflito), RR-03 (base de escrita por conteúdo) e RR-04 (estado ao esgotar o flush), registrados em `MELHORIAS.md`.
  - [ ] RR-03 → corrigir no commit de pré-requisito C2 (base de conteúdo fornecida pelo chamador), antes de qualquer código da etapa 6.
  - [ ] CR-09 (revogar o escopo da pasta anterior, negar pastas ocultas também no nativo, restringir o diálogo de abrir) → coberto por AS-01/AS-02/AS-03 no commit de pré-requisito C3; recusar `/` e `$HOME` como vault continua em `MELHORIAS.md`.
  - [ ] CR-13 (bytes de todo arquivo lido guardados na sessão) → C2 troca a memória por hashes (registro de versões servidas).
  - CR-11, RR-01 e RR-04 continuam registrados em `MELHORIAS.md`, sem etapa-alvo nesta fase.
- [ ] Pendências não bloqueantes da QA da Fase A (AS-01…AS-09, Secrets F-1…F-7, QR-01…QR-05, R2-N1/R2-N2, DO-1…DO-4) registradas em `MELHORIAS.md` com dono e etapa-alvo; a etapa 12 dá o status final de AS, Secrets e DO.

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

- [x] Antes da etapa 6: aprovar a API v1 de plugins (mudar depois quebra plugins) — aprovada pelo usuário em 2026-10-07 exatamente como PLANO §4.1 (isolamento = API estreita + nenhum global do Tauri + aviso ao ativar; documentado como não sendo sandbox)
- [ ] Antes da etapa 13: assinatura de código — certificado Windows (custo) e Apple Developer para notarização
- [ ] Antes da etapa 15: confirmar se vale manter dois motores com a v0.1 na mão
