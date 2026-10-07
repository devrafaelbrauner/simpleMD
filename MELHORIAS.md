# Melhorias

Ideias e itens fora do escopo atual. Nada aqui está planejado para uma etapa; cada item precisa de decisão antes de entrar no `PLANO.md`.

## Fora do escopo do plano (PLANO §1)

- iOS (viável com Tauri 2; exige Apple Developer e Mac para build)
- Colaboração em tempo real (CRDT / Yjs)
- Marketplace de plugins e assinatura de plugins de terceiros
- Sync próprio (servidor na Hetzner) — alternativa futura ao iCloud no Android
- Sandbox de plugins em iframe/worker
- Pandoc em web/Android

## Adiado na Fase A (etapas 0–5)

- Criar, renomear e excluir arquivos e pastas no explorador. A etapa 2 cobre só abrir pasta, listar, ler e salvar (decisão Q-3).
- Carregar ou aplicar o arquivo `css` opcional de um tema (PLANO §4.2). CSS arbitrário abre uma superfície de ataque (`url()`, sequestro de layout); nesta fase o campo é só preservado na importação/exportação.
- No live preview: links clicáveis, estilo de código inline, caixas de seleção de listas de tarefas, tachado e citações (`>`) — ficam crus nesta fase (D-P1). Abrir URLs também exigiria permissões de shell/opener.
- No live preview: tabelas dentro de listas ou citações, títulos setext, links de referência, autolinks e imagens ficam crus (só tabelas de topo viram `<table>`). Markdown dentro de células de tabela aparece como texto literal no widget.
- Lembrar o último vault aberto entre execuções; várias janelas; vários vaults ao mesmo tempo.
- Orçamento de tamanho de bundle/instalador (revisitar na etapa 14, com o sidecar do Pandoc).
- Editor de temas: pedir confirmação antes de descartar um rascunho ao fechar (hoje o rascunho é descartado sem perguntar; decisão OQ-2).
- Indentar listas com Tab dentro do editor. Tab não é capturado pelo CodeMirror para não prender o foco do teclado (WCAG 2.1.2).
- Comando de link (`Mod-K`): quando a área de transferência tiver uma URL, usá-la no lugar do marcador `url` selecionado.
- Preservar o fim de linha de cada linha em arquivos com finais mistos (hoje o primeiro salvamento após uma edição unifica no estilo dominante, com aviso; OQ-1).
- Seguir links simbólicos que apontam para dentro do vault (hoje todo link é ignorado na listagem e recusado na leitura/escrita; OQ-4).
- Gravação atômica (arquivo temporário + renomear) em vez de gravar no lugar (OQ-5).
- Limite de tamanho para abrir `.md` muito grandes (OQ-2 do backend).
- Arquivos criados fora do app só aparecem no explorador quando a observação de arquivos está ativa; com a sondagem de 1 s, aparecem ao reabrir a pasta.
- Atalho alternativo para trocar de aba (`Mod-Alt-→/←`) caso o WKWebView não entregue `Ctrl-Tab` (OQ-5 da UX).
- Fontes mono em itálico embutidas (hoje o itálico do editor é oblíquo sintetizado a partir do Regular; U-5) e pesos intermediários.
- Recarregar as preferências quando `.simplemd/config.json` muda fora do app (hoje elas são lidas só ao abrir a pasta).
- Preferências globais fora de uma pasta (hoje, sem pasta aberta, tema e fonte valem só na sessão; lembrar o último vault é não-objetivo).
- Editor de temas: editar um tema da pasta no lugar e excluir temas (hoje salvar sempre cria um tema novo; CF-5) e editar tokens além dos 11 obrigatórios (os demais vêm da base).
- Editor de temas: tamanho da fonte em outras unidades além de `px` (um tema importado com `rem`/`em` aparece convertido para px no formulário).

## Não-objetivos da Fase A, etapas 6–12 (cada um é um "não" deliberado)

- Etapa 13 em diante (release assinado, auto-update, Pandoc, motor WYSIWYG, web, Android): fora do escopo desta rodada, que para antes da decisão de assinatura de código. Revisitar na próxima rodada.
- Sandbox de plugins (iframe/worker/realm separado): decisão do usuário antes da etapa 6 — isolamento = API estreita + nenhum global do Tauri + aviso ao ativar, documentado como **não** sendo sandbox (já listado acima em PLANO §1).
- Marketplace, assinatura de plugins e interface de instalar/desinstalar/atualizar: instalar = copiar uma pasta; desinstalar = apagá-la. Um botão de desinstalar exigiria permissão de remoção de arquivos.
- Recarregar um plugin a quente quando o `main.js` muda: código novo exige novo consentimento; recarregar em silêncio anularia o aviso.
- `plugins-examples/word-count`: listado no PLANO §3, mas nenhuma etapa 6–12 o pede (etapa 16 ou depois).
- Editar propriedades no painel de propriedades: só leitura na v1 (reescrever YAML a partir de um formulário muda bytes além da chave editada, regra 1).
- Busca de texto completo no corpo das notas, backlinks e `[[wikilinks]]` clicáveis: o catálogo busca título/caminho/tags; wikilinks são inseridos pelo autocompletar, mas aparecem como texto.
- Snippets definidos pelo usuário e paradas de Tab em snippets: a v1 tem um conjunto fixo; navegar por paradas exigiria capturar Tab (WCAG 2.1.2).
- Renderizar HTML cru do Markdown (no editor ou na exportação): aparece e é exportado como texto literal; evita injeção de script no app durante a impressão (renderização sanitizada fica para depois).
- Imagens embutidas na exportação HTML/PDF: ler arquivos que não são `.md` está fora do provider do vault, e `img-src 'self'` bloqueia URLs locais; o HTML mantém o `src` como escrito e o PDF mostra o texto alternativo.
- Exportar para DOCX/ODT/EPUB/LaTeX e PDF via Pandoc: etapa 14 (o app não chama o `pandoc` do sistema).
- IA: histórico do chat persistido, contexto automático do documento, uso de ferramentas/agentes, embeddings e Ollama remoto (fora do loopback): o chat envia só o que o usuário digita e os comandos enviam só a seleção.
- Verificação interativa no Windows (impressão no WebView2, interface do keychain, fluxo de plugins): sem máquina Windows, só CI; bloqueia a etapa 13 ("critérios 1–7 em máquina limpa").
- NFR de partida a frio do SO: herdado da Fase A (esclarecimento NFR-7); medir antes da etapa 13.

## Achados da revisão de código adiados (CR-xx)

- RR-02 (resíduo de CR-02): no caminho "Fechar sem salvar" da troca de pasta, o segundo diálogo de pasta roda sem novo flush; edições digitadas nele em abas sem erro (fora da lista do L4) se perdem. Só com diálogo não modal (Windows, inferido). Corrigir com `flushAll()` após o diálogo ignorando só os caminhos descartados, ou casca `inert` enquanto `opening`.
- ~~RR-03 (resíduo de CR-06): a autorização de escrita do vault ainda se baseia no mtime~~ — **corrigido** no pré-requisito C2 da etapa 6: o app grava com `writeIfUnchanged` e uma base de conteúdo (o texto lido/gravado por último); a escrita §4.3 com `expectedMtime` resolve a base por um registro de versões servidas (hashes) e recusa uma base ambígua (duas versões lidas no mesmo tique). Resíduo: a escrita §4.3 só com `mtime` não distingue dois chamadores do próprio app no mesmo tique (como no r1); o app não a usa.
- CR-09: segurança em profundidade do escopo de arquivos — revogar o escopo da pasta anterior, negar `.git/`/`.env` no nativo e restringir o diálogo de abrir foram **corrigidos** no pré-requisito C3 (gateway do vault em Rust, AS-01/02/03). Resta: recusar `/` e `$HOME` como vault.
- CR-11: com um tema salvo ausente ou inválido, a próxima mudança de preferência regrava `config.json` com `simplemd-light`; gravar só as chaves alteradas na sessão.
- ~~CR-13: o vault guarda os bytes de todo arquivo lido/gravado na sessão~~ — **corrigido** no pré-requisito C2: o registro guarda só `{mtime, sha256}` (até 16 versões por caminho).
- CR-14: `tablePreviewField` recalcula todas as tabelas a cada transação; mapear as decorações e recalcular só as tabelas afetadas (medir NFR-5 antes).
- CR-17: asserções redundantes `expect(screen.getBy…).toBeDefined()` nos testes de UI.
- RR-01 (regressão de CR-07): aba em conflito cujo arquivo é removido fora do app — o evento é de um caminho aberto, então não há nova listagem, e `checkTab` ignora abas em conflito; o explorador mantém a linha do arquivo removido até "Manter ambos", um clique na linha ou outro evento. Corrigir relistando em `#reloadOriginal` (NOT_FOUND) ou tratando remoção também em abas em conflito.
- RR-04: quando as 5 rodadas de flush ao fechar se esgotam (digitação contínua com gravações lentas), a aba fica `dirty` em vez de `error`; o L4 lista o arquivo, mas "Voltar" procura `error` e não ativa nada. Sem perda de dados. Marcar `error` ao esgotar ou usar `unsavedClose.paths[0]` no "Voltar".
- RR-05: `CHANGELOG.md` — "Corrigido" aparece antes de "Alterado" e "Documentação (dívida)" não é categoria do Keep a Changelog; reordenar e mover a lista de textos STR para cá ou para `TAREFAS_PENDENTES.md`.
- RR-06: `decodeDocument` faz três `split()` por abertura/recarga (≈ 75 mil strings num arquivo de 1 MB); trocar por um laço único com `charCodeAt`.

## Pendências não bloqueantes da Fase A (QA r1), registradas antes da etapa 6

Cada item: ID de origem — descrição — dono — etapa-alvo. A etapa 12 (`/seguranca`) dá o status final de AS, Secrets e DO (corrigido com commit, adiado com linha aqui e etapa ≤ 13, ou aceito com justificativa).

### AppSec (AS)

- AS-01 — `dialog:allow-open` deixa o webview pedir `open({directory, recursive})` — **corrigido** no pré-requisito C3: nenhuma permissão `dialog:*`/`fs:*` no webview; diálogos só por comandos Rust.
- AS-02 — as concessões de escopo de fs se acumulam ao trocar de pasta — **corrigido** no pré-requisito C3: plugin fs não registrado; raiz única no Rust trocada em `pick_vault`, token novo por abertura (antigo → `VAULT_CLOSED`); teste Rust `switch_revokes_previous_root`. Metade MAC (AC-6.27f) na etapa 6.
- AS-03 — link simbólico em caminho novo passava pela checagem nativa — **corrigido** no pré-requisito C3: o Rust percorre cada prefixo com `symlink_metadata` e recusa links/junções (`symlink_prefix_refused`).
- AS-04 — CSP com `style-src 'self' 'unsafe-inline'` (necessário para o CodeMirror e propriedades inline) — AppSec — etapa 12 (aceito com justificativa ou endurecido).
- AS-05 — ações do CI fixadas por tag mutável, não por SHA — DevOps — etapa 12 (junto com Secrets F-2).
- AS-06 — `pnpm-workspace.yaml` sem `minimumReleaseAge`, `trustPolicy` e `blockExoticSubdeps` — DevOps — etapa 12.
- AS-07 — avisos RustSec só do Linux/GTK (RUSTSEC-2024-0370, RUSTSEC-2024-0429), transitivos do Tauri — backend — etapa 12 (`audit.toml` documentando as exceções, DO-4).
- AS-08 — TOCTOU entre `stat` e leitura na importação de tema — **corrigido** no pré-requisito C3: `open_file_pick` checa o tamanho no arquivo aberto e lê no máximo teto + 1 bytes.
- AS-09 — leitura de `.md` sem teto de tamanho (só `config.json` e `theme.json` têm) — backend — etapa 12 (aceito, r1 OQ-2, ou teto com mensagem).

### Segredos (Secrets)

- Secrets F-1 — nenhum gate de varredura de segredos no CI nem em pre-commit (o gitleaks só roda à mão) — DevOps — etapa 12 (job de gitleaks).
- Secrets F-2 — ações do CI fixadas por tag, não por SHA — DevOps — etapa 12 (mesma correção de AS-05).
- Secrets F-3 — `actions/checkout` com `persist-credentials` padrão (`true`) — DevOps — etapa 12.
- Secrets F-4 — `main` sem proteção de branch — dono do repositório (ação do usuário) — antes da etapa 13.
- Secrets F-5 — `target/` na raiz não está no `.gitignore` (só o do `src-tauri`); relevante se surgir um workspace Cargo na raiz — desenvolvedor — etapa 12 (status final; corrigir quando houver workspace na raiz).
- Secrets F-6 — risco da regra 7: `config.json` preserva chaves desconhecidas, então é onde uma chave de API mal colocada pararia; falta um teste de que `config.json` nunca guarda chave — desenvolvedor da etapa 11 — etapa 11.
- Secrets F-7 — trufflehog e osv-scanner indisponíveis (lacuna de ferramenta) — Main / AppSec — etapa 12.

### Revisão de código (QR)

- QR-01 — no editor de temas (L3), a faixa de status vazia ainda ocupa 8 px (o `gap` entre os dois contêineres de alerta vazios) — frontend — **feito na etapa 7** (sem `gap` na faixa; espaço só entre itens com conteúdo).
- QR-02 — a restauração de foco após o conflito sobre um diálogo (EC F-4) não tem teste automatizado (PW CNF-OVER-DIALOG para L2 e L3) — QA — fase 4 desta rodada (etapa 12 no máximo).
- QR-03 — `#sessionChoice` em `settings.ts` só é limpo em `reset()` e fica obsoleto após a primeira abertura (inalcançável hoje) — frontend — etapa 12 (revisar; vira bug só com um futuro "fechar pasta").
- QR-04 — `config.json` com BOM é aceito e a primeira gravação de preferência remove o BOM (intencional; `updateJsonFile` sempre reserializa) — backend — **feito** no pré-requisito C2 (documentado no comentário de `updateJsonFile`).
- QR-05 — no editor de temas, a falha ao salvar é `role=alert` e recebe foco; alguns leitores de tela leem duas vezes — a11y — fase 4 desta rodada (confirmar com VoiceOver; etapa 12 no máximo).

### Acabamento de interface (UIF, rodada 2)

- R2-N1 — a 800×600, as Configurações sem pasta aberta transbordam 28 px; a linha de persistência aparece cortada acima do rodapé — frontend — etapa 6 (as Configurações ganham seções em abas). **Endereçado na etapa 6:** a linha foi para a faixa de status fixa do L2 (UX-R2-D8); a medida a 800×600 fica para a QA (fase 4).
- R2-N2 — a faixa de status vazia do L3 ocupa 8 px em todos os estados sem mensagem — frontend — **feito na etapa 7** (mesma correção de QR-01; 0 px medido no harness).

### DevOps (DO)

- DO-1 — toolchains sem pin: CI compila com rustc 1.99 e localmente é 1.98.1; Node flutuante no CI, sem `.nvmrc` — DevOps — etapa 12 (`rust-toolchain.toml` e `.node-version`).
- DO-2 — o CI não publica artefatos nem hashes, e o hash do binário depende do caminho do build — DevOps — etapa 13 (`SHA256SUMS` e atestado de proveniência).
- DO-3 — atualizações automáticas desligadas (Dependabot de segurança desabilitado, sem `dependabot.yml`) — dono do repositório + DevOps — etapa 13.
- DO-4 — o CI não roda `pnpm audit --prod`, `cargo audit` nem semgrep (NFR-15 só por QA manual) — DevOps + AppSec — etapa 12 (job de auditoria).

## Achados da QA da Fase A adiados (fase 4)

- UIF F-03 (parte restante): durante a primeira listagem de uma pasta, a casca aparece com as preferências dessa pasta antes de a listagem terminar; se a listagem falhar, o app volta às boas-vindas com as preferências da sessão (corrigido), mas a troca de tema durante a listagem continua. Aplicar as preferências da pasta só depois da listagem bem-sucedida, sem perder A-20.
- UIF F-05: a seleção do editor avança sobre o padding de 24 px da medida em linhas quebradas (camada de seleção do CodeMirror); restringir a faixa à coluna de texto.
- UIF F-09: o texto "Escolha um arquivo no explorador." aparece mesmo com o explorador vazio, em erro ou sem permissão; precisa de variantes na tabela STR (decisão de UX).
- EC F-3: avisos criados com um diálogo aberto ficam dentro da árvore que o Radix marca `aria-hidden`, então leitores de tela não os anunciam (ex.: falha ao exportar com as Configurações abertas). Levar as regiões vivas para dentro do diálogo do topo ou anunciar por uma região própria do diálogo.
- ~~EC F-5: conflito numa aba de fundo — "Recarregar do disco" trocava a aba ativa~~ — **corrigido** no pré-requisito C4 (decisão Q-11, arch-ux r2 §2.1): a aba ativa não muda e o foco volta ao elemento de antes do diálogo; "Manter ambos" continua ativando a cópia (UX-D13).
- EC F-10: painéis nativos (abrir/salvar) e itens padrão do menu do macOS em inglês, e título do menu do app "simplemd" em minúsculas; localizar o bundle (`CFBundleDevelopmentRegion` pt-BR, nomes dos itens) na etapa 13.
- ~~EC F-11 / N-1: clique fora das Configurações fechava e posicionava o cursor no editor; nos diálogos que ficam abertos, o foco ia para o `<body>`~~ — **corrigido** no pré-requisito C4 (UX-R2-D27): diálogos dispensáveis (Configurações) fecham no clique fora sem que o clique chegue ao que está embaixo, e o foco volta ao invocador; L1, L3 e L4 ignoram o clique fora e mantêm o foco dentro do diálogo.
- a11y F-4: o fundo atrás dos diálogos é isolado pelo Radix (foco preso, `aria-hidden`, `pointer-events`), não por `inert`; atualizar a linha EDT-INERT ou pôr `inert` na raiz enquanto um modal estiver aberto.
- API-04: um link físico (hard link) dentro do vault para um arquivo de fora é indistinguível de um arquivo comum e é gravado no lugar (mesmo inode); anotar junto de OQ-5 (gravação atômica mudaria isso).
- ~~API-05: `TauriFsPort.lstat` classificava `ENOTDIR` como `IO`~~ — **corrigido** no pré-requisito C3: `vault_lstat` devolve `null` para inexistente ou prefixo que não é pasta, como a porta Node.
- TA-4: o teste de NFR-13 (200 intercalações) exercita o provider com um protocolo de app modelado no teste; passar a dirigir as intercalações pelo `createAppController` real.

## Etapa 6 — plugins: adiado e ideias

- Sandbox de plugins (realm separado, worker ou iframe) — continua fora (decisão do usuário); o aviso de ativação e `docs/plugins.md` dizem isso.
- Plugins externos com vários arquivos (grafo de módulos com hash) — v1 aceita só um `main.js` (FR-4).
- Anúncio na região viva local do L2 também para o conflito de atalho (hoje só o aviso N1 e o status do plugin são anunciados).
- Bundle do app: os namespaces inteiros de `@codemirror/language` e `@codemirror/autocomplete` entram como módulos do host (~1,06 MB de JS antes do gzip no build de release do S1); medir e, se preciso, dividir o chunk (`build.rolldownOptions.output.codeSplitting`).
- `vault:change` também chega para gravações do próprio app (o observador não distingue); filtrar se algum plugin reclamar.

## Etapa 7 — renderização (Mermaid, KaTeX, calc): adiado e ideias

- calc com vírgula decimal (`=2,5+1`) — fora por decisão Q-12 (só `.`); avaliar uma opção por pasta.
- calc com pontuação colada (`=2+3.` ou `=2+3,` no fim de uma frase) não é calculado (o token vai até o próximo espaço, R-7.4); aceitar `.`/`,` final como fim de frase.
- calc: resultado não finito (`=10^400`, `=(-8)^0.5`) fica cru como erro de sintaxe; mostrar um erro próprio.
- Diagramas Mermaid e blocos `$$` dentro de listas e citações ficam crus (só blocos de topo, como as tabelas do r1).
- KaTeX: `$$…$$` numa linha só e `$$` no meio de um parágrafo não viram bloco (só `$$` em linhas próprias, abrindo o parágrafo).
- Um bloco que entra na tela sem render ainda aparece cru e troca para o widget quando o render chega (salto de altura); pré-renderizar os blocos próximos do viewport.
- Harness: atraso injetável no import do Mermaid (H14, MMD-LOADING) não foi criado; a QA pode atrasar a rota do chunk no Playwright.
- `scripts/bundle-report.mjs` (tamanho por chunk) não foi criado; os tamanhos do build ficam no relatório do S2. O Mermaid traz dezenas de chunks de tipos de diagrama (o maior, `elk`, ~1,46 MB antes do gzip), todos carregados só sob demanda.
- Exportação (etapa 10): `./mermaid/render`, `./katex/render` e `./calc/render` já são funções reutilizáveis; o tema claro da exportação vem de `tokens.css`.

## Etapa 9 — front matter, catálogo e índice: adiado e ideias

- Índice acima de 20 MB (ou ilegível) é ignorado e refeito em memória, mas não é regravado na sessão (sem base de conteúdo o provider recusa sobrescrever); oferecer "Reconstruir índice" que apague o arquivo.
- Gravações de plugin (`api.vault.write`) só atualizam o índice pelo observador; no modo de sondagem (sem observador) entram na próxima abertura da pasta.
- Pasta inteira copiada para dentro do vault com o app aberto: o observador costuma relatar só a pasta; as notas novas entram na próxima abertura (o índice não lista pastas fora da abertura, CR-07).
- Painel "Propriedades" é só leitura (D-14): edição de propriedades fica para depois.
- Erros de YAML usam mensagens próprias por código do `yaml` (as em inglês não aparecem); um texto genérico cobre os códigos raros.
- Harness: `catalog.buildDelayMs` (H18) não foi criado; o ritmo da indexação é feito com `fault('read', { delayMs })`, e o índice quente com `reopenVault()`.

## Etapa 8 — autocompletar: adiado e ideias

- Snippets sem navegação entre campos (Tab nunca é capturado, UX-D7): só o primeiro campo fica selecionado; avaliar outra tecla para os campos seguintes.
- Snippets do usuário (por pasta) e sugestões de `#tag` a partir do índice.
- O Enter só aceita depois de 75 ms do popup aberto (`interactionDelay` do CodeMirror); antes disso faz a quebra de linha.
- Palavras de outras notas do vault (hoje só as do documento aberto).
- `Alt-Espaço` (macOS) fica como alternativa se `⌘⇧Espaço` não chegar ao WKWebView (OQ-R2-5; depende do teste MAC).
