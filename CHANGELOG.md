# Changelog

Todas as mudanças relevantes deste projeto são registradas aqui.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Adicionado

- Etapa 6 — sistema de plugins com a API v1 (exatamente PLANO §4.1), paleta de comandos, painel lateral e gerenciador com aviso de segurança:
  - `packages/plugin-api`: tipos da API v1 (`PluginManifest`, `PluginAPI` com os 8 membros, eventos `file:open`/`file:save`/`vault:change`, níveis `info`/`warn`/`error`, slot `{ source?, wysiwyg? }` — `wysiwyg` reservado para o modo WYSIWYG, aceito e ignorado hoje) e o runtime: descoberta e validação de manifestos (`main.js` nunca lido nem executado se o manifesto for inválido; limites de 64 KB e 5 MB; `minAppVersion`), carregador que hasheia os bytes lidos UMA vez e executa uma transformação em memória desses mesmos bytes por `blob:` (módulos do host `@codemirror/state|view|language|autocomplete` resolvidos para as instâncias do app; qualquer outro import recusado), instância da API congelada por plugin, registro de comandos e atalhos com conflito contra os embutidos e os keymaps do CodeMirror, painéis com elemento persistente, eventos, configurações em `.simplemd/plugins/<id>/data.json`, `api.vault` com base de conteúdo (nunca sobrescreve o que o plugin não leu), ciclo de vida (desligar chama o descarte uma vez e remove tudo; religar sem reiniciar; trocar de pasta descarta antes de carregar) e isolamento de falhas (um aviso por plugin e tipo);
  - aprovação por dispositivo, fora da pasta (`plugin-approvals.json` nos dados do app; comandos Rust `plugin_approvals_get`, `plugin_approval_set`, `plugin_enabled_set`, `plugin_approval_clear`, sempre da pasta ativa): código novo ou alterado (`Alterado — confirme de novo`) só roda depois do aviso "Ativar um plugin de terceiros?" (M1–M8 literais, foco inicial em "Cancelar", Esc = Cancelar);
  - editor: `EditorHost` no core com 4 compartimentos (extensões de plugin, sugestões, atalhos globais, receptor de exceções); contribuições entram por reconfiguração, sem recriar o `EditorView`;
  - interface: paleta de comandos (`Mod-Shift-P`, botão "Comandos"; busca sem acento/caixa), painel lateral (`Mod-Shift-L`, botão "Painel lateral"), Configurações com abas "Aparência" e "Plugins" e faixa de status fixa com a linha de persistência e uma região viva local, gerenciador de plugins, interruptor `role=switch`, avisos de nível "aviso";
  - segurança: CSP com exatamente uma fonte nova em `script-src` (`blob:`) em `csp` e `devCsp`; janela principal criada com bloqueio nativo de navegação para fora do app, de janelas novas e de downloads; `check:security` confere a CSP, o inventário de 16 comandos e os guardas;
  - `plugins-examples/hello-world` (comando "Dizer olá" com `Mod-Shift-H` e decoração `cm-hello-world`) e `docs/plugins.md` (API v1, slot `wysiwyg`, módulos do host e nomes de nós do Lezer como contrato v1, ciclo de vida, configurações, atalhos, regras de gravação, compatibilidade e postura de segurança honesta: não é sandbox);
  - harness: vaults `FX-PLUG-HELLO` e `FX-PLUG-PROBE` (plugin sonda do AC-6.27, só de teste), `plugins.install/editMain` e aprovações falsas (`approvals.clear/list`), com marcadores barrados no build de produção;
  - testes: tipos da API (`expectTypeOf`), manifestos inválidos sem leitura do `main.js`, carregador, consentimento e hash, API congelada, comandos/atalhos/painéis/eventos/descarte, falhas isoladas, troca de pasta, `EditorHost` (5 ciclos, 1 `EditorView`), `api.vault`, `data.json`, eventos do app; Rust: armazém de aprovações e guarda de navegação.

- Etapa 5 — editor visual de temas com prévia ao vivo, salvar, exportar e importar:
  - "Editor de temas…" (nas Configurações) abre o formulário com os 11 tokens obrigatórios (8 cores com campo hexadecimal e seletor nativo, fonte da interface — com "Interface do sistema" —, fonte do editor e tamanho 10–32), nome e base (claro/escuro), preenchido a partir de "Começar de"; temas embutidos nunca são alterados;
  - prévia ao vivo restrita ao próprio contêiner (um editor somente leitura com títulos, ênfase, link, lista, código e tabela, mais uma amostra da barra lateral e da seleção): o resto do app só muda ao salvar; valores inválidos mostram o erro no campo e a prévia mantém o último valor válido;
  - "Salvar como novo tema" grava `<pasta>/.simplemd/themes/<slug>/theme.json` (chaves ordenadas, 2 espaços, `\n` final, nunca com `css`), sem sobrescrever (`<slug>-2`, `<slug>-3`…), ativa o tema na hora e o registra em `config.json`;
  - "Exportar tema…" grava o tema selecionado num arquivo escolhido no diálogo do sistema: um tema da pasta sai com os mesmos bytes do arquivo salvo; um embutido, com todos os seus tokens;
  - "Importar tema…" valida o arquivo (até 256 KB, recusado antes da leitura se for maior): um erro nomeia o primeiro campo inválido e nada é gravado; um tema válido é copiado para a pasta (mesma regra de nomes) e aparece no seletor sem ser ativado; o campo `css` é preservado, mas nunca carregado;
  - `packages/themes`: `generateThemeJson`, `slugify`, `saveTheme` (sobre `createWithFreeName`, ids dos embutidos reservados), `listUserThemes`, `importTheme`, `exportThemeBytes`; o validador aceita um BOM inicial;
  - app desktop: plugin de diálogo no JS (`@tauri-apps/plugin-dialog`) e permissões `dialog:allow-open`, `dialog:allow-save` e `fs:allow-stat` — cada diálogo libera só o arquivo escolhido; harness com download no lugar do diálogo de salvar e `<input type="file">` (`set-import-input`) no lugar do de abrir, mais arquivos de exemplo em `apps/desktop/harness/fixtures/themes/`;
  - testes Vitest: gerador contra um `theme.json` de referência, slug e colisões, temas embutidos intocados, listagem, importação (inválidos sem nenhuma chamada ao vault, 257 KB, `css`), exportação byte a byte, formulário do editor de temas (rótulos, preenchimento, prévia só no contêiner, erros, tamanho, salvar) e os fluxos do app (salvar e ativar, importar, exportar).

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

### Corrigido

- Pré-requisitos da etapa 6:
  - RR-03: a gravação no vault passa a ser autorizada pelo conteúdo que o app leu ou gravou por último (texto ou sha256), não pelo mtime — uma edição externa no mesmo tique de mtime (FAT, rede, nuvem) seguida de outra leitura não é mais sobrescrita; o app grava com `writeIfUnchanged`, e `updateJsonFile` (`config.json`) usa a mesma base; a escrita §4.3 com `expectedMtime` resolve a base por um registro de versões servidas e recusa uma base ambígua;
  - CR-13: o vault não guarda mais os bytes de cada arquivo lido na sessão, só `{mtime, sha256}` (até 16 versões por caminho); `sha256Hex` (`@noble/hashes`, síncrono, igual em todos os WebViews) é exportado por `@simplemd/vault`;
  - testes Vitest: cenário RR-03 (`ConflictError`, sha256 do disco = bytes externos), base por texto e por sha256, toque só de mtime, bytes iguais (0 gravações), arquivo removido, 10 gravações concorrentes com relógio congelado, gravações seguidas no mesmo tique, despejo do registro e `updateJsonFile` com corrida no mesmo tique;
  - AS-02 (com AS-01, AS-03, AS-08, CR-09, API-05): o plugin fs do Tauri e as permissões de fs/diálogo do webview foram trocados por comandos próprios em Rust (`vault_read_dir`, `vault_lstat`, `vault_read_file`, `vault_write_file`, `vault_mkdir`, `vault_watch`, `vault_unwatch`, `save_target_pick`/`save_target_write`, `open_file_pick`): caminhos só relativos à pasta aberta, raiz guardada no Rust e trocada em `pick_vault` (token novo por abertura; a pasta anterior fica inalcançável e pode ser reaberta), validação de caminho, recusa de links em qualquer prefixo, classes de arquivo com tetos de leitura no arquivo aberto, erros por `io::ErrorKind`; exportar tema grava pelo token de uso único do diálogo (o aviso mostra o nome do arquivo) e importar recusa acima de 256 KB sem ler; `pnpm check:security` confere o inventário de 12 comandos, a ausência de `fs:`/`dialog:` e do plugin fs; CI roda `cargo test` (18 testes) no macOS e no Windows; testes Vitest da porta de produção sobre um gateway emulado.
  - EC F-5: "Recarregar do disco" num conflito de uma aba de fundo não troca mais a aba ativa, e o foco volta ao elemento de antes do diálogo;
  - EC F-11 / N-1 (regra de clique fora, UX-R2-D27): um clique fora das Configurações só fecha o diálogo (o clique não posiciona o cursor nem ativa abas) e o foco volta a quem o abriu; os diálogos de conflito, de alterações não salvas e o editor de temas ignoram o clique fora e mantêm o foco dentro deles.

- Revisão de código da Fase A (achados CR-xx):
  - CR-01: fechar uma aba, fechar a janela ou trocar de pasta não grava mais arquivos que o usuário não editou (antes, arquivos com finais de linha mistos ou só CR eram regravados ao fechar);
  - CR-02: o que for digitado enquanto o diálogo "Abrir pasta…" está aberto é gravado antes de trocar de pasta (se a gravação falhar, a pasta não troca e aparece "Algumas alterações não foram salvas");
  - CR-03: teclas que chegam durante a gravação de fechamento (aba ou janela) são gravadas antes de fechar;
  - CR-04: cursor e seleção de cada aba voltam ao trocar de aba;
  - CR-05: arquivos só com CR (Mac clássico) mantêm o CR ao salvar;
  - CR-06: o vault recusa gravar sobre uma versão que outro leitor já viu e o editor não;
  - CR-07: o autosave de um arquivo aberto não relê mais a árvore inteira do vault;
  - CR-08: sem lookbehind em regex nem `Promise.withResolvers` no código do app (alvo `safari16`), com regra de lint;
  - CR-10: no macOS/Linux a pasta escolhida é canonizada, para os eventos do observador de arquivos casarem;
  - CR-12: uma falha inesperada ao abrir a pasta não trava mais "Abrir pasta…";
  - CR-15: o limite de 16 leituras de pasta simultâneas não é mais ultrapassado;
  - CR-16: `apps/desktop/src` entra no relatório de cobertura.

- Achados da QA da Fase A (fase 4):
  - a11y F-1 (bloqueante): o conteúdo do editor tem `tabindex="0"`, então a área rolável do CodeMirror passa a regra `scrollable-region-focusable` do axe (demo, app e prévia), sem criar parada de Tab nova; o editor da prévia do editor de temas não é parada de Tab (a região da prévia é a única; EC F-8 / a11y F-5);
  - UIF F-01 (bloqueante): no editor de temas, a falha ao salvar, o resumo de erros e o motivo "Abra uma pasta…" ficam numa faixa fixa logo acima do rodapé, sempre visíveis sem rolar (800, 1280 e 1920 px); a falha ao salvar recebe o foco;
  - UIF F-04: o diálogo de conflito (e o de alterações não salvas) tem camada própria e escurece as Configurações/Editor de temas que estiverem abertos; ao resolver o conflito, o foco volta ao diálogo de baixo (EC F-4);
  - a11y F-3 / EC F-2: diálogos com `aria-modal="true"`; a11y F-2 / EC F-9: o título oculto da casca fica dentro de `<main>`;
  - EC F-6: em cada pilha de avisos o mais novo fica em cima; EC F-7 / a11y F-6: nome acessível das abas sem espaço antes da vírgula (`nota.md, não salvo`);
  - UIF F-03: se a primeira pasta não abrir, o tema e as fontes escolhidos antes voltam (em vez dos padrões);
  - UIF F-06: a aba ativa se funde ao editor (sem a linha de base embaixo dela); UIF F-07: espaçamento de cabeçalho e corpo dos diálogos conforme o DESIGN, com linha sob o cabeçalho; UIF F-08: campos hexadecimais com 32 px de altura; UIF F-10: atalhos (`⌘O`) na fonte da interface; UIF F-11: campos travados durante "Salvando…" aparecem desabilitados;
  - API-01: temas chamados "Con", "Nul", "Aux", "Prn", "Com1"… são salvos (`con-tema`, …) em vez de falhar na guarda de caminhos; API-02: `config.json` com BOM é lido normalmente;
  - TA-1: os testes de cursor por aba (`tab-state.test.tsx`) limpam a árvore entre testes e usam o editor da própria renderização; TA-2: o teste de NFR-4 afirma o limite de 500 ms; TA-5: arquivos que não são código saem da cobertura.

### Documentação (dívida)

- Textos de interface que ainda não estão na tabela STR da arquitetura (`arch-ux`, fora do repositório) e devem ser incluídos nela:
  - etapa 2: `⌘O abre uma pasta` / `Ctrl+O abre uma pasta` (boas-vindas); `⌘O abre outra pasta` (sem abas); `Não foi possível abrir a pasta.` (boas-vindas e aviso na casca); `Sem permissão para acessar esta pasta.` (aviso na casca); `Este arquivo mistura finais de linha; ao salvar, eles serão unificados.`; item de menu `Sair do simpleMD`;
  - etapas 4–5: `⌘, abre as configurações` / `Ctrl+, abre as configurações`; `Não foi possível ler .simplemd/config.json; usando as preferências padrão. Elas valem só nesta sessão.`; `O tema salvo em .simplemd/config.json não foi encontrado; usando “simpleMD Claro”.`; `Valores inválidos em .simplemd/config.json foram trocados pelo padrão.`; `Alguns temas de .simplemd/themes são inválidos e foram ignorados.`; mensagens de falha de E/S na importação (`… Nada foi gravado.`); opção `Do tema: <família>`.

### Alterado

- `PLANO.md` §4.2: o exemplo de tema usa os nomes de tokens da decisão D-1 (`--color-bg`, `--color-fg`, `--color-accent`, `--fontFamily-mono`, `--dimension-font-size`), com uma nota que registra a troca dos nomes originais (`--bg`, `--fg`, `--accent`, `--font-mono`, `--font-size`) e o conjunto obrigatório v1.
