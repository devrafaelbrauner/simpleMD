# Changelog

Todas as mudanças relevantes deste projeto são registradas aqui.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Adicionado

- Etapa 4 — sistema de temas por tokens, seletor de fontes e fontes mono embutidas:
  - `packages/themes`: esquema de tema v1 (`{ name, base, tokens, css? }`) com os nomes de tokens da decisão D-1 (`--<grupo>-<nome>`); validador `validateTheme` que nunca lança e aponta o primeiro campo inválido (nome fora do padrão, cor que não é hexadecimal, dimensão sem unidade, valores com `;`, `{`, `}`, `<`, `>`, `\`, comentários, `url(`, `@import` ou `expression(`, teto de 256 KB); serialização determinística (`serializeTheme`: chaves ordenadas, 2 espaços, `\n` final);
  - temas embutidos "simpleMD Claro" (`simplemd-light`, lido de `tokens.css` como texto: os valores existem num único lugar) e "simpleMD Escuro" (`simplemd-dark.json`, só as cores, composto sobre o claro); `resolveTokens` com precedência preferência > tema > base e `applyTheme`, que grava os tokens no `<html>` sem deixar sobras do tema anterior e sem recarregar, dentro de uma janela que desliga as transições durante a troca;
  - fontes JetBrains Mono 2.304, Fira Code 6.2 e Cascadia Code 2407.24 (woff2 Regular e Bold publicados pelos projetos, sem alteração), com o texto da licença OFL-1.1 e a origem/sha256 de cada arquivo em `packages/themes/src/fonts/<família>/`; `fonts.css` só com arquivos locais;
  - preferências por pasta em `<vault>/.simplemd/config.json` (`theme`, `editor.fontFamily`, `editor.fontSize`, `editor.fontLigatures`): gravação com ler-mesclar-gravar 300 ms depois da última mudança (chaves desconhecidas preservadas), restauradas ao abrir a pasta antes de a casca aparecer; teto de leitura de 1 MB; arquivo malformado → padrões, aviso persistente e o arquivo **nunca** é regravado na sessão; sem pasta, as mudanças valem só na sessão;
  - `packages/vault`: `updateJsonFile` (ler-mesclar-gravar com novas tentativas quando outro programa grava no meio) e limites de leitura para `config.json` e `theme.json`;
  - app desktop: engrenagem "Configurações" na barra (também nas boas-vindas) e atalho `Mod-,` abrem o diálogo com "Tema", "Família" (JetBrains Mono, Fira Code, Cascadia Code, Monospace do sistema), "Tamanho (px)" (10–32; 9 vira 10 e 33 vira 32) e "Ligaduras"; tudo vale na hora; linha de persistência mostra onde as preferências vão parar;
  - demo: seletor "Tema" e `?theme=simplemd-dark`;
  - testes Vitest: validador (casos de AC-4.2 em JSON), temas embutidos e fontes, contraste WCAG dos dois temas, precedência, `applyTheme` sem sobras e com a janela de transição, preferências (malformado, campos, mesclagem, corrida), `updateJsonFile`, diálogo de configurações e o controlador de preferências do app.

- Etapa 3 — live preview no editor (`packages/core`, usado sem cópia pela demo e pelo app desktop):
  - títulos ATX h1–h6 sem as marcas `#` e com classe de nível (`cm-md-h1…h6`, tamanhos pelos tokens `--dimension-hN-size`); negrito/itálico (`**`/`__`, `*`/`_`) sem os marcadores; links em linha `[texto](url)` só com o texto, sublinhado e **não clicável**; marcadores `-`/`*`/`+` como `•` (largura de 1 caractere, indentação preservada) e números de listas ordenadas visíveis e atenuados; blocos de código cercados com fundo em todas as linhas, cercas atenuadas e nenhuma decoração de markdown dentro; tabelas GFM de topo como `<table>` (cabeçalho `th scope="col"`, alinhamento da linha `:---`/`:---:`/`---:`, conteúdo só como texto);
  - revelação pelo cursor, só com o editor focado: o nó (ênfase, link), a linha (título, marcador de lista) ou o bloco (código, tabela) sob o cursor ou a seleção volta ao markdown cru; clicar numa tabela renderizada põe o cursor na célula correspondente da fonte;
  - decorações em linha calculadas só nas faixas visíveis (`ViewPlugin`), tabelas como widgets de bloco (`StateField`); funções puras exportadas (`computeInlineDecorations`, `computeBlockDecorations`, `computeLivePreviewDecorations`) e opção `livePreview` em `createMarkdownExtensions` (ligada por padrão); o texto do documento nunca muda;
  - testes Vitest: fixture com todos os elementos, títulos, ênfase, links, listas, blocos de código, widget de tabela (DOM, alinhamento, HTML literal, clique), revelação com e sem foco, varredura de bytes inalterados (estado e `EditorView`), faixas visíveis num documento de 10.000 linhas.

- Etapa 2 — casca desktop, vault local, explorador, abas, autosave e conflitos:
  - `packages/vault`: `VaultProvider` (forma exata do PLANO §4.3) e `LocalFsProvider` sobre uma porta de arquivos injetável (`FsPort`); listagem recursiva só com pastas e `.md` (sem itens ocultos, sem links simbólicos, pastas primeiro, `/` em todo SO); leitura sem perdas (CRLF e BOM incluídos; UTF-8 inválido é recusado); escrita sempre com `expectedMtime` e comparação de conteúdo (`ConflictError` quando o arquivo mudou; toque só de metadados não é conflito); sem `expectedMtime` a escrita só cria; mutex por caminho; guarda de caminhos + recusa de links/junções; codec de fim de linha/BOM; `createWithFreeName` e `conflictCopyCandidate` ("Manter ambos"); portas Node (`@simplemd/vault/node`, testes em pastas reais nos 3 SOs) e em memória (`@simplemd/vault/testing`, testes e harness);
  - `apps/desktop`: app Tauri 2 (janela "simpleMD", 1280×800, mínimo 800×600) com dois comandos Rust — `pick_vault` (diálogo nativo + escopo de fs só para a pasta escolhida e sua `.simplemd/`) e `app_mark` (linhas `simplemd:ready` / `simplemd:conflict-shown`); capability mínima sem `fs:default`, sem escopo estático e sem shell/process/opener; CSP definida; drag-and-drop e protocolo de assets desligados; menu próprio no macOS ("Sair do simpleMD" faz o flush; nenhum item usa Cmd+W);
  - interface (Zustand + `packages/ui`): boas-vindas, explorador virtualizado com `@tanstack/react-virtual` (≤ 60 linhas montadas, teclado ↑↓←→ Home End Enter), abas com indicador de não salvo/erro/conflito, um único `EditorView` com um `EditorState` por aba, autosave 1 s após a última tecla (novas tentativas em erro de E/S), flush ao fechar aba (`Mod-W`) e janela, detecção de mudança externa (observação de arquivos, sondagem de 1 s como alternativa e foco da janela), diálogo de conflito "Manter ambos" / "Recarregar do disco", diálogo "Alterações não salvas" com "Fechar sem salvar" explícito e avisos não bloqueantes;
  - harness de testes no Chromium (`pnpm dev:harness`, `?vault=FX-…`, `window.__simplemdHarness`), fora do build de produção;
  - CI: `pnpm check:security` no job de lint e job `desktop-build` (macOS e Windows) que compila o app Tauri e confirma que o harness não entrou no build;
  - testes Vitest: contrato de tipos, listagem, leitura/escrita/conflitos, travessia de caminhos, CRLF/BOM, cópia de conflito, observação, 200 intercalações sem perda de bytes, store e motor de sincronização, explorador, abas e diálogos.

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

### Alterado

- `PLANO.md` §4.2: o exemplo de tema usa os nomes de tokens da decisão D-1 (`--color-bg`, `--color-fg`, `--color-accent`, `--fontFamily-mono`, `--dimension-font-size`), com uma nota que registra a troca dos nomes originais (`--bg`, `--fg`, `--accent`, `--font-mono`, `--font-size`) e o conjunto obrigatório v1.
