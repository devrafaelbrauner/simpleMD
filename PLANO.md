# PLANO.md — simpleMD

> Plano de implementação gerado por `/planejar` em 2026-10-06.
> Fonte da verdade para `/construir`. Cada etapa concluída é registrada em `CHANGELOG.md`; o que ficar de fora vai para `MELHORIAS.md` ou `TAREFAS_PENDENTES.md`.

---

## 1. Visão

**simpleMD** é um editor de markdown open source (MIT), extensível por plugins e temas, em que o **markdown fica visível** (modelo Obsidian / VSCodium), com renderização inline e um modo WYSIWYG opcional. Os arquivos são `.md` puros em uma pasta do usuário ("vault"), sincronizados por serviços de nuvem já existentes (iCloud, Google Drive, OneDrive).

Plataformas, nesta ordem: **desktop (Windows e macOS) → web (PWA) → Android**.

### Funcionalidades

| Área | O que entra |
|---|---|
| Edição | CodeMirror 6, markdown visível com live preview; modo WYSIWYG (Milkdown) alternável |
| Vault | Pasta local; explorador de arquivos; abas; busca; autosave |
| Extensão | Plugins em runtime (`manifest.json` + `main.js`); temas por tokens CSS; editor visual de temas |
| Fontes | Seleção de família/tamanho/ligaduras; fontes mono embutidas (JetBrains Mono, Fira Code, Cascadia Code) |
| Conteúdo rico | Mermaid, tabelas, KaTeX (fórmulas), plugin `calc` (`=2+3` → `5`) |
| Autocomplete | Ligável/desligável; palavras do documento, snippets, links `[[` para notas do vault |
| Metadados | Front matter YAML: parse, validação, painel de propriedades; TOC do documento; catálogo do vault por título/tags/data |
| IA | Interface `AIProvider` com adaptadores OpenAI, Anthropic e Ollama (local); chat lateral; comandos sobre seleção; chaves no keychain do SO |
| Export | `.md` limpo, HTML, PDF (WebView), e via **Pandoc embutido**: DOCX, ODT, EPUB, LaTeX, PDF |
| Sync | Desktop: pasta sincronizada pelo cliente de nuvem. Web/Android: Google Drive e OneDrive (OAuth PKCE) |

### Fora do escopo (→ `MELHORIAS.md`)

- iOS (viável com Tauri 2; exige Apple Developer e Mac para build)
- Colaboração em tempo real (CRDT / Yjs)
- Marketplace de plugins e assinatura de plugins de terceiros
- Sync próprio (servidor na Hetzner) — alternativa futura ao iCloud no Android
- Sandbox de plugins em iframe/worker
- Pandoc em web/Android

---

## 2. Decisões de arquitetura

| # | Decisão | Escolha | Alternativas descartadas | Por quê |
|---|---|---|---|---|
| 1 | Casca multiplataforma | **Tauri 2** | Electron + Capacitor; Flutter | Um projeto para desktop + Android; binário leve; front 100% TS; Rust limitado a 3–4 comandos cobertos por plugins oficiais |
| 2 | Motor do editor | **CodeMirror 6** (`@codemirror/lang-markdown` + Lezer) | Milkdown/Tiptap como motor principal; Monaco | Markdown visível com decorações inline; cada feature é uma extensão, o que vira o sistema de plugins |
| 3 | Plugins e temas | Monorepo pnpm; plugins em runtime com API estreita; temas em `theme.json` por tokens CSS | Plugins compilados junto com o app | Instalar plugin sem recompilar; temas editáveis ao vivo |
| 4 | Provedores de IA | Interface `AIProvider` própria + adaptadores OpenAI, Anthropic, Ollama | Vercel AI SDK | Necessidade mínima (`chat`, `complete`, `listModels`); cada adaptador ~100 linhas; Ollama = provedor padrão para testes sem custo |
| 5 | WYSIWYG | **Milkdown como segundo motor**, após a v0.1; markdown no disco é a fonte da verdade | Estender o live preview até esconder toda a sintaxe; Tiptap | WYSIWYG real sem quebrar o modo fonte; API de plugins prevê o slot desde a etapa 6 |
| 6 | Pandoc | **Embutido como sidecar do Tauri**, um binário por plataforma, baixado no CI com checksum | Pandoc externo; biblioteca JS `docx` | Funciona sem passo extra do usuário; comportamento idêntico em qualquer máquina; +100–150 MB aceitos |
| 7 | UI | **React 19 + TypeScript + Vite + Tailwind + shadcn/ui**; estado com Zustand; virtualização com `@tanstack/react-virtual` | Svelte 5; SolidJS | Alinhado com o roteiro de estudos; maior ecossistema e assistência de IA; bundle não importa em app desktop |
| 8 | Licença | **MIT** | GPL-3 | Mais simples para forks e contribuições; mesma do CodeMirror, Milkdown, React, Tauri. Pandoc (GPL) roda como processo separado, com licença e link do código-fonte no instalador |

### Regras de arquitetura (vão para o `README.md`)

1. **Markdown no disco é a fonte da verdade.** Nenhum motor, cache ou índice pode alterar um `.md` sem ação do usuário.
2. **`packages/core` não conhece Tauri nem React.** Só JavaScript/TypeScript puro + CodeMirror/Milkdown.
3. **A API de plugins não expõe React nem Tauri.** `registerPanel` recebe um `HTMLElement`; acesso a arquivos passa por `api.vault`.
4. **Feature nova nasce no modo fonte.** O modo WYSIWYG recebe depois, ou nunca, se não fizer sentido.
5. **`<CodeMirrorEditor>` cria o `EditorView` uma única vez.** Comunicação por `dispatch`, não por props.
6. **Nunca sobrescrever silenciosamente** um arquivo cujo `mtime` mudou fora do app: detectar e oferecer "manter ambos".
7. **Chaves e tokens só no keychain do SO.** Nunca em arquivo de configuração.

---

## 3. Estrutura do repositório

```
simpleMD/
├── apps/
│   ├── desktop/                  # Tauri 2 + Vite + React
│   │   ├── src/                  # UI React do app
│   │   └── src-tauri/
│   │       ├── src/              # comandos Rust (fs, keychain, pandoc)
│   │       ├── binaries/         # sidecars Pandoc (gitignored, baixados no CI)
│   │       ├── capabilities/     # permissões Tauri por janela
│   │       └── tauri.conf.json
│   └── web/                      # PWA; mesma UI, providers de nuvem
├── packages/
│   ├── core/                     # editor CodeMirror, live preview, Milkdown, parser YAML, export
│   ├── plugin-api/               # tipos públicos + runtime de carregamento de plugins
│   ├── themes/                   # tokens, temas padrão, editor de temas
│   ├── vault/                    # VaultProvider + LocalFs / GoogleDrive / OneDrive
│   ├── ai/                       # AIProvider + adaptadores OpenAI / Anthropic / Ollama
│   └── ui/                       # componentes React compartilhados (shadcn/ui)
├── plugins-examples/
│   ├── hello-world/
│   ├── calc/
│   └── word-count/
├── docs/                         # guia de plugins, guia de temas, arquitetura
├── .github/workflows/            # CI: lint, test, build desktop, download Pandoc
├── CHANGELOG.md
├── MELHORIAS.md
├── TAREFAS_PENDENTES.md
├── PLANO.md                      # este arquivo
├── README.md
├── LICENSE                       # MIT
├── package.json                  # inclui "pandoc": { "version": "x.y.z" }
└── pnpm-workspace.yaml
```

### Dentro do vault do usuário

```
MeuVault/
├── .simplemd/
│   ├── config.json               # preferências do vault
│   ├── themes/<nome>/theme.json
│   └── plugins/<id>/manifest.json + main.js
└── *.md
```

---

## 4. Contratos principais

### 4.1 API de plugins (v1)

```ts
// packages/plugin-api/src/types.ts
interface PluginManifest {
  id: string;            // "com.exemplo.calc"
  name: string;
  version: string;       // semver
  minAppVersion: string;
  main: string;          // "main.js"
  description?: string;
}

interface PluginAPI {
  registerCommand(id: string, cmd: { name: string; hotkey?: string; run(): void }): void;
  registerEditorExtension(ext: { source?: CMExtension; wysiwyg?: MilkdownPlugin }): void;
  registerPanel(id: string, panel: { title: string; render(el: HTMLElement): void }): void;
  registerCompletionSource(src: CompletionSource): void;
  on(evt: 'file:open' | 'file:save' | 'vault:change', handler: (e) => void): Unsubscribe;
  vault: { read(path): Promise<string>; write(path, text): Promise<void>; list(): Promise<string[]> };
  settings: { get<T>(key): T | undefined; set<T>(key, value: T): Promise<void> };
  ui: { notify(msg: string, level?: 'info' | 'warn' | 'error'): void };
}

// main.js do plugin
export default function activate(api: PluginAPI): void | (() => void);
```

Um plugin que preenche só `source` continua válido quando o modo WYSIWYG existir.

### 4.2 Tema

```json
{
  "name": "Meu tema",
  "base": "dark",
  "tokens": {
    "--bg": "#0f1115",
    "--fg": "#d6dae0",
    "--accent": "#7aa2f7",
    "--font-mono": "JetBrains Mono",
    "--font-size": "15px"
  },
  "css": "opcional.css"
}
```

### 4.3 VaultProvider

```ts
interface VaultProvider {
  open(): Promise<VaultHandle>;
  list(handle, dir?): Promise<Entry[]>;
  read(handle, path): Promise<{ text: string; mtime: number }>;
  write(handle, path, text, expectedMtime?): Promise<{ mtime: number }>; // falha se mtime mudou
  watch?(handle, cb): Unsubscribe;
}
```

### 4.4 AIProvider

```ts
interface AIProvider {
  id: 'openai' | 'anthropic' | 'ollama';
  listModels(): Promise<string[]>;
  chat(messages: Message[], opts: { model: string; stream?: boolean }): AsyncIterable<string>;
}
```

---

## 5. Critérios de aceite globais

1. Abrir uma pasta com `.md`, editar, salvar e ver o arquivo mudar no disco, em Windows e macOS.
2. O plugin `hello-world`, instalado só com `manifest.json` + `main.js`, adiciona um comando e uma decoração sem recompilar o app.
3. Um tema criado no editor de temas é salvo como arquivo e aplicado ao vivo.
4. Mermaid, tabelas, KaTeX e `=cálculo` renderizam inline; export PDF preserva a renderização.
5. Autocomplete liga/desliga nas configurações e o estado persiste.
6. Painel de índice lista arquivos do vault por título/tags do YAML e mostra o TOC do arquivo aberto.
7. IA responde a um comando sobre texto selecionado nos três provedores; nenhuma chave em texto plano.
8. Web (PWA) e Android abrem um vault via Google Drive.
9. Alternar fonte ↔ WYSIWYG não altera nenhum byte do `.md` (round-trip idêntico).
10. Instalador em máquina limpa, sem Pandoc instalado, exporta DOCX que abre no Word/LibreOffice.
11. `CHANGELOG.md`, `MELHORIAS.md`, `TAREFAS_PENDENTES.md` atualizados a cada etapa; `/seguranca` aprovado antes de cada release.

---

## 6. Plano de execução

Cada etapa cabe em uma sessão de `/construir`, termina com commit e com os três arquivos de controle atualizados, e é seguida de `/verificar`.

### Fase A — Fundação (v0.1 desktop, modo fonte)

| # | Etapa | Arquivos | Depende de | Como validar |
|---|---|---|---|---|
| 0 | Confirmar com `gh repo view` que `simpleMD` não existe; criar repo (MIT); monorepo pnpm; `CHANGELOG.md`, `MELHORIAS.md`, `TAREFAS_PENDENTES.md`, `PLANO.md`, `README.md`, `.gitignore`, `LICENSE`; ESLint + Prettier + Vitest; CI básico (lint + test) | raiz, `.github/workflows/ci.yml` | — | repo acessível; `pnpm install && pnpm lint && pnpm test` passam no CI |
| 1 | Núcleo do editor: `packages/core` com CodeMirror 6 + `lang-markdown`; componente `<CodeMirrorEditor>` em `packages/ui`; página Vite de demonstração | `packages/core`, `packages/ui` | 0 | `pnpm dev` abre a demo; digitar markdown funciona; atalhos básicos (negrito, itálico, link) |
| 2 | Casca desktop Tauri 2: janela, `LocalFsProvider` (abrir pasta, listar, ler, salvar com checagem de `mtime`), explorador de arquivos virtualizado, abas, autosave, estado com Zustand | `apps/desktop`, `packages/vault` | 1 | critério 1 em Windows e macOS; editar o arquivo fora do app dispara aviso de conflito |
| 3 | Live preview: decorações para cabeçalhos, ênfase, links, listas, blocos de código, tabelas; cursor sobre o elemento revela o markdown | `packages/core` | 1 | arquivo de teste com todos os elementos renderiza; testes de decoração no Vitest |
| 4 | Sistema de temas: tokens CSS, temas claro/escuro padrão, seletor de fontes (família, tamanho, ligaduras), fontes mono embutidas | `packages/themes`, `packages/ui` | 2 | trocar tema/fonte reflete sem reload; preferência persiste em `.simplemd/config.json` |
| 5 | Editor de temas visual: formulário gera `theme.json`, preview ao vivo, salvar/exportar/importar | `packages/themes` | 4 | critério 3 |
| 6 | Sistema de plugins: loader de `manifest.json` + `main.js` a partir de `.simplemd/plugins/`, API v1 **com o slot `{ source?, wysiwyg? }`**, isolamento (plugin não acessa Tauri nem `window`), tela de gerenciamento com aviso de segurança ao ativar | `packages/plugin-api`, `plugins-examples/hello-world`, `docs/plugins.md` | 2, 3 | critério 2; o tipo da API documenta `wysiwyg` antes de existir |
| 7 | Mermaid, KaTeX e plugin `calc` implementados **como plugins internos usando a API v1** (prova de suficiência da API) | `packages/core`, `plugins-examples/calc` | 6 | diagrama, fórmula e `=2+3` renderizam inline |
| 8 | Autocomplete configurável: `@codemirror/autocomplete`; fontes: palavras do documento, snippets, `[[` para notas do vault; toggle on/off e gatilhos nas configurações | `packages/core` | 2 | critério 5 |
| 9 | Front matter YAML: parse e validação, painel de propriedades, TOC do documento, catálogo do vault por título/tags/data com busca; índice persistido em `.simplemd/index.json` | `packages/core`, `packages/vault`, `packages/ui` | 2, 3 | critério 6; catálogo com 2.000 notas de teste abre em < 1 s |
| 10 | Export básico: `.md` limpo (sem front matter opcional), HTML, PDF via impressão do WebView com CSS de impressão | `packages/core/export`, `apps/desktop` | 7 | critério 4 em WebView2 e WKWebView |
| 11 | IA: `AIProvider` + adaptadores OpenAI, Anthropic, Ollama (streaming nos três); seletor de provedor/modelo; chave no keychain (`tauri-plugin-stronghold` ou `keyring`); chat lateral; comandos sobre seleção (reescrever, resumir, continuar, traduzir) | `packages/ai`, `apps/desktop` | 6 | critério 7; testes de contrato de cada adaptador contra fixtures gravadas |
| 12 | **`/seguranca`**: chaves, permissões Tauri (`capabilities`), plugins como código de terceiros, dependências, SAST | — | 11 | relatório sem achados bloqueantes |
| 13 | **Release desktop v0.1** (só modo fonte): build assinado Windows e macOS, GitHub Releases, auto-update opcional | `apps/desktop`, `.github/workflows/release.yml` | 12 | critérios 1–7 em máquina limpa |

**Paralelismo na Fase A:** 4+5 ∥ 6; 8 ∥ 9; 10 ∥ 11.
**Sequência obrigatória:** 0 → 1 → 2; 6 bloqueia 7 e 11; 12 bloqueia 13.

### Fase B — Expansão (v0.2)

| # | Etapa | Arquivos | Depende de | Como validar |
|---|---|---|---|---|
| 14 | Export Pandoc embutido: sidecar por plataforma (`externalBin`), script de download com checksum SHA-256 no CI, versão fixada em `package.json`, menu DOCX/ODT/EPUB/LaTeX, PDF via Pandoc como alternativa, licença do Pandoc no instalador, versão exibida em "Sobre" | `src-tauri/tauri.conf.json`, `src-tauri/binaries/`, `.github/workflows/`, `packages/core/export/` | 10, 13 | critério 10; checksum errado quebra o build; sidecar assinado no macOS |
| 15 | Modo WYSIWYG: Milkdown em `packages/core`; toggle fonte ↔ WYSIWYG preservando posição do cursor; mesmos tokens de tema; Mermaid/KaTeX/tabelas no Milkdown | `packages/core`, `packages/themes` | 7, 13 | critério 9 com corpus de arquivos reais; teste automático de round-trip |
| 16 | Plugins de exemplo nos dois motores (`hello-world`, `calc`) + documentação de como um plugin suporta ambos | `plugins-examples`, `docs/plugins.md` | 15 | os dois exemplos funcionam nos dois modos |
| 17 | Web (PWA): `apps/web` reaproveita `packages/*`; `GoogleDriveProvider` e `OneDriveProvider` com OAuth PKCE (sem segredo no cliente); export restrito a `.md`/HTML/PDF | `apps/web`, `packages/vault` | 13 | critério 8 no navegador |
| 18 | Android: target mobile do Tauri 2; UI de toque, teclado virtual, barra de ferramentas markdown; providers da etapa 17 | `apps/desktop/src-tauri` (target android) | 17 | critério 8 no Android; abrir/editar/salvar |
| 19 | **`/seguranca`** (OAuth, escopos Drive/OneDrive, sidecar) + **release v0.2** desktop/web/Android | — | 14, 16, 18 | relatório aprovado |

**Paralelismo na Fase B:** 14 ∥ 15 ∥ 17 (independentes após a 13). Se o Milkdown travar, web/Android seguem.

### Pontos de decisão (consultar o usuário antes de prosseguir)

| Antes da etapa | Decisão |
|---|---|
| 6 | Aprovar a API v1 de plugins (mudar depois quebra plugins) |
| 13 | Assinatura de código: certificado Windows (custo) e Apple Developer para notarização |
| 15 | Confirmar se vale manter dois motores com a v0.1 na mão |

---

## 7. Riscos e contingências

| Risco | Impacto | Contingência |
|---|---|---|
| Live preview no CodeMirror é a parte mais trabalhosa | Etapa 3 estourar o tempo | Começar com cabeçalhos/ênfase/links; o resto incremental. Referências: `ixora`, plugins do Obsidian |
| Plugins são código de terceiros | Plugin lê o vault inteiro | API estreita, sem `eval`, chaves no keychain, aviso ao ativar; sandbox em `MELHORIAS.md` |
| Round-trip markdown → Milkdown → markdown altera formatação | Diffs espúrios no sync | Teste de round-trip com corpus real; bloco que não sobrevive trava a edição WYSIWYG e avisa |
| Dois motores dobram o custo de cada feature | Velocidade cai após a 15 | Regra 4: feature nasce no modo fonte |
| Tauri mobile menos maduro | Etapa 18 com bugs de WebView/teclado | Desktop first absorve o risco; plano B: Capacitor reaproveitando `packages/*` |
| iCloud sem API fora da Apple | Android sem iCloud | Documentar; Google Drive/OneDrive; sync próprio em `MELHORIAS.md` |
| Conflitos de sync entre dispositivos | Perda de dados | Regra 6: checagem de `mtime` e "manter ambos" |
| PDF via WebView varia por SO | PDF diferente no Windows e macOS | CSS de impressão testado nos dois; Pandoc como alternativa a partir da 14 |
| Sidecar Pandoc precisa de assinatura no macOS | Gatekeeper bloqueia | Incluir `externalBin` na assinatura; testar em Mac limpo |
| Pandoc 3.x muda flags entre versões | Export quebra ao atualizar | Versão fixada + teste que converte `.md` de referência contra fixture |
| APIs de IA mudam | Adaptador quebra | Teste de contrato por adaptador; versão da API fixada |
| Dev solo com pouco tempo | Projeto parar no meio | Ordem das etapas garante que a v0.1 (0–13) já é um editor usável |

---

## 8. Convenções de trabalho

- **Fluxo por etapa:** `/construir etapa N` → `/verificar` → (`/corrigir` se houver achados) → próxima etapa.
- **Commits:** um por etapa concluída, no mínimo; mensagem em português, prefixo `feat:`, `fix:`, `chore:`, `docs:`.
- **`CHANGELOG.md`:** formato Keep a Changelog; seção `[Não lançado]` recebe cada etapa.
- **`TAREFAS_PENDENTES.md`:** espelha a tabela da seção 6 com checkboxes; marcada ao fim de cada etapa.
- **`MELHORIAS.md`:** recebe tudo da seção 1 "Fora do escopo" já na etapa 0, mais o que surgir.
- **Testes:** Vitest em `packages/*`; cada etapa adiciona pelo menos um teste do que entregou.
- **Segurança:** `/seguranca` obrigatório antes de toda release (etapas 12 e 19).

---

## 9. Próximo passo

```
/construir etapa 0 do plano: criar repositório simpleMD no GitHub (MIT), monorepo pnpm com React/TS/Vite e arquivos de controle (CHANGELOG, MELHORIAS, TAREFAS_PENDENTES, PLANO)
```
