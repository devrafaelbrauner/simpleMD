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

## Revisão de código r2 (CR2-xx): corrigido e resíduos

Todos os achados CR2-01…CR2-11 foram corrigidos na rodada de correções, cada um com teste de regressão (ver `CHANGELOG.md`). Resíduos conscientes:

- CR2-02: uma pasta escolhida cuja troca foi abandonada (a regravação da pasta atual falhou) continua pendente no Rust até o próximo `pick_vault`; ela não vale nada até o primeiro uso do token, e o webview esquece o token. Um comando `vault_discard_pending` só valeria se aparecer outro caminho que use tokens pendentes.
- CR2-04: `O_NOFOLLOW` (Unix) e `FILE_FLAG_OPEN_REPARSE_POINT` (Windows) + checagem do arquivo aberto fecham a corrida no último componente; a corrida num componente intermediário (pasta trocada por link/junção entre o percurso e a abertura) só fecha com abertura relativa a um descritor de pasta (`openat` com `O_NOFOLLOW` em cada nível / `NtCreateFile` com `RootDirectory`) — reavaliar junto da gravação atômica (OQ-5).
- CR2-06: o pós-checagem da exportação é uma leitura de tags em texto (o core não tem DOM); na dúvida ele recusa e a exportação mostra o código cru. Sanitizador baseado em DOM só se o HTML cru passar a ser exportado (etapa 12+).
- NB-R1 (re-revisão r2, aceito como limitação conhecida): por causa do pós-checagem estrito do CR2-06, diagramas Mermaid que o Mermaid desenha com `foreignObject` mesmo com `htmlLabels: false` (por exemplo `journey`) são exportados para HTML/PDF como código cru; no editor eles aparecem desenhados. Decisão do Main: manter o pós-checagem estrito. Reavaliar só com um sanitizador de SVG baseado em DOM que aceite `foreignObject` sem HTML ativo (dono: exportação; sem etapa-alvo).

## Pendências não bloqueantes da Fase A (QA r1), registradas antes da etapa 6

Cada item: ID de origem — descrição — dono — etapa-alvo. A etapa 12 (`/seguranca`) dá o status final de AS, Secrets e DO (corrigido com commit, adiado com linha aqui e etapa ≤ 13, ou aceito com justificativa).

### AppSec (AS)

- AS-01 — `dialog:allow-open` deixa o webview pedir `open({directory, recursive})` — **corrigido** no pré-requisito C3: nenhuma permissão `dialog:*`/`fs:*` no webview; diálogos só por comandos Rust.
- AS-02 — as concessões de escopo de fs se acumulam ao trocar de pasta — **corrigido** no pré-requisito C3: plugin fs não registrado; raiz única no Rust trocada em `pick_vault`, token novo por abertura (antigo → `VAULT_CLOSED`); teste Rust `switch_revokes_previous_root`. Metade MAC (AC-6.27f) na etapa 6.
- AS-03 — link simbólico em caminho novo passava pela checagem nativa — **corrigido** no pré-requisito C3: o Rust percorre cada prefixo com `symlink_metadata` e recusa links/junções (`symlink_prefix_refused`).
- AS-04 — CSP com `style-src 'self' 'unsafe-inline'` (necessário para o CodeMirror e propriedades inline) — **aceito** na etapa 12 (status final, AppSec r2): nenhum script inline nem `eval` é possível, e a exfiltração por CSS `url()` é barrada por `img-src`/`font-src 'self'` (sonda `c_css_background` → violação de `img-src` no WebKit e no Chromium). O CodeMirror precisa de estilos inline.
- ~~AS-05 — ações do CI fixadas por tag mutável, não por SHA~~ — **corrigido** na etapa 12a: todo `uses:` fixado pelo SHA de 40 hex do commit com a versão no comentário (`actions/checkout` v7.0.1, `pnpm/action-setup` v6.0.10 — a mesma que o `@v6` resolvia —, `actions/setup-node` v7.0.0, `Swatinem/rust-cache` v2.9.2, `actions/upload-artifact` v7.0.1); `dtolnay/rust-toolchain@stable` saiu (o rustup do runner lê `rust-toolchain.toml`); imagem do Semgrep por digest sha256; `check:security` reprova regressão. Falta a parte do dono do repositório: `sha_pinning_required` e ações permitidas restritas nas configurações (junto com Secrets F-4, antes da etapa 13).
- ~~AS-06 — `pnpm-workspace.yaml` sem `minimumReleaseAge`, `trustPolicy` e `blockExoticSubdeps`~~ — **corrigido** na etapa 12a: `minimumReleaseAge: 1440`, `trustPolicy: no-downgrade` (exceções revisadas `semver@6.3.1` e `undici-types@6.21.0`, só de desenvolvimento) e `blockExoticSubdeps: true`; o pnpm 12.8.1 confere o lockfile até no `--frozen-lockfile`. Pendente: subir `minimumReleaseAge` para 10080 (7 dias, o que a regra do Semgrep pede) a partir de 2026-10-13 — hoje 97 entradas do lockfile têm menos de 7 dias e a instalação quebraria; ao subir, tirar o `nosemgrep` da linha — DevOps — etapa 13.
- AS-07 — avisos RustSec só do Linux/GTK (RUSTSEC-2024-0370, RUSTSEC-2024-0429), transitivos do Tauri — **aceito** na etapa 12a com justificativa em `apps/desktop/src-tauri/.cargo/audit.toml` (avisos, não vulnerabilidades; `cargo tree -i` não mostra os crates em macOS nem Windows; no Linux vêm de tauri/tao/muda → gtk 0.18). Reavaliar quando o Tauri sair do gtk-rs 0.18.
- AS-08 — TOCTOU entre `stat` e leitura na importação de tema — **corrigido** no pré-requisito C3: `open_file_pick` checa o tamanho no arquivo aberto e lê no máximo teto + 1 bytes.
- AS-09 — leitura de `.md` sem teto de tamanho (só `config.json` e `theme.json` têm) — **aceito** na etapa 12 (status final, AppSec r2; r1 OQ-2): um plugin ativado já pode travar o app (item 4 de "PODE" em `docs/plugins.md`). Um teto com mensagem pode entrar na etapa 13.

### Segredos (Secrets)

- ~~Secrets F-1 — nenhum gate de varredura de segredos no CI nem em pre-commit (o gitleaks só roda à mão)~~ — **corrigido** na etapa 12a: job `secrets` com gitleaks 8.30.1 (binário com sha256 conferido) sobre o histórico inteiro (`fetch-depth: 0`, `gitleaks git`, `--redact`) em todo push e PR; falha com qualquer achado; `.gitleaksignore` com os falsos positivos revisados. Pre-commit continua opcional (não adotado). Torná-lo verificação obrigatória depende de Secrets F-4.
- ~~Secrets F-2 — ações do CI fixadas por tag, não por SHA~~ — **corrigido** na etapa 12a (mesma correção de AS-05).
- ~~Secrets F-3 — `actions/checkout` com `persist-credentials` padrão (`true`)~~ — **corrigido** na etapa 12a: os 7 checkouts têm `persist-credentials: false` (nenhum job usa git autenticado); `check:security` reprova regressão.
- Secrets F-4 — `main` sem proteção de branch — dono do repositório (ação do usuário) — antes da etapa 13. Ao ligar, exigir também os jobs novos `secrets`, `audit` e `semgrep`.
- Secrets F-5 — `target/` na raiz não está no `.gitignore` (só o do `src-tauri`) — **aceito** na etapa 12 (status final): não existe workspace Cargo na raiz, então nada é gerado ali; acrescentar a linha quando houver.
- ~~Secrets F-6 — falta um teste de que `config.json` nunca guarda chave~~ — **corrigido** na etapa 11: `apps/desktop/test/ai.test.ts` (AC-11.10 / AC-11.6, keychain falso) confere que a canária nunca chega ao `config.json` (Secrets r2 S2-07).
- Secrets F-7 — trufflehog e osv-scanner indisponíveis (lacuna de ferramenta) — **NÃO TESTADO** na etapa 12 (`docs/seguranca/etapa-12.md` S6/S7); instalar e rodar antes do primeiro release — Main / AppSec — etapa 13.

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

- ~~DO-1 — toolchains sem pin: CI compila com rustc 1.99 e localmente é 1.98.1; Node flutuante no CI, sem `.nvmrc`~~ — **corrigido** na etapa 12a: `rust-toolchain.toml` (`channel = "1.98.1"`, perfil mínimo + rustfmt/clippy; o CI roda `rustup toolchain install`) e `.node-version` (22.22.3, a mesma da máquina de referência; o Node só roda ferramentas de build e testes) lido pelo `actions/setup-node` em todos os jobs.
- DO-2 — o CI não publica artefatos nem hashes, e o hash do binário depende do caminho do build — DevOps — etapa 13 (`SHA256SUMS` e atestado de proveniência).
- DO-3 — atualizações automáticas desligadas (Dependabot de segurança desabilitado, sem `dependabot.yml`) — dono do repositório + DevOps — etapa 13.
- ~~DO-4 — o CI não roda `pnpm audit --prod`, `cargo audit` nem semgrep (NFR-15 só por QA manual)~~ — **corrigido** na etapa 12a: job `audit` (`pnpm audit --prod --audit-level high`; `cargo-audit` 0.22.2 com sha256 conferido, falha em vulnerabilidade) e job `semgrep` (1.179.0 por digest, `auto` + `p/typescript` + `p/react` + `p/rust` + `p/secrets`, `--error`; 4 exceções `nosemgrep` justificadas na linha: 3 usos só de teste/ferramenta de desenvolvimento em Rust e o `minimumReleaseAge` de AS-06). As regras vêm do registro do Semgrep na hora: uma regra nova pode reprovar o CI sem mudança no código.
- `pnpm audit --prod` acha 1 aviso **baixo** (GHSA-238p-pmpm-9mq7, katex < 0.18.2) só pela cópia do `katex` 0.16.47 que o `mermaid` 12.1.0 traz; o `katex` direto do app é 0.19.0 (corrigido). Abaixo do limite do CI; resolver quando o `mermaid` subir o `katex` ou com um `overrides` testado contra os diagramas — frontend — etapa 13.
- `pnpm/action-setup` v6.1.0 ("support pnpm v12") existe; o CI fixou a v6.0.10, que é a que o `@v6` resolvia e está verde. Atualizar junto com o Dependabot de ações (DO-3) — DevOps — etapa 13.

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
- ~~Gravações de plugin (`api.vault.write`) só atualizam o índice pelo observador; no modo de sondagem (sem observador) entram na próxima abertura da pasta.~~ — **corrigido** na revisão r2 (CR2-03): na sondagem, o foco da janela relista o vault e indexa notas novas ou mudadas.
- ~~Pasta inteira copiada para dentro do vault com o app aberto: o observador costuma relatar só a pasta; as notas novas entram na próxima abertura.~~ — **corrigido** na revisão r2 (CR2-03): uma pasta que existe é listada e as notas dela entram no índice.
- Sondagem (sem observador): o catálogo só relista no foco da janela, não a cada 1 s; uma nota criada fora do app com a janela já em foco entra no próximo foco.
- Painel "Propriedades" é só leitura (D-14): edição de propriedades fica para depois.
- Erros de YAML usam mensagens próprias por código do `yaml` (as em inglês não aparecem); um texto genérico cobre os códigos raros.
- Harness: `catalog.buildDelayMs` (H18) não foi criado; o ritmo da indexação é feito com `fault('read', { delayMs })`, e o índice quente com `reopenVault()`.

## Etapa 8 — autocompletar: adiado e ideias

- Snippets sem navegação entre campos (Tab nunca é capturado, UX-D7): só o primeiro campo fica selecionado; avaliar outra tecla para os campos seguintes.
- Snippets do usuário (por pasta) e sugestões de `#tag` a partir do índice.
- O Enter só aceita depois de 75 ms do popup aberto (`interactionDelay` do CodeMirror); antes disso faz a quebra de linha.
- Palavras de outras notas do vault (hoje só as do documento aberto).
- `Alt-Espaço` (macOS) fica como alternativa se `⌘⇧Espaço` não chegar ao WKWebView (OQ-R2-5; depende do teste MAC).

## Etapa 11 — IA: adiado e ideias

- `keyring` 3.x → migrar para `keyring-core` 1.x + crates de armazém quando estabilizar (a 4.x virou CLI; arch-backend r2 §1.7.3). Se o `cargo audit` marcar a 3.x, classificar na etapa 12.
- `has_key` lê o segredo (num `Zeroizing`, descartado) só para saber se existe; no macOS isso pode abrir o pedido de acesso do keychain para binários sem assinatura. Trocar por uma consulta só de atributos quando a crate permitir (etapa 13, com a assinatura).
- ~~Fixtures reais de OpenAI e Anthropic: aguardando as chaves do usuário~~ — **feito**: OpenAI (gpt-4o-mini) e Anthropic (claude-haiku-4-5) gravadas pelo `cargo run --example record_ai_fixtures` (pasta fora do repositório); 429/500 continuam sintéticas.
- Histórico do chat só na memória da sessão; confirmar antes de "Limpar conversa" fica para pedido de usuário (OQ-R2-2).
- Contexto da nota no chat (D-18 diz não por padrão): só como ação explícita e visível, se pedirem.
- Carregamento preguiçoso do pedaço de IA (arch-frontend §14.2): hoje entra no pacote principal; separar se o orçamento de bundle apertar.

## Etapa 10 — exportação: adiado e ideias

- Imagens no HTML/PDF (embutir como `data:` ou copiar ao lado do arquivo): hoje o HTML mantém o `src` como escrito e o PDF mostra o texto alternativo (não-objetivo do run).
- DOCX/ODT/EPUB/LaTeX e PDF por Pandoc: etapa 14 (sidecar com checksum).
- HTML cru sanitizado (hoje sai como texto, D-15): só com um sanitizador revisado na etapa 12+.
- Nome sugerido do PDF: o painel de impressão usa o título da janela ("simpleMD"); trocar o `document.title` pelo nome da nota durante a impressão se o WKWebView o usar como nome padrão (medir no SP-1).
- O aviso "Exportado para …" mostra só o nome do arquivo: o webview nunca recebe o caminho absoluto (gateway de salvar com token, arch-backend r2 §1.2).
- `@page { size: A4 }`: se o WKWebView ignorar o tamanho (SP-1, passo 3), o usuário escolhe A4 no painel — nota de UX, sem fallback em código.
- Visualização de impressão desmontada só na próxima exportação ou ao trocar de aba/pasta (a folha do WKWebView não avisa quando termina; arch-backend r2 A-3). Se o SP-1 mostrar que o WebKit tira um instantâneo ao abrir o painel, desmontar logo depois de `print()`.

## QA r2 (fase 4): achados adiados, com dono e etapa-alvo

- APPSEC-R2-01 (Médio) — o webview tem canais de saída que a CSP não cobre: WebRTC (STUN/TURN, também DNS) e `<link rel=preconnect>` (TCP, WebKit), confirmados no app de release no macOS. Documentado em `docs/plugins.md` (item 5 de "PODE"). Mitigação nativa — backend/AppSec — **etapa 13**: no Windows, `additional_browser_args` do WebView2 (por exemplo `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, eficácia a testar); no macOS, avaliar desligar o PeerConnection do WKWebView (preferência privada) ou aceitar com a documentação; acrescentar a linha "WebRTC/preconnect" à sonda MAC do AC-6.27.
- APPSEC-R2-02 (Baixo) — `set_key`/`delete_key` podem ser chamados por qualquer código no realm: um plugin troca a chave salva sem aviso. Documentado em `docs/plugins.md`. Confirmação nativa (diálogo do Rust) antes de gravar ou apagar a chave, ou aceite com a linha da documentação — backend — **etapa 13**.
- APPSEC-R2-03 (Baixo) — o consentimento cobre só os bytes do `main.js`; código carregado em tempo de execução (via `blob:`) não. **Documentado** em `docs/plugins.md` (Consentimento e CSP); sem mudança de código.
- APPSEC-R2-05 (Baixo) — pasta pendente abandonada alcançável pelo próximo token `u32` sequencial (resíduo CR2-02 acima): tokens aleatórios por `getrandom` (como os de salvar) ou descarte no próximo `pick_vault` — backend — **etapa 13**.
- APPSEC-R2-07 / APPSEC-R2-11 (Info) — **documentados** em `docs/plugins.md`: E/S fora da pasta só por escolha num diálogo do sistema; código e manifesto de plugins são só leitura pelo gateway.
- APPSEC-R2-08 (Info) — `core:default` concede `core:menu:*`, `core:path:*` e `core:event:emit`; trocar por uma lista mínima explícita — backend — **etapa 13**.
- APPSEC-R2-12 (Baixo) — a pós-checagem `isUnsafeRender` da exportação lê tags em texto e tem diferenciais de parser (`<svg x=a"b onload=…>`, `<img onerror>` dentro de comentário); CSS `url()`/`@import` da saída dos renderizadores não é checado. Normalizar a saída dos renderizadores (`DOMParser` na camada do app e reserializar, ou checar o DOM) antes da checagem e pôr uma CSP `<meta>` no HTML exportado (R2-09) — frontend (exportação) — **etapa 13**.
- F-R2-03 / F-R2-04 (UIF) — a lista de seções do L2 rola junto com o corpo e o diálogo muda de altura entre as seções: tirar a `tablist` de dentro de `.smd-dialog-body` e fixar a altura (`min(768px, 100vh − 32px)`) — frontend — próxima rodada de UI.
- F-R2-05 (UIF) — o texto do cartão C5 ignora a medida de 80ch a 1920. O corpo do C5 já usa a fonte mono (`.smd-ai-card-body`), mas no tamanho da UI (13 px); a medida do editor é `80ch` no tamanho do editor, então a coluna do cartão precisa de largura própria alinhada a `.cm-content` — frontend — próxima rodada de UI (etapa 13).
- F-R2-08 (UIF) — um aviso de 3 linhas cobre a linha de ações do C5 (R-6): deslocar a pilha de avisos acima do cartão ou dar altura mínima ao cartão — frontend/UX — próxima rodada de UI.
- F-R2-09 (UIF) — L2 "Aparência" a 800 px abre com "Ligaduras" meio escondida sob a faixa de status (dentro do DESIGN §12) — frontend — próxima rodada de UI.
- A11Y-R2-05 (axe `region`, moderado) — o invólucro do Radix do M1 aberto fica fora de landmarks; opcional — frontend — etapa 13.
- A11Y-R2-06 (menor, consultivo) — no tema escuro, `pie1` (`accent`) e `pie2` (`fg`) diferem só 2,42:1 em luminância (claro: 3,45:1); 1.4.11 é atendido (vão de `bg` entre fatias), mas a legenda liga nome e fatia só pela cor. Ordenar as misturas para fatias vizinhas ≥ 3:1 no escuro e dar alternativa em texto aos dados da pizza na exportação (fonte em `<details>`/`<figcaption>` ou `showData`) — frontend / design — etapa 13.
- UIF I-9 — a correção F-R2-06 encolhe os chips do catálogo cedo demais a 800 px (10 de 12 com "…", até `#horta`); o nome inteiro fica no `title` e no nome da opção. Opcional: mostrar um chip inteiro + "+N" quando dois não cabem — frontend — etapa 13.
- UIF I-10 — numa pizza com muitas fatias finas, o posicionamento padrão do Mermaid sobrepõe os menores percentuais ("3%1%"); comportamento da biblioteca. Junto dos avisos de marca P-3 (ordem das fatias) e P-4 (tamanhos de texto da pizza) — design / frontend — etapa 13.
- F-API-R2-03 (Baixa) — casos de borda da redação: (a) eco mascarado pelo provedor mantém até 4 caracteres finais; (b) `Bearer%20sk-…` codificado em URL não é redigido; (c) **quebra de paridade Rust↔TS**: `Bearer`+U+FEFF é redigido no TS (o `\s` do JS inclui U+FEFF) e não no Rust (`is_whitespace` não inclui); também passam `SK-ABC123`, `Bearer:abc123`, `sk_live_…`. Os corpos de erro reais também são redigidos pelo valor exato da chave no Rust. Alinhar `redact.rs`/`redact.ts` no que conta como espaço depois de `Bearer` — backend / SeniorDev — etapa 13.
- F-API-R2-04 (Baixa, produto) — a regra do filtro de `listModels` da OpenAI (README do `packages/ai`) ainda lista 18 ids que não servem `/v1/chat/completions` (`gpt-3.5-turbo-instruct*`, `*-codex*`, `*-pro*`, `o1-pro*`); escolher um dá "Erro do provedor: …" no chat. Ajustar a regra e o README — SeniorDev / produto — etapa 13.
- Secrets S2-09 (info) — uma string **sintética** revisada chegou à `main` (`af21e99`) antes do gate, porque o job `secrets` roda depois do push (S2-01); ficou uma entrada permanente no `.gitleaksignore` (sem reescrever histórico). Com uma chave real o mesmo caminho a publicaria. Mesma solução de S2-01/S2-02: checks obrigatórios num fluxo de PR (Secrets F-4) ou `gitleaks git --pre-commit --staged` local — dono do repositório — antes da etapa 13.

### Análise de testes r2 (TA-R2-xx)

- TA-R2-5 (produto, transitório) — calc e KaTeX decoram regiões que a árvore do Lezer ainda não alcançou (`shared/scan.ts` usa `syntaxTree(state)` sem limite), então chips aparecem dentro de código cercado até o parser chegar. Pular faixas além de `syntaxTree(state).length` / `syntaxTreeAvailable(state, to)` — SeniorDev — etapa 13.
- TA-R2-6 — `roundtrip_real_keychain` devolve `ok` quando é pulado (macOS no CI, local); no Windows a execução só é inferida pelo ambiente. Usar `#[ignore]` + `--include-ignored` no Windows ou `--nocapture` para a linha de confirmação aparecer no log — SeniorDev — etapa 13.
- TA-R2-7 — o VT do NFR-27 é especificado na porta Node fs mas mede a porta em memória; o Ubuntu (perna de cobertura) nunca o confere — PerfBenchmarker / SeniorDev — etapa 13.
- TA-R2-8 (processo) — a checagem de deriva de `plugins-examples/calc/main.js` só roda no CI (falhou duas vezes); pôr `node scripts/build-plugin-example.mjs && git diff --exit-code plugins-examples/calc` no `pnpm lint` ou num pre-push — DevOps — etapa 13.
- TA-R2-10 — a recusa de ponto de reparse no Windows (`FILE_FLAG_OPEN_REPARSE_POINT`) não tem teste Rust (os dois testes de link são `#[cfg(unix)]`; Windows roda 57 testes, macOS 59); teste de junção com `#[cfg(windows)]` — SeniorDev — etapa 13.
- TA-R2-11 — `e6acc0e` (guarda do `finished` da IA e foco do cartão) não ganhou VT; a metade do foco só tem PW fora do CI — SeniorDev — etapa 13.
- TA-R2-12 (processo) — a edição RG-3 do r1 `vault.contract.test.ts` não guardou original nem sha. Linha de base pós-AC-P.3 registrada: sha256 `d3e4350e3276ac4e24f60ad283273ac33850b6274c27e226bf21498c86d5973fa` — Main — feito (registro).
- TA-R2-14 — falta o VT do AC-6.17 para o mapeamento `role="alert"` de `notify(…, 'error')` de plugin (hoje só o prefixo e o nível) — SeniorDev — etapa 13.
- TA-R2-16 (confiabilidade de testes) — orçamentos de relógio e tempos limite fixos falham sob falta de CPU ou runner lento: NFR-29 ≤ 100 ms (112–167 ms sob ~3× carga), `expect.poll` de 1 s e limite de 5 s do Mermaid, limite padrão de 5 s do NFR-4 incluindo a criação de 2.020 arquivos (Windows no CI de `084f9c9`, tentativa 1). Mover as asserções de orçamento NFR para trás de uma variável de ambiente ou para um job de desempenho, e dar tempo limite explícito aos testes que criam muitos arquivos — SeniorDev / DevOps — etapa 13.
- ~~TA-R2-18 — `guarda da tarefa longa` em `note-title-parse.test.ts` com o limite padrão de 5 s para 5 parses completos de 442 KB (3,2 s na perna de cobertura do CI)~~ — **corrigido**: o `describe` inteiro tem limite explícito de 60 s e o teste usa uma nota de ~220 KB; a asserção continua relativa.
- ~~TA-R2-19 / R5-02 — testes sensíveis a carga: a guarda relativa de tempo do R4-01 (7 de 30 suítes embaralhadas), o "1.000 aliases ≤ 100 ms" (130 ms sob carga) e o `stateOf` do autocompletar (estado montado com a árvore parcial)~~ — **corrigido**: as duas asserções de tempo só rodam com `SIMPLEMD_PERF=1` (`packages/core/test/helpers/perf.ts`), e as propriedades seguem cobertas por testes determinísticos (trabalho de parse ≤ 2×, recusa pelo teto de aliases); `stateOf` publica a árvore completa (padrão de `b533ba5`), com teste de orçamento de parse esgotado. Falta um job de desempenho no CI que rode o portão — DevOps — etapa 13.

### Rodada 3 da QA r2 (app real, release `34ba2a6c…`)

- EC3-A11Y-1 (moderado, não bloqueante; já existia no r1) — no WKWebView todas as abas do editor informam `AXSelected=1` quando o foco está no editor. A marcação está correta (WAI-ARIA 1.2: um `aria-selected="true"` por lista), mas a heurística do WebKit (`AccessibilityObject::isTabItemSelected`) marca como selecionada toda aba cujo `aria-controls` aponta para um `tabpanel` com o foco dentro, e todas as abas apontam para o mesmo `#editor-panel`. Correção de ~2 linhas: `aria-controls` só na aba selecionada em `packages/ui/src/tabs/TabBar.tsx:114` e `packages/ui/src/sidepanel/SidePanel.tsx:106`, depois conferir com o VoiceOver — frontend / a11y — etapa 13.
- EC3-U-1 (UX) — dentro de `[[`, a fonte de palavras do documento lista a palavra ("bolo") **acima** da sugestão de nota ("Bolo de fubá · Receitas/bolo.md"). Dentro de um link de nota, mostrar só as notas, ou as notas primeiro — UX / frontend — etapa 13.
- EC3-V-1 (visual) — na janela padrão de 1280 pt com o painel lateral aberto, a lista de abas laterais rola na horizontal: aparece uma barra de rolagem e "Chat IA" fica cortada na borda direita — UIFinishGate / frontend — etapa 13.
- EC2-K-1 (recorrência) — cada binário reconstruído sem assinatura faz o macOS pedir de novo o acesso ao item do keychain (a ACL fica presa ao binário que criou o item). Resolver com a assinatura de código da etapa 13 (junto do item do `has_key` acima) — DevOps / backend — etapa 13.
- API I-8 (info) — a lista de modelos da Anthropic não traz o apelido sem data `claude-haiku-4-5` (só `claude-haiku-4-5-20251001`; o app usou o id com data), e `listModels` ignora `has_more` (um pedido com `limit=1000`; a lista gravada tem 12 ids e `has_more=false`). Seguir `has_more` se a lista crescer — SeniorDev — etapa 13.

### Carregar para o próximo run (fechamento do r2)

- G-01 (revisão, baixo) — `ExportMenu.tsx`: a busca do "próximo tabulável depois de Exportar" aceita `a[href]`/`button` com `tabindex="-1"` e não filtra elementos escondidos por CSS (`display:none`, `visibility:hidden`, tamanho zero). Hoje o próximo é "Comandos" (correto). Filtrar `el.tabIndex >= 0 && el.getClientRects().length > 0` — frontend — etapa 13.
- G-02 (revisão, observação de a11y/design) — as 12 fatias da pizza (`PIE_SLICE_MIXES`) vêm de uma família azul e cinza; casar legenda e fatia depende de passos pequenos de matiz e luminosidade. Aceite do desvio sob WCAG 1.4.1 com BrandGuardian/A11y (junto do A11Y-R2-06) — design / a11y — etapa 13.
- G-03 (revisão, nit) — `PropertiesPanel.tsx`: o nome acessível do botão corta o valor em 200 caracteres; o valor inteiro só está no `title` do span interno. Acrescentar `aria-description={row.full}` quando diferir — frontend — etapa 13.
- R5-01 (revisão, desempenho baixo) — `firstHeading1`: o bloco que cruza a borda da janela é analisado até o fim (o Lezer só confere `stopAt` entre blocos), então `lastChild.to > upto` vale para quase toda nota cujo primeiro H1 não está nos primeiros 4 KB, e as janelas de 16 KB e 64 KB nunca são usadas. Uma nota com o H1 entre ~4 KB e o fim custa um parse completo (o mesmo de antes do PERF-R2-01; sem regressão). Usar o fim do último bloco **completo** como base da próxima janela, ou só cair para o parse completo quando o bloco que passou for grande — core — etapa 13.
- R6-01 (revisão, nota de QA) — NÃO TESTADO: autocompletar com `activateOnTypingDelay` 0 durante composição por IME (japonês/CJK) e teclas mortas do português (`´`, `~`, `^`) no WKWebView e no WebView2. Nenhuma mudança de texto é possível (nada pré-selecionado, Enter não aceita), mas o popup pode abrir e fechar a cada atualização da composição. Conferência no app real pelo agente com GUI — QA (EvidenceCollector) — etapa 13.
- R6-02 (processo) — o commit `b0588b5` sozinho não passa (o teste já espera `COMPLETION_TYPING_DELAY_MS === 0`, que só `ca412ad` entrega); `git bisect` entre os dois precisa pular `b0588b5`. Próxima vez: mudança de teste e de constante no mesmo commit — SeniorDev — registro.
- A11Y-R5-01 (moderado, não bloqueante) — sem opção pré-selecionada, nada muda no elemento focado quando o popup abre (`aria-activedescendant` ausente, sem região viva no CodeMirror): um usuário de leitor de tela não fica sabendo que há sugestões (WCAG 4.1.3). Anunciar "N sugestões, ↓ para escolher" numa região viva educada ao abrir, ou equivalente; conferir com o VoiceOver — frontend / a11y — etapa 13.
- TA-R2-20 (confiabilidade de testes) — `toc.test.ts` ("h1, h2, h3, setext h2; exclui `# fake` …") falhou uma vez sob carga extrema por depender do orçamento de 25 ms do parse do sumário no produto; mesma classe do TA-R2-16/19. Montar o estado com a árvore completa (padrão de `b533ba5`) ou dar ao teste um orçamento explícito — SeniorDev — etapa 13.
- TA-R2-21 (baixo) — o contador de trabalho do R4-01 (`headingParseCounts`) fica no código do produto, então reverter `note.ts` inteiro só é pego pela guarda de tempo, que agora roda apenas com `SIMPLEMD_PERF=1`. Criar o job de desempenho no CI que rode o portão, ou um contador do lado do teste (parser instrumentado) — DevOps / SeniorDev — etapa 13.
- arch-ux F16, passos 2 e 3 (redação) — com `selectOnOpen: false` (R4-02), snippets (`/tab`) e notas (`[[bol`) também pedem ↓ antes de Enter. Emendar F16 para "Enter aceita só a opção ativada pelas setas; sem opção ativa, Enter quebra a linha", conforme o esclarecimento do PM sobre o R-8.6 (product r2, NFR-24) — UX — próxima iteração de design.
- NFR-24 opção (a) (opcional) — devolver a pré-seleção da primeira opção com uma guarda separada para o Enter (Enter logo depois de digitar quebra a linha), o que recuperaria o quadro a mais da p95. Se for feito, refazer o NFR-24 e o teste de regressão do R4-02 — core / UX — etapa 13 ou depois.
