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
- ~~No live preview: links clicáveis, estilo de código inline, caixas de seleção de listas de tarefas, tachado e citações (`>`) — ficam crus nesta fase (D-P1). Abrir URLs também exigiria permissões de shell/opener.~~ — **feito no r7** (I-1, PR #29 `bba3037`): links abrem com ⌘/Ctrl-clique pelo comando nativo `open_url` (SN, PR #25 `3723154`; nenhuma permissão `opener:*`/`shell:*`), caixas de tarefa clicáveis, tachado, código em linha e citações renderizados.
- No live preview: tabelas dentro de listas ou citações, títulos setext ~~, links de referência, autolinks e imagens~~ ficam crus (só tabelas de topo viram `<table>`). Markdown dentro de células de tabela aparece como texto literal no widget. — **parcial no r7** (I-1, PR #29 `bba3037`): links de referência (com definição), autolinks, URLs GFM e imagens da pasta agora são renderizados; continuam crus as tabelas dentro de listas/citações, os títulos setext e o Markdown (inclusive `[[wikilinks]]`) dentro das células do widget de tabela.
- Lembrar o último vault aberto entre execuções; várias janelas; vários vaults ao mesmo tempo.
- Orçamento de tamanho de bundle/instalador (revisitar na etapa 14, com o sidecar do Pandoc).
- Editor de temas: pedir confirmação antes de descartar um rascunho ao fechar (hoje o rascunho é descartado sem perguntar; decisão OQ-2).
- ~~Indentar listas com Tab dentro do editor. Tab não é capturado pelo CodeMirror para não prender o foco do teclado (WCAG 2.1.2).~~ — **feito no r7** (ST, PR #28 `71f9a5f`): chave opcional "Tecla Tab no editor" (desligada por padrão) com três saídas do editor (Ctrl+M/⌥⇧M, Esc e Tab, atalhos globais); `Mod-]`/`Mod-[` indentam o item com os subitens com ou sem a chave.
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
- Busca de texto completo no corpo das notas~~, backlinks e `[[wikilinks]]` clicáveis~~: o catálogo busca título/caminho/tags. — **backlinks e wikilinks clicáveis feitos no r7** (I-2, PR #32 `9189d33`: ⌘/Ctrl-clique, criação de nota, painel "Links"); a busca de texto completo continua fora.
- Snippets definidos pelo usuário e paradas de Tab em snippets: a v1 tem um conjunto fixo; navegar por paradas exigiria capturar Tab (WCAG 2.1.2) — com a chave opcional "Tecla Tab no editor" do r7 isso ficou possível, mas não foi feito para os snippets do autocompletar.
- ~~Renderizar HTML cru do Markdown (no editor ou na exportação): aparece e é exportado como texto literal; evita injeção de script no app durante a impressão (renderização sanitizada fica para depois).~~ — **feito no r7** (I-10, PR #31 `c5e9809`): política única com DOMPurify no editor e na exportação, AppSec G-SEC-2 aprovada.
- ~~Imagens embutidas na exportação HTML/PDF: ler arquivos que não são `.md` está fora do provider do vault, e `img-src 'self'` bloqueia URLs locais; o HTML mantém o `src` como escrito e o PDF mostra o texto alternativo.~~ — **feito no r7** (S1, PR #29 `bba3037`, D-24): `vault_read_image` no Rust, `img-src 'self' blob:`, imagens da pasta embutidas como `data:` no HTML (até 50 MB) e mostradas no PDF.
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
- ~~AS-05 — ações do CI fixadas por tag mutável, não por SHA~~ — **corrigido** na etapa 12a: todo `uses:` fixado pelo SHA de 40 hex do commit com a versão no comentário (`actions/checkout` v7.0.1, `pnpm/action-setup` v6.0.10 — a mesma que o `@v6` resolvia —, `actions/setup-node` v7.0.0, `Swatinem/rust-cache` v2.9.2, `actions/upload-artifact` v7.0.1); `dtolnay/rust-toolchain@stable` saiu (o rustup do runner lê `rust-toolchain.toml`); imagem do Semgrep por digest sha256; `check:security` reprova regressão. ~~Falta a parte do dono do repositório: `sha_pinning_required` e ações permitidas restritas nas configurações (junto com Secrets F-4, antes da etapa 13).~~ **Feito** no r3 (B-02): `sha_pinning_required: true` e `allowed_actions: selected` (as do GitHub + `pnpm/action-setup@*` e `Swatinem/rust-cache@*`, iguais aos `uses:` dos workflows).
- ~~AS-06 — `pnpm-workspace.yaml` sem `minimumReleaseAge`, `trustPolicy` e `blockExoticSubdeps`~~ — **corrigido** na etapa 12a: `minimumReleaseAge: 1440`, `trustPolicy: no-downgrade` (exceções revisadas `semver@6.3.1` e `undici-types@6.21.0`, só de desenvolvimento) e `blockExoticSubdeps: true`; o pnpm 12.8.1 confere o lockfile até no `--frozen-lockfile`. Pendente: subir `minimumReleaseAge` para 10080 (7 dias, o que a regra do Semgrep pede) a partir de 2026-10-13 — hoje 97 entradas do lockfile têm menos de 7 dias e a instalação quebraria; ao subir, tirar o `nosemgrep` da linha — DevOps — etapa 13. Continua pendente depois do r3 (B-09, bloqueado até 2026-10-13; o passo a passo está em `TAREFAS_PENDENTES.md`); o cooldown do Dependabot já é 7 dias.
- AS-07 — avisos RustSec só do Linux/GTK (RUSTSEC-2024-0370, RUSTSEC-2024-0429), transitivos do Tauri — **aceito** na etapa 12a com justificativa em `apps/desktop/src-tauri/.cargo/audit.toml` (avisos, não vulnerabilidades; `cargo tree -i` não mostra os crates em macOS nem Windows; no Linux vêm de tauri/tao/muda → gtk 0.18). Reavaliar quando o Tauri sair do gtk-rs 0.18.
- AS-08 — TOCTOU entre `stat` e leitura na importação de tema — **corrigido** no pré-requisito C3: `open_file_pick` checa o tamanho no arquivo aberto e lê no máximo teto + 1 bytes.
- AS-09 — leitura de `.md` sem teto de tamanho (só `config.json` e `theme.json` têm) — **aceito** na etapa 12 (status final, AppSec r2; r1 OQ-2): um plugin ativado já pode travar o app (item 4 de "PODE" em `docs/plugins.md`). Um teto com mensagem pode entrar na etapa 13.

### Segredos (Secrets)

- ~~Secrets F-1 — nenhum gate de varredura de segredos no CI nem em pre-commit (o gitleaks só roda à mão)~~ — **corrigido** na etapa 12a: job `secrets` com gitleaks 8.30.1 (binário com sha256 conferido) sobre o histórico inteiro (`fetch-depth: 0`, `gitleaks git`, `--redact`) em todo push e PR; falha com qualquer achado; `.gitleaksignore` com os falsos positivos revisados. Pre-commit continua opcional (não adotado). Torná-lo verificação obrigatória depende de Secrets F-4.
- ~~Secrets F-2 — ações do CI fixadas por tag, não por SHA~~ — **corrigido** na etapa 12a (mesma correção de AS-05).
- ~~Secrets F-3 — `actions/checkout` com `persist-credentials` padrão (`true`)~~ — **corrigido** na etapa 12a: os 7 checkouts têm `persist-credentials: false` (nenhum job usa git autenticado); `check:security` reprova regressão.
- ~~Secrets F-4 — `main` sem proteção de branch~~ — **corrigido**: proteção aplicada depois do r2 (PR obrigatório, 10 verificações obrigatórias incluindo `secrets`, `audit` e `semgrep`, strict, `enforce_admins`, histórico linear, sem force-push nem exclusão), conferida sem mudança no r3, que acrescentou `sha_pinning_required`, ações permitidas restritas e os rulesets de tag `v*` (B-02).
- Secrets F-5 — `target/` na raiz não está no `.gitignore` (só o do `src-tauri`) — **aceito** na etapa 12 (status final): não existe workspace Cargo na raiz, então nada é gerado ali; acrescentar a linha quando houver.
- ~~Secrets F-6 — falta um teste de que `config.json` nunca guarda chave~~ — **corrigido** na etapa 11: `apps/desktop/test/ai.test.ts` (AC-11.10 / AC-11.6, keychain falso) confere que a canária nunca chega ao `config.json` (Secrets r2 S2-07).
- ~~Secrets F-7 — trufflehog e osv-scanner indisponíveis (lacuna de ferramenta), NÃO TESTADO na etapa 12~~ — **corrigido** no r3 (B-05, PR #3): trufflehog 3.97.9 no job `secrets` (histórico inteiro, `--only-verified --fail`) e osv-scanner 2.6.0 no job `audit` (`pnpm-lock.yaml` e `Cargo.lock`; exceções em `osv-scanner.toml` só do AS-07), ambos com o sha256 do binário conferido; nada instalado no Mac.

### Revisão de código (QR)

- QR-01 — no editor de temas (L3), a faixa de status vazia ainda ocupa 8 px (o `gap` entre os dois contêineres de alerta vazios) — frontend — **feito na etapa 7** (sem `gap` na faixa; espaço só entre itens com conteúdo).
- QR-02 — a restauração de foco após o conflito sobre um diálogo (EC F-4) não tem teste automatizado (PW CNF-OVER-DIALOG para L2 e L3) — QA — fase 4 desta rodada (etapa 12 no máximo).
- QR-03 — `#sessionChoice` em `settings.ts` só é limpo em `reset()` e fica obsoleto após a primeira abertura (inalcançável hoje) — frontend — etapa 12 (revisar; vira bug só com um futuro "fechar pasta").
- QR-04 — `config.json` com BOM é aceito e a primeira gravação de preferência remove o BOM (intencional; `updateJsonFile` sempre reserializa) — backend — **feito** no pré-requisito C2 (documentado no comentário de `updateJsonFile`).
- ~~QR-05 — no editor de temas, a falha ao salvar é `role=alert` e recebe foco; alguns leitores de tela leem duas vezes~~ — **corrigido** no r3 (B-14, PR #2): a leitura dupla foi confirmada com o VoiceOver antes da correção (3/3); `te-save-error` perdeu o `role="alert"` e continua recebendo o foco; depois da correção o VoiceOver lê a mensagem uma vez.

### Acabamento de interface (UIF, rodada 2)

- R2-N1 — a 800×600, as Configurações sem pasta aberta transbordam 28 px; a linha de persistência aparece cortada acima do rodapé — frontend — etapa 6 (as Configurações ganham seções em abas). **Endereçado na etapa 6:** a linha foi para a faixa de status fixa do L2 (UX-R2-D8); a medida a 800×600 fica para a QA (fase 4).
- R2-N2 — a faixa de status vazia do L3 ocupa 8 px em todos os estados sem mensagem — frontend — **feito na etapa 7** (mesma correção de QR-01; 0 px medido no harness).

### DevOps (DO)

- ~~DO-1 — toolchains sem pin: CI compila com rustc 1.99 e localmente é 1.98.1; Node flutuante no CI, sem `.nvmrc`~~ — **corrigido** na etapa 12a: `rust-toolchain.toml` (`channel = "1.98.1"`, perfil mínimo + rustfmt/clippy; o CI roda `rustup toolchain install`) e `.node-version` (22.22.3, a mesma da máquina de referência; o Node só roda ferramentas de build e testes) lido pelo `actions/setup-node` em todos os jobs.
- ~~DO-2 — o CI não publica artefatos nem hashes~~ — **corrigido** no r3 (B-07, PRs #3 e #9): `desktop-build` publica `desktop-macos`/`desktop-windows` (binário, `dist-digest.txt` e `SHA256SUMS`; 30 dias) e o `release.yml` publica `SHA256SUMS` com atestado de proveniência. O hash do binário ainda depende do caminho do build: `--remap-path-prefix` adiado (Q8; ver "Run r3" abaixo).
- ~~DO-3 — atualizações automáticas desligadas (Dependabot de segurança desabilitado, sem `dependabot.yml`)~~ — **corrigido** no r3 (B-08, PRs #3 e #9): alertas e correções de segurança do Dependabot ligados e `.github/dependabot.yml` (npm, cargo e github-actions; semanal; cooldown de 7 dias; majors ignorados em npm e cargo).
- ~~DO-4 — o CI não roda `pnpm audit --prod`, `cargo audit` nem semgrep (NFR-15 só por QA manual)~~ — **corrigido** na etapa 12a: job `audit` (`pnpm audit --prod --audit-level high`; `cargo-audit` 0.22.2 com sha256 conferido, falha em vulnerabilidade) e job `semgrep` (1.179.0 por digest, `auto` + `p/typescript` + `p/react` + `p/rust` + `p/secrets`, `--error`; 4 exceções `nosemgrep` justificadas na linha: 3 usos só de teste/ferramenta de desenvolvimento em Rust e o `minimumReleaseAge` de AS-06). As regras vêm do registro do Semgrep na hora: uma regra nova pode reprovar o CI sem mudança no código.
  - Regras flutuantes: **resolvido** no r3 (B-18, PR #3). O job obrigatório `semgrep` usa as regras de `semgrep/semgrep-rules` fixadas num commit (tarball com sha256 conferido); as regras ao vivo do registro rodam no job semanal `semgrep-latest`, que não é obrigatório.
- ~~`pnpm audit --prod` acha 1 aviso **baixo** (GHSA-238p-pmpm-9mq7, katex < 0.18.2) pela cópia do `katex` 0.16.47 que o `mermaid` traz~~ — **corrigido** no r3 (APPSEC-R2-06, PR #3): `overrides: mermaid>katex: 0.19.0`; `pnpm audit --prod` → 0 avisos; um diagrama Mermaid com fórmula renderiza com o katex 0.19.0.
- ~~`pnpm/action-setup` v6.1.0 existe; o CI fixou a v6.0.10~~ — **feito** no r3 (B-08, PR #3): v6.1.0 fixada por SHA em todos os jobs.

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
- ~~`has_key` lê o segredo (num `Zeroizing`, descartado) só para saber se existe~~ — **corrigido** no r3 (B-01 preparo, PR #4): no macOS, `SecretStore::exists` faz uma consulta só de atributos (`SecItemCopyMatching` sem `kSecReturnData`); com as chaves reais, as Configurações → IA mostram "Chave salva" com 0 pedidos do keychain (AC-B01.3). No Windows, `get_attributes` do `keyring`. Resíduo: `delete_key` e `set_key` sobre um item existente ainda leem o segredo dentro do `keyring` no macOS (S3-02, abaixo).
- ~~Fixtures reais de OpenAI e Anthropic: aguardando as chaves do usuário~~ — **feito**: OpenAI (gpt-4o-mini) e Anthropic (claude-haiku-4-5) gravadas pelo `cargo run --example record_ai_fixtures` (pasta fora do repositório); 429/500 continuam sintéticas.
- Histórico do chat só na memória da sessão; confirmar antes de "Limpar conversa" fica para pedido de usuário (OQ-R2-2).
- Contexto da nota no chat (D-18 diz não por padrão): só como ação explícita e visível, se pedirem.
- Carregamento preguiçoso do pedaço de IA (arch-frontend §14.2): hoje entra no pacote principal; separar se o orçamento de bundle apertar.

## Etapa 10 — exportação: adiado e ideias

- ~~Imagens no HTML/PDF (embutir como `data:` ou copiar ao lado do arquivo): hoje o HTML mantém o `src` como escrito e o PDF mostra o texto alternativo (não-objetivo do run).~~ — **feito no r7** (S1, PR #29 `bba3037`; ver l.48).
- DOCX/ODT/EPUB/LaTeX e PDF por Pandoc: etapa 14 (sidecar com checksum).
- ~~HTML cru sanitizado (hoje sai como texto, D-15): só com um sanitizador revisado na etapa 12+.~~ — **feito no r7** (I-10, PR #31 `c5e9809`; supera D-15).
- Nome sugerido do PDF: o painel de impressão usa o título da janela ("simpleMD"); trocar o `document.title` pelo nome da nota durante a impressão se o WKWebView o usar como nome padrão (medir no SP-1).
- O aviso "Exportado para …" mostra só o nome do arquivo: o webview nunca recebe o caminho absoluto (gateway de salvar com token, arch-backend r2 §1.2).
- `@page { size: A4 }`: se o WKWebView ignorar o tamanho (SP-1, passo 3), o usuário escolhe A4 no painel — nota de UX, sem fallback em código. Desde o r4 (W-04, PR #15), no Chromium/WebView2 a impressão usa a página nomeada `smd-print` com margem 0 (o que tira o cabeçalho/rodapé do navegador) e os 20 mm vêm do padding; o WKWebView continua com o `@page` de antes.
- Visualização de impressão desmontada só na próxima exportação ou ao trocar de aba/pasta (a folha do WKWebView não avisa quando termina; arch-backend r2 A-3). Se o SP-1 mostrar que o WebKit tira um instantâneo ao abrir o painel, desmontar logo depois de `print()`.

## QA r2 (fase 4): achados adiados, com dono e etapa-alvo

- ~~APPSEC-R2-01 (Médio) — o webview tem canais de saída que a CSP não cobre: WebRTC (STUN/TURN, também DNS) e `<link rel=preconnect>`~~ — **corrigido no macOS** no r3 (B-06, PR #4): `_setPeerConnectionEnabled:NO` e o recurso `LinkPreconnect` desligado (seletores privados conferidos antes, sem travar); sonda (h) no release `9ac6b53c…`: `RTCPeerConnection` indefinido, 0 UDP (também de um iframe `about:blank`) e 0 TCP de `preconnect`. **No Windows, corrigido no r4** (W-01, PR #16): a `--force-webrtc-ip-handling-policy` do r3 não tinha efeito no WebView2 (F-WIN-01); agora `--webrtc-ip-handling-policy=disable_non_proxied_udp` e o proxy morto, medidos no app no reteste do r4 (0 UDP e 0 TCP; APPSEC-R3-02 abaixo). `docs/plugins.md` item 5 diz exatamente isso.
- ~~APPSEC-R2-02 (Baixo) — `set_key`/`delete_key` podem ser chamados por qualquer código no realm: um plugin troca a chave salva sem aviso~~ — **corrigido** no r3 (B-12, PR #4): diálogo nativo do Rust antes de todo `set_key`/`delete_key` (nomeia o provedor e a ação), Cancelar → `CANCELLED` (silencioso na interface), um diálogo por vez; conferido no app real com o usuário presente (AC-B12.3). Resíduo: APPSEC-R3-03 (abaixo).
- APPSEC-R2-03 (Baixo) — o consentimento cobre só os bytes do `main.js`; código carregado em tempo de execução (via `blob:`) não. **Documentado** em `docs/plugins.md` (Consentimento e CSP); sem mudança de código.
- ~~APPSEC-R2-05 (Baixo) — pasta pendente abandonada alcançável pelo próximo token `u32` sequencial~~ — **corrigido** no r3 (B-12, PR #4): tokens `u32` aleatórios por `getrandom`, ≠ 0 e diferentes do ativo e do pendente. Resíduo aceito: APPSEC-R3-08 (abaixo).
- APPSEC-R2-07 / APPSEC-R2-11 (Info) — **documentados** em `docs/plugins.md`: E/S fora da pasta só por escolha num diálogo do sistema; código e manifesto de plugins são só leitura pelo gateway.
- ~~APPSEC-R2-08 (Info) — `core:default` concede `core:menu:*`, `core:path:*` e `core:event:emit`~~ — **corrigido** no r3 (B-12, PR #4): a capability lista só `core:event:allow-listen`, `core:event:allow-unlisten`, `core:window:allow-destroy` e `core:webview:allow-print`, cada um com justificativa; `check:security` recusa `core:default` ou um `core:*` fora da lista; a permissão de alternar o devtools saiu (D-5).
- ~~APPSEC-R2-12 (Baixo) — a pós-checagem `isUnsafeRender` da exportação lê tags em texto e tem diferenciais de parser; CSS `url()`/`@import` não é checado~~ — **corrigido** no r3 (B-12, PR #4), junto do APPSEC-R2-09: a camada do app normaliza a saída dos renderizadores com `DOMParser` (documento inerte), confere o DOM, reserializa nó a nó e exige uma nova análise estável antes do `isUnsafeRender`, que também recusa CSS `url()`/`@import`; o HTML exportado tem a CSP `<meta>` `default-src 'none'; img-src * file:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'` (aprovada pela AppSec, D-6). Endurecimentos opcionais: APPSEC-R3-06, F-API-R3-01, CR3-B5…B7 (abaixo).
- F-R2-03 / F-R2-04 (UIF) — a lista de seções do L2 rola junto com o corpo e o diálogo muda de altura entre as seções: tirar a `tablist` de dentro de `.smd-dialog-body` e fixar a altura (`min(768px, 100vh − 32px)`) — frontend — próxima rodada de UI.
- F-R2-05 (UIF) — o texto do cartão C5 ignora a medida de 80ch a 1920. O corpo do C5 já usa a fonte mono (`.smd-ai-card-body`), mas no tamanho da UI (13 px); a medida do editor é `80ch` no tamanho do editor, então a coluna do cartão precisa de largura própria alinhada a `.cm-content` — frontend — próxima rodada de UI (etapa 13).
- F-R2-08 (UIF) — um aviso de 3 linhas cobre a linha de ações do C5 (R-6): deslocar a pilha de avisos acima do cartão ou dar altura mínima ao cartão — frontend/UX — próxima rodada de UI.
- F-R2-09 (UIF) — L2 "Aparência" a 800 px abre com "Ligaduras" meio escondida sob a faixa de status (dentro do DESIGN §12) — frontend — próxima rodada de UI.
- A11Y-R2-05 (axe `region`, moderado) — o invólucro do Radix do M1 aberto fica fora de landmarks; opcional — frontend — etapa 13.
- ~~A11Y-R2-06 (menor, consultivo) — no tema escuro, `pie1` e `pie2` diferem só 2,42:1 em luminância e a legenda liga nome e fatia só pela cor~~ — **corrigido em parte e resíduo aceito** no r3 (B-15, PR #2): as 12 receitas de `PIE_SLICE_MIXES` foram reordenadas (2,5,4,3,8,6,1,7,10,11,12,9; D-C1: o par (1,2) passou de 2,42 para 3,28:1 no escuro; ≥ 3:1 para todo par vizinho no escuro é inviável com os tokens atuais) e a pizza exportada ganhou `<title>` e `<desc>` com "rótulo: valor". Resíduo 1.4.1 aceito pela A11y: ver G-02 abaixo.
- UIF I-9 — a correção F-R2-06 encolhe os chips do catálogo cedo demais a 800 px (10 de 12 com "…", até `#horta`); o nome inteiro fica no `title` e no nome da opção. Opcional: mostrar um chip inteiro + "+N" quando dois não cabem — frontend — etapa 13.
- UIF I-10 — numa pizza com muitas fatias finas, o posicionamento padrão do Mermaid sobrepõe os menores percentuais ("3%1%"); comportamento da biblioteca. Junto dos avisos de marca P-3 (ordem das fatias) e P-4 (tamanhos de texto da pizza) — design / frontend — etapa 13.
- F-API-R2-03 (Baixa) — casos de borda da redação: (a) eco mascarado pelo provedor mantém até 4 caracteres finais; (b) `Bearer%20sk-…` codificado em URL não é redigido; (c) **quebra de paridade Rust↔TS**: `Bearer`+U+FEFF é redigido no TS (o `\s` do JS inclui U+FEFF) e não no Rust (`is_whitespace` não inclui); também passam `SK-ABC123`, `Bearer:abc123`, `sk_live_…`. Os corpos de erro reais também são redigidos pelo valor exato da chave no Rust. Alinhar `redact.rs`/`redact.ts` no que conta como espaço depois de `Bearer` — backend / SeniorDev — etapa 13.
- F-API-R2-04 (Baixa, produto) — a regra do filtro de `listModels` da OpenAI (README do `packages/ai`) ainda lista 18 ids que não servem `/v1/chat/completions` (`gpt-3.5-turbo-instruct*`, `*-codex*`, `*-pro*`, `o1-pro*`); escolher um dá "Erro do provedor: …" no chat. Ajustar a regra e o README — SeniorDev / produto — etapa 13.
- ~~Secrets S2-09 (info) — uma string **sintética** revisada chegou à `main` (`af21e99`) antes do gate~~ — **corrigido para a `main`**: `secrets` é verificação obrigatória antes do merge (Secrets F-4/B-02). Resíduo: um push para um branch de PR já é público antes do CI (S3-01, abaixo).

### Análise de testes r2 (TA-R2-xx)

- TA-R2-5 (produto, transitório) — calc e KaTeX decoram regiões que a árvore do Lezer ainda não alcançou (`shared/scan.ts` usa `syntaxTree(state)` sem limite), então chips aparecem dentro de código cercado até o parser chegar. Pular faixas além de `syntaxTree(state).length` / `syntaxTreeAvailable(state, to)` — SeniorDev — etapa 13.
- ~~TA-R2-6 — `roundtrip_real_keychain` devolve `ok` quando é pulado~~ — **corrigido** no r3 (B-11, PRs #3 e #4): `#[ignore]` com motivo; no macOS aparece `ignored`; no Windows roda com `--include-ignored --nocapture` e imprime a linha de confirmação (`roundtrip_real_keychain: OK — set/has/delete executados …`).
- ~~TA-R2-7 — o VT do NFR-27 é especificado na porta Node fs mas mede a porta em memória~~ — **corrigido** no r3 (B-10, PR #2): `TA-R2-7: NFR-27 na porta Node fs` com 2.000 notas reais numa pasta temporária, ≤ 3.000 ms, atrás do portão `SIMPLEMD_PERF` (roda no job `perf`).
- ~~TA-R2-8 (processo) — a checagem de deriva de `plugins-examples/calc/main.js` só roda no CI~~ — **corrigido** no r3 (B-10, PR #3): `pnpm lint` termina com `node scripts/build-plugin-example.mjs && git diff --exit-code plugins-examples/calc`.
- TA-R2-10 — a recusa de ponto de reparse no Windows (`FILE_FLAG_OPEN_REPARSE_POINT`) não tem teste Rust (os dois testes de link são `#[cfg(unix)]`; Windows roda 57 testes, macOS 59); teste de junção com `#[cfg(windows)]` — SeniorDev — etapa 13.
- TA-R2-11 — `e6acc0e` (guarda do `finished` da IA e foco do cartão) não ganhou VT; a metade do foco só tem PW fora do CI — SeniorDev — etapa 13.
- TA-R2-12 (processo) — a edição RG-3 do r1 `vault.contract.test.ts` não guardou original nem sha. Linha de base pós-AC-P.3 registrada: sha256 `d3e4350e3276ac4e24f60ad283273ac33850b6274c27e226bf21498c86d5973fa` — Main — feito (registro).
- TA-R2-14 — falta o VT do AC-6.17 para o mapeamento `role="alert"` de `notify(…, 'error')` de plugin (hoje só o prefixo e o nível) — SeniorDev — etapa 13.
- ~~TA-R2-16 (confiabilidade de testes) — orçamentos de relógio e tempos limite fixos falham sob falta de CPU ou runner lento~~ — **corrigido** no r3 (B-10, PRs #2 e #3): toda asserção de orçamento de relógio fica atrás de `SIMPLEMD_PERF` (as pernas `test` pulam 4 testes) e roda no job `perf`, não obrigatório; os testes que criam ≥ 1.000 arquivos têm limite explícito ≥ 30 s; as esperas do Mermaid subiram para 15 s.
- ~~TA-R2-18 — `guarda da tarefa longa` em `note-title-parse.test.ts` com o limite padrão de 5 s para 5 parses completos de 442 KB (3,2 s na perna de cobertura do CI)~~ — **corrigido**: o `describe` inteiro tem limite explícito de 60 s e o teste usa uma nota de ~220 KB; a asserção continua relativa.
- ~~TA-R2-19 / R5-02 — testes sensíveis a carga: a guarda relativa de tempo do R4-01 (7 de 30 suítes embaralhadas), o "1.000 aliases ≤ 100 ms" (130 ms sob carga) e o `stateOf` do autocompletar (estado montado com a árvore parcial)~~ — **corrigido**: as duas asserções de tempo só rodam com `SIMPLEMD_PERF=1` (`packages/core/test/helpers/perf.ts`), e as propriedades seguem cobertas por testes determinísticos (trabalho de parse ≤ 2×, recusa pelo teto de aliases); `stateOf` publica a árvore completa (padrão de `b533ba5`), com teste de orçamento de parse esgotado. ~~Falta um job de desempenho no CI que rode o portão.~~ O job `perf` existe desde o r3 (B-10, PR #3).

### Rodada 3 da QA r2 (app real, release `34ba2a6c…`)

- ~~EC3-A11Y-1 (moderado, não bloqueante; já existia no r1) — no WKWebView todas as abas do editor informam `AXSelected=1` quando o foco está no editor~~ — **corrigido** no r3 (B-14, PR #2): `aria-controls` só na aba selecionada (`TabBar.tsx`, `SidePanel.tsx`); no release `9ac6b53c…`, com o foco no editor, só a aba ativa tem `AXSelected=1`, com e sem VoiceOver.
- EC3-U-1 (UX) — dentro de `[[`, a fonte de palavras do documento lista a palavra ("bolo") **acima** da sugestão de nota ("Bolo de fubá · Receitas/bolo.md"). Dentro de um link de nota, mostrar só as notas, ou as notas primeiro — UX / frontend — etapa 13.
- ~~EC3-V-1 (visual) — na janela padrão de 1280 pt com o painel lateral aberto, a lista de abas laterais rola na horizontal: aparece uma barra de rolagem e "Chat IA" fica cortada na borda direita — UIFinishGate / frontend — etapa 13.~~ — **corrigido no r7** (S2, PR #32 `9189d33`, CF-R7-3): as abas laterais quebram a linha; no harness, 0 px de rolagem horizontal a 1280 e a 800×600 (a conferência na janela real do macOS é da Fase 4 do r7).
- EC2-K-1 (recorrência) — cada binário reconstruído sem assinatura faz o macOS pedir de novo o acesso ao item do keychain (a ACL fica presa ao binário que criou o item). Resolver com a assinatura de código da etapa 13 (junto do item do `has_key` acima) — DevOps / backend — etapa 13. Depois do r3: `has_key` não pede mais (consulta só de atributos); o primeiro `ai_send`, `set_key` e `delete_key` de um binário novo ainda pedem. Fecha com AC-B01.11 (B-01, `TAREFAS_PENDENTES.md`).
- API I-8 (info) — a lista de modelos da Anthropic não traz o apelido sem data `claude-haiku-4-5` (só `claude-haiku-4-5-20251001`; o app usou o id com data), e `listModels` ignora `has_more` (um pedido com `limit=1000`; a lista gravada tem 12 ids e `has_more=false`). Seguir `has_more` se a lista crescer — SeniorDev — etapa 13.

### Carregar para o próximo run (fechamento do r2)

- ~~G-01 (revisão, baixo) — `ExportMenu.tsx`: a busca do "próximo tabulável depois de Exportar" não filtrava `tabindex="-1"` nem elementos escondidos por CSS~~ — **corrigido** no r3 (B-15, PR #2): `isTabbable()` exige `tabIndex ≥ 0`, pula `[hidden]`/`[inert]`/`[aria-hidden]`, `:disabled`, `display:none` no elemento ou num ancestral e `visibility` diferente de `visible` (CR3-C3).
- ~~G-02 (revisão, observação de a11y/design) — as 12 fatias da pizza vêm de uma família azul e cinza; aceite do desvio sob WCAG 1.4.1 com BrandGuardian/A11y~~ — **feito** no r3 (B-15, PR #2): fatias reordenadas (D-C1) e `<title>`/`<desc>` na exportação; a A11y aceitou o resíduo. Resíduo registrado: para n ≥ 3, fatias vizinhas podem ficar abaixo de 3:1 (mínimo 1,23 no claro, 1,14 no escuro) e a legenda liga nome e fatia pela cor — "pizza: rótulos visíveis (`showData`/`<figcaption>`) ou paleta categórica (resíduo do A11Y-R2-06)" — design / a11y — próxima iteração de design (fora do design selado `design-0`). A aprovação do BrandGuardian não está coberta pelo aceite da A11y.
- ~~G-03 (revisão, nit) — `PropertiesPanel.tsx`: o nome acessível do botão corta o valor em 200 caracteres~~ — **corrigido** no r3 (B-15, PR #2): `aria-description` com o valor inteiro quando ele foi cortado. A fala do VoiceOver para o `aria-description` não foi testada (o AX mostra o `AXCustomContent`).
- ~~R5-01 (revisão, desempenho baixo) — `firstHeading1`: as janelas de 16 KB e 64 KB quase nunca eram usadas~~ — **corrigido** no r3 (B-15, PR #2): a próxima janela parte do fim do último bloco completo, e uma janela parcial só é tentada se `gasto + 2 × próxima ≤ tamanho do texto` (CR3-C1); limite documentado no JSDoc e em testes. Custo conhecido: CR3-C6 (abaixo).
- ~~R6-01 (revisão, nota de QA) — NÃO TESTADO: autocompletar durante composição por IME e teclas mortas~~ — **testado** no r3 no macOS (B-14): com o IME japonês (Romaji) o popup nunca cancelou a composição, Enter nunca aceitou uma sugestão e os bytes gravados são os do IME; teclas mortas (´ ~ ^ e Option-e/n/i, Brasileiro-Pro) dão os caracteres exatos. Achados novos: IME-ENTER-1 e IME-POP-1 (abaixo). No WebView2 continua NÃO TESTADO (AC-B14.9, B-03).
- R6-02 (processo) — o commit `b0588b5` sozinho não passa (o teste já espera `COMPLETION_TYPING_DELAY_MS === 0`, que só `ca412ad` entrega); `git bisect` entre os dois precisa pular `b0588b5` (`git bisect skip b0588b5`). Próxima vez: mudança de teste e de constante no mesmo commit — SeniorDev — registro. Desde o r3 isso fica evitado na `main` pelo fluxo de PR com squash: cada commit da `main` é a cabeça de um PR que passou nas 10 verificações (B-17). `b0588b5` e os outros commits do r2 empurrados em lote sem CI próprio (`ddeeac5`, `61b0e28`, `24da325`, `ef1fd79`, `55a81f6`) nunca devem ser alvo de rollback.
- ~~A11Y-R5-01 (moderado, não bloqueante) — sem opção pré-selecionada, o leitor de tela não fica sabendo que há sugestões~~ — **corrigido** no r3 (B-14, PR #2): uma região viva educada anuncia "N sugestões, ↓ para escolher" ("1 sugestão, …") 300 ms depois de o popup abrir ou de a contagem mudar; setas não reanunciam; desligar o autocompletar tira o anunciador. VoiceOver no release `9ac6b53c…`: falado uma vez por abertura. Resíduo: A11Y-R3-01 (abaixo).
- ~~TA-R2-20 (confiabilidade de testes) — `toc.test.ts` dependia do orçamento de 25 ms do parse do sumário no produto~~ — **corrigido** no r3 (B-15, PR #2): o estado é montado com a árvore completa (padrão de `b533ba5`); 30/30 suítes embaralhadas sob carga (média de 1 min 7,7–46,8) passaram.
- ~~TA-R2-21 (baixo) — o contador de trabalho do R4-01 só era pego pela guarda de tempo, que roda apenas com `SIMPLEMD_PERF=1`~~ — **corrigido** no r3 (B-10, PR #3): o job `perf` roda a suíte inteira com o portão, e o log mostra a guarda relativa do R4-01 e o "1.000 aliases ≤ 100 ms" executados. Promoção do job a verificação obrigatória: TA-R3-1 (abaixo).
- ~~arch-ux F16, passos 2 e 3 (redação) — emendar F16 para "Enter aceita só a opção ativada pelas setas; sem opção ativa, Enter quebra a linha"~~ — **feito** no r3 (B-15, AC-B15.7): a emenda está em `.nexus/runs/r3-backlog-b01-b19/ux-f16-amendment.md`; o `arch-ux.md` do r2 não foi editado. O comportamento é o do R4-02 (`selectOnOpen: false`), sem mudança.
- NFR-24 opção (a) (opcional) — devolver a pré-seleção da primeira opção com uma guarda separada para o Enter (Enter logo depois de digitar quebra a linha), o que recuperaria o quadro a mais da p95. Se for feito, refazer o NFR-24 e o teste de regressão do R4-02 — core / UX — etapa 13 ou depois. **Decisão do r3 (Q3): mantida registrada, não implementada.** O ganho é só um quadro na cauda da p95; o NFR-24 re-baselinado passa na cláusula da p95 (a da mediana falha por ≤ 2,15 ms, também no build do r2; ver PERF-R5-01 em "Run r3"); a opção reabre o caminho que o R4-02 fechou (Enter trocando texto que o usuário não escolheu) e invalidaria a emenda do F16; o A11Y-R5-01 foi resolvido pela região viva, sem pré-seleção. `host.ts` (`selectOnOpen: false`, atraso 0) e o teste do R4-02 não mudaram. Reavaliar se usuários relatarem atraso no popup ou se o NFR-24 re-baselinado falhar.

## Run r3 (backlog B-01…B-19): decisões, achados não bloqueantes e resíduos

Achados dos relatórios do run r3 (evidência local em `.nexus/runs/r3-backlog-b01-b19/`; PRs #2, #3, #4, #9 e #10). Nenhum é bloqueante. Cada item: ID — descrição — dono — alvo. Os itens ainda abertos que bloqueiam a assinatura ou a QA no Windows estão em `TAREFAS_PENDENTES.md` (etapa 13).

### Decisões registradas

- B-18 (Q1) — Semgrep: regras **fixadas** no job obrigatório (`semgrep/semgrep-rules` num commit, tarball com sha256 conferido, lista em `.github/semgrep-rules.txt`) mais o job `semgrep-latest` (semanal + `workflow_dispatch`, não obrigatório) com as regras ao vivo do registro, como sinal antecipado. Uma regra nova do registro não bloqueia mais o merge; quando o `semgrep-latest` acusar algo, corrigir ou acrescentar `nosemgrep` justificado num PR e, se for o caso, reposicionar a fixação. As regras são baixadas no CI e nunca entram no repositório (licença das regras) — DevOps + AppSec — contínuo.
- B-07 (Q8) — `--remap-path-prefix` (binários idênticos entre caminhos de build) **adiado**. Reavaliar depois que a assinatura do B-01 existir: comparar binários assinados, não os ad hoc — DevOps — depois do AC-B01.11.
- B-06 (D-1, D-2) — no Windows só a flag `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` (com os padrões do wry); o proxy morto (`--proxy-server=http://127.0.0.1:9 --proxy-bypass-list=<-loopback>`), que fechou TURN sobre TCP no Chromium, só entra se o experimento do protocolo do Windows mostrar que `ipc.localhost`/`tauri.localhost` continuam funcionando no WebView2 (`docs/qa/windows-protocol.md`). No macOS, o `preconnect` também foi desligado pelo recurso `LinkPreconnect`, conferido antes de usar — backend + AppSec — sessão do Windows (B-03). **Superado no r4:** a sessão do r3 mostrou que a flag não tinha efeito e que o app funciona com o proxy morto (§5.8 passo 1); o W-01 (PR #16) usa a `--webrtc-ip-handling-policy` e o proxy morto como argumentos nativos (Q1 do r4).
- B-12 (D-3) — o botão padrão (Return) do diálogo de confirmação da chave é a ação de confirmar ("Salvar chave"/"Remover chave"); aceito e documentado em `docs/plugins.md` (item 2). Ver MAC-K F-2 — backend / UX — reavaliar com F-1.
- B-15 (D-C1, D-C4) — AC-B15.3 emendado: ordem das fatias 2,5,4,3,8,6,1,7,10,11,12,9 (≥ 3:1 para todo par vizinho no escuro é inviável; pizzas de 2 fatias ≥ 3:1 nos dois temas); o `<title>` na raiz do SVG da pizza exportada mostra uma dica ao passar o mouse (aceito).
- B-02 (Q7) — `.github/CODEOWNERS` serve de pedido automático de revisão e de trilha de auditoria; `require_code_owner_reviews` continua `false`, porque com um único mantenedor e `enforce_admins` exigir a revisão travaria todo merge (S2-03 fica mitigado só em parte). Reavaliar quando houver um segundo mantenedor.
- B-08 — os PRs de major do Dependabot (#5–#8) foram fechados sem merge; `dependabot.yml` ignora majors em npm e cargo. Atenção (CR3-R4): o `ignore` vale também para os PRs de correção de segurança, então uma correção que exija major pode não vir como PR automático; os alertas do Dependabot e o osv-scanner (`audit`) continuam acusando. Atualizações de major entram por PR próprio, revisado — DevOps — quando necessário.
- NFR-24 opção (a), F16 e R6-02: ver "Carregar para o próximo run (fechamento do r2)" acima.

### Revisão de código r3 (CR3-xx)

Corrigidos antes do merge: CR3-C1…C4 (PR #2), CR3-B1 (PR #4; CR3-B2 fechado pelo rebase), CR3-A1, CR3-R2, CR3-R3, CR3-R4 e a primeira metade do CR3-R1 (PR #9), CR3-R6 (PR #10). CR3-S1 e a segunda metade do CR3-R1 são portões do AC-B01.11 em `TAREFAS_PENDENTES.md`.

- CR3-C5 (nota) — o portão do NFR-23 (`it.runIf(PERF_GATE)`) também pula a pré-condição `token.length ≤ CALC_MAX_LENGTH` do teste; é pré-condição do benchmark, e o comportamento do calc segue coberto pelos testes da tabela AC-7.7 — registro.
- CR3-C6 (desempenho, troca aceita) — R5-01: notas "pesadas de código" (um bloco grande que começa depois de 4 KB e passa da borda de uma janela, sem H1 antes) custam até ~2× um parse completo (contador) e +20–54 % de tempo contra `765b9c1`, que pulava direto para o parse completo. Fica dentro do envelope "≤ ~2× um parse completo" do R4-01, e o caminho (`extractNoteMeta`) é a indexação do catálogo e a exportação, não a tecla. Em troca, notas com o H1 no começo ou no meio ficaram bem mais rápidas — core / PerfBenchmarker (incluir esse formato na próxima medição do NFR-27) — próximo run.
- CR3-A2 (nit) — a regra "um `sha256sum -c` por `curl`" do `check:ci` é uma contagem de texto: uma conferência neutralizada (comentada) ainda conta. Endurecer: ignorar o texto depois de `#` e exigir `| sha256sum` na mesma linha lógica da referência `${…_SHA256}` — DevOps — opcional.
- CR3-A3 (nit) — `overrides: mermaid>katex: 0.19.0` é uma fixação exata que o Dependabot não move: ao subir o `katex` direto, subir o `overrides` junto, e tirá-lo quando o `mermaid` depender de `katex` ≥ 0.18.2 (ou acrescentar ao `check:ci` que os dois são iguais) — frontend / DevOps — a cada atualização do katex.
- CR3-A4 (nit) — o laço das regras do Semgrep no `ci.yml` (`while IFS= read -r rule`) pularia em silêncio uma última linha sem `\n` (hoje o arquivo termina com `\n`). Usar `while IFS= read -r rule || [ -n "$rule" ]` ou exigir a quebra final no `check:ci` — DevOps — opcional.
- CR3-A5 (nit) — a checagem de deriva do `calc` no `pnpm lint` não vê um arquivo novo não rastreado que o gerador venha a emitir e regrava a árvore local; `git status --porcelain plugins-examples/calc` vazio cobriria os dois casos — DevOps — opcional.
- CR3-B3 / APPSEC-R3-07 (nit) — `OneAtATime` só volta a "livre" no retorno normal; se o diálogo entrar em pânico (`blocking_show` → `rx.recv().unwrap()`), todo `set_key`/`delete_key` seguinte vira `CANCELLED`, escondido na interface, até reiniciar. Falha fechada, mas confusa. Usar uma guarda com `Drop` que sempre libera, ou `show()` com canal e canal fechado → `CANCELLED` — backend — opcional.
- CR3-B4 (nit) — a checagem do overlay de release no `check:security` limita as chaves de topo, mas não as de dentro de `bundle` (`windows.signCommand`, `resources`, `externalBin`, `macOS.frameworks` executam ou embarcam conteúdo no build). Lista de chaves permitidas para o `bundle` do overlay de release; junto disso, a checagem passa quando o overlay não existe (a presença é garantida pelo `release.yml`, não pelo `check:security`) — backend / DevOps — antes da primeira tag.
- CR3-B5 (nit) — o normalizador aplica a checagem de CSS a todo atributo, inclusive `aria-label`: `pie title Custo de url(x)` faz o diagrama inteiro sair como código. Pular `aria-*` ou limitar a checagem a `style` e aos atributos de apresentação do SVG — frontend (exportação) — opcional.
- CR3-B6 / APPSEC-R3-06 (info) — o normalizador aceita atributos que buscam recurso remoto fora de `URL_ATTRIBUTES` ou permitidos por `safeUrl('link')` (`srcset`, `ping`, `<image href=https>`, `<feImage>`, `<use href=https>`, `<video src/poster>`) e `<set>/<animate attributeName="on…">`. Nada executa (a CSP da exportação bloqueia handlers, `ping` e mídia; imagens remotas são permitidas pelo `img-src *` do D-6) e os renderizadores são internos. Recusar `attributeName` que comece com `on`/`href`/`xlink:href`, conferir `srcset`/`ping` e recusar URLs remotas em `image`/`feImage`/`use` e mídia; rodar a suíte adversarial da exportação também num motor real (Playwright) — frontend / AppSec — antes de aceitar saída de renderizador de plugins de terceiros.
- CR3-B7 (nit, defesa em profundidade) — depois do CR3-B1, a regra de CSS do `isUnsafeRender` do core só olha valores de atributo e `<style>`; duas cargas que o tokenizador do HTML lê diferente do regex do core (comentário que esconde uma tag; valor sem aspas com `"`) passam pelo core e são recusadas pelo normalizador DOM, que é a barreira de produção (todo caminho de exportação passa por `normalizeRenderers`). Em `765b9c1` as duas também passavam. Se o core for usado sem o normalizador, rever — core / exportação — registro.
- CR3-R5 (nit) — a varredura do Semgrep ainda pode ser neutralizada no texto (`… || true`, `continue-on-error: true`, `--exclude-rule`); são edições deliberadas, visíveis na revisão e cobertas pelo CODEOWNERS. Opcional: o `check:ci` recusar essas formas no job `semgrep` — DevOps — opcional.
- CR3-S2 (nit) — três lacunas das checagens literais dos passos fixados do `release.yml`: `git merge-base … origin/main || true`; a perna Windows com a mensagem mas sem `exit 1`; o passo de assinatura encadeando outros comandos (`tauri bundle … && node scripts/x.mjs`) e ainda recebendo os segredos. Exigir a linha exata do ancestral (com `exit 1; }`), `"; exit 1` na linha do Windows e o `run` exato `pnpm --filter @simplemd/desktop tauri bundle --config src-tauri/tauri.release.conf.json` no passo de assinatura — DevOps — antes de guardar segredos (com CR3-S1).

### AppSec r3 (APPSEC-R3-xx)

Veredito da AppSec r3: **PASS**, 0 bloqueantes. Corrigidos no PR #10: APPSEC-R3-01 (segredos de assinatura no passo inteiro do `tauri build`; agora só no passo `tauri bundle`) e APPSEC-R3-05 (o `check:ci` fixa o ancestral e o confinamento dos segredos). APPSEC-R3-04 é portão do AC-B01.11 em `TAREFAS_PENDENTES.md`; APPSEC-R3-06 e R3-07 estão acima (CR3-B6, CR3-B3).

- ~~APPSEC-R3-02 (Médio, resíduo do R2-01) — Windows: a flag bloqueia STUN/UDP, mas **TURN sobre TCP** para um host do atacante continua alcançável; o efeito no WebView2 está NÃO TESTADO~~ — **mitigado no r4** (W-01, PR #16): no reteste do r4 no app, 0 UDP de STUN e 0 TCP de TURN por TCP e de `preconnect`, com o controle A/B na mesma sessão. Na sessão do r3 a flag não fechava nem o STUN/UDP no WebView2 154 (F-WIN-01). Resíduos R-1, R-2 e R-4 em "Run r4" abaixo.
- APPSEC-R3-03 (Baixo, resíduo do R2-02) — o diálogo nomeia só o provedor e a ação. Um plugin ativado pode escutar o clique em "Salvar" (ou o Return) na fase de captura e chamar `set_key` com a chave dele na mesma hora: o pedido dele chega primeiro ao Rust e o usuário aprova esse diálogo; o do app encontra `OneAtATime` ocupado → `CANCELLED`, silencioso. [Inferência, não exercitado.] Ligar o diálogo ao valor (mostrar o final mascarado, "termina em …abcd", calculado no Rust) e devolver um código `BUSY` distinto que a interface mostre — backend / UX — próximo run.
- APPSEC-R3-08 (Info, aceito) — resíduo do R2-05: tokens `u32` aleatórios sem limite de tentativas erradas; um plugin ativado precisaria de ~2³¹ chamadas IPC em média para achar um token pendente abandonado [inferência: horas a dias], e um acerto é visível (troca a pasta e revoga a ativa). Aceito; alternativa `u64` exigiria mudar o tipo no JS — backend — registro.
- APPSEC-R3-09 (Info) — governança do repositório público: relato privado de vulnerabilidade desligado e sem `SECURITY.md`; validity checks e non-provider patterns do secret scanning desligados (recusa da API registrada no B-08); o revisor do Environment `release` é o único mantenedor (`prevent_self_review: false`); o CODEOWNERS não lista `scripts/assert-*.mjs`, `src-tauri/src/webview_net.rs`, `src-tauri/src/ai/keys.rs`, `Cargo.lock`, `pnpm-lock.yaml` nem `package.json`. Ligar o relato privado, acrescentar `SECURITY.md` e estender o CODEOWNERS — dono do repositório / DevOps — próximo run.
- APPSEC-R3-10 (Info) — job `semgrep`: (a) os arquivos de regra copiados não levam o aviso de licença, como a licença das regras pede para cópias (`cp "$src/LICENSE" "$dst/"`); (b) 5 IDs fixados diferem em caixa dos IDs do registro (nenhum `nosemgrep` afetado; um `nosemgrep` futuro para um deles tem de usar a caixa do ID local, por exemplo `…ncino.html.UseSRIForCDNs.…`); (c) o osv-scanner diz `unused ignores: RUSTSEC-2024-0429` porque reporta o alias GHSA, que também está ignorado (TA-R3-4; mantido para cobrir os dois IDs) — DevOps — opcional.

### Segredos r3 (S3-xx) e pendências antigas

Veredito do Secrets r3: **PASS**, 0 bloqueantes; nenhuma credencial real no histórico (inclusive refs de PR e commits órfãos), na árvore, nos 53 runs do CI, nos artefatos, no binário ou nos dados do app. Corrigidos: S2-01, S2-04, S2-09 (para a `main`), F-4, F-7 (no CI); S2-03 mitigado.

- S3-01 (não bloqueante) — o fluxo de PR controla o merge, não a publicação: todo commit empurrado fica público na hora e continua buscável por SHA (os 8 commits do r3 de branches apagados ou reescritos ainda são buscáveis; o GitHub guarda `refs/pull/*/head`). Uma chave real empurrada num branch de PR vazaria mesmo sem merge. Hook local `gitleaks git --pre-commit --staged` (fecha também S2-02) e, no roteiro de vazamento: **revogar no provedor primeiro** (apagar o branch não apaga o commit) — desenvolvedor — próximo run.
- S3-02 (não bloqueante) — no macOS, `delete_key` e `set_key` sobre um item existente leem o segredo para a memória do processo dentro do `keyring` (`SecKeychainFindGenericPassword` com dados; a liberação não diz se zera). O valor nunca é devolvido, registrado nem mostrado; em binários sem assinatura isso pode abrir o pedido do keychain (EC2-K-1). Opcional: apagar por consulta sem dados (`delete_generic_password`/`SecItemDelete`) e atualizar com `SecItemUpdate` — backend — com a assinatura (B-01).
- S3-03 (adiante; inerte, 0 segredos) — o mesmo do APPSEC-R3-01 (segredos no passo inteiro do build), corrigido no PR #10; o isolamento completo do passo de assinatura é o CR3-S1 (`TAREFAS_PENDENTES.md`).
- S3-04 (info, aceito) — o revisor do Environment `release` é o único admin, com `prevent_self_review: false`, e o mesmo admin é o único que cria tags `v*`: o revisor é uma pausa deliberada, não controle por duas pessoas. Reavaliar com um segundo mantenedor (mesma condição do Q7).
- S3-05 (info, aceito) — o trufflehog `--only-verified` chama as APIs dos provedores, a partir do runner, com cada candidato que achar, e só falha em achados verificados; chaves revogadas e formatos desconhecidos dependem do gitleaks, que roda antes e falha em qualquer achado.
- Continuam abertos (não bloqueantes): S2-02 (sem hook de pre-commit; ver S3-01), S2-05 (o 401 da OpenAI mostra os 4 caracteres finais mascarados pelo provedor), S2-06 (IDs de pedido nas fixtures), S2-08 parcial (Dependabot ligado; validity checks e non-provider patterns não ligam) e Secrets F-5 (aceito).
- PERF-R3-03 (info, efeito colateral escolhido pelo usuário) — na sessão de desempenho, o usuário respondeu "Sempre Permitir" aos pedidos do keychain: os itens `ai.openai` e `ai.anthropic` (serviço `io.github.devrafaelbrauner.simplemd`) agora deixam o binário de release sem assinatura `9ac6b53c…` ler as duas chaves sem perguntar (um binário novo pergunta de novo, EC2-K-1). Para desfazer: abrir o app **Acesso às Chaves**, abrir cada item, aba **Controle de Acesso**, tirar `simplemd` da lista "Sempre permitir acesso por estes aplicativos" e **Salvar Alterações** — usuário — quando quiser.

### Testes, CI e desempenho (TA-R3-xx, PERF-R3-xx)

- TA-R3-1 (regra de promoção do `perf`) — no push de `87aa61c` para a `main`, a guarda relativa de tempo do R4-01 passou só na nova tentativa (`(retry x1)`, 6.955 ms contra 1.489–3.730 ms nas outras 9 execuções verbosas); taxa de falha na primeira tentativa 1/10 (IC 95 % 1,8–40,4 %), e o Vitest não registra o erro da primeira tentativa quando a segunda passa. A regra de promoção ("≥ 20 execuções em ≥ 14 dias com 0 falhas de tempo → 11ª verificação obrigatória", dono DevOps) não diz se passar na nova tentativa conta como falha. **Esclarecimento proposto** (decisão do DevOps antes de promover): conta como falha de tempo — `(retry x1)` no log verboso do job `perf` é contado; com a taxa observada, a chance de 20 execuções limpas é ≈ 12 %, então a guarda do R4-01 precisa ficar mais estável antes da promoção — DevOps / SeniorDev — antes de promover o `perf`.
- TA-R3-2 (limitação) — a atualização de segurança do Dependabot para o `glib` (RUSTSEC-2024-0429, aceito como AS-07) falha em todo disparo com `security_update_not_possible` (o 0.18.5 vem preso pela árvore Tauri/GTK e a correção é 0.20.0) e aparece como execução vermelha de "Dependabot Updates" na `main`. Não é erro de configuração. O alerta #1 foi dispensado como `tolerable_risk` (AS-07, só Linux). Opcional: `ignore` do `glib` no `dependabot.yml` por PR revisado — DevOps — opcional.
- TA-R3-3 (texto desatualizado) — o cabeçalho de `packages/core/test/helpers/perf.ts` ainda diz que as asserções do portão "não rodam na suíte padrão nem no CI"; o job `perf` as roda no CI — SeniorDev — próximo PR que mexer nos testes.
- TA-R3-5 — fechado: AC-B07.3 (`SHA256SUMS` e atestado no `release.yml`) conferido depois do merge do PR #9.
- PERF-R3-01 (NFR-34 FAIL, "Should", não bloqueante) — com um stream real do Ollama no Chat IA, a latência da tecla no editor de 10 mil linhas, pela métrica do r1 (tecla → rAF), fica em p95 17/18/18 ms nas 3 rodadas (orçamento 16,7; máx 23/31/25 ms, dentro dos 50); parado, p95 9–10; com a máquina ocupada e sem stream, p95 12. A métrica depois do quadro dá o mesmo veredito (p95 19–20, máx ≤ 35). A primeira versão do relatório usou essa métrica para o veredito; a correção está em `perf-report.md` §9.5. [Inferência] O provável contribuinte é o layout forçado do auto-scroll do chat a cada publicação (PERF-R2-03, `ChatPanel.tsx:72`) mais a publicação por quadro; não foi perfilado (o build de release não tem devtools). Rolar só quando fixado no fim, em lote, ou `scrollIntoView` num sentinela; depois refazer o NFR-34 — frontend / PerfBenchmarker — próximo run (`ChatPanel.tsx` ficou fora do escopo deste run).
- PERF-R5-01, herdado do r2 (NFR-24 "Should", não bloqueante) — a cláusula re-baselinada "mediana ≤ 50 ms" falha na re-medição do r3 (harness, N = 20 por fonte por rodada, 4 rodadas, anunciador do A11Y-R5-01 ativo). Palavras ficam acima de 50 ms em 2/4 rodadas (50,2 e 50,7 ms) e trechos em 2/4 (51,0 e 52,15 ms). A p95 ≤ 67 ms passa (≤ 55,8 ms), e o `[[` e o novo filtro também passam. Não é regressão do r3: na mesma sessão e com a mesma carga (média de 1 min 4,9–6,4), o build do r2 (`ca412ad`) também falha a mediana em 1/2 rodadas (palavras 50,6 ms). O primeiro popup alterna entre 3 quadros (≈ 42 ms) e 4 quadros (≈ 54 ms), por causa do `selectOnOpen: false`, e com carga a mediana cai de um lado ou do outro de 50 ms. No r2, com carga 2,6–5,8, a mediana era 42 ms. Evidência: RUN r3 `perf-report.md` §9.1 e §9.3. Dono: PM (revisar a estatística e a sensibilidade da cláusula da mediana à carga) / frontend (NFR-24 opção (a), acima) — próximo run. Registro em `TAREFAS_PENDENTES.md` (item aberto no B-14).
- PERF-R3-02 (método) — o WKWebView não tem a entrada `longtask` e arredonda timers a 1 ms: tarefas longas no app real ficam NÃO MEDIDAS.
- PERF-R3-04 (info) — o `first-paint − first-byte` da OpenAI (9–15 ms) é maior que o da Anthropic (1 ms) [inferência: inclui o intervalo do provedor entre o primeiro evento SSE só com o papel e o primeiro com conteúdo]; bem dentro do orçamento.
- EC5-FLAKE-1 (testes) — PAL-ESC, PAL-RUN, XPT-MENU Home/End e AIC-REPLACE-CARD da suíte PW do r2 são instáveis por tempo de foco (reproduzem em `765b9c1`). Um `expect.poll` curto com a asserção inalterada — TestAnalyzer / EC — próximo run.
- EC5-RG-1 — fechado: o r2 `XPT-HTML-OFFLINE+AX-20` não conseguia injetar o axe com a CSP `<meta>` nova; adaptação de método aprovada (RG-R3-2-EC-1, axe por `page.evaluate`) e re-execução PASS (0 serious/critical).
- Testes que ainda dependem de tempo (mesma classe do TA-R2-20): `packages/ui/test/sidepanel.test.tsx:215-219` monta o estado com `EditorState.create` + `computeToc` (orçamento de 25 ms); `packages/plugins-internal/test/mermaid.test.ts:99-101` ("cache … Fim!") ainda usa o `expect.poll` padrão de 1 s — SeniorDev — próximo run.
- osv-scanner e o tarball das regras do Semgrep são riscos novos de disponibilidade nas verificações obrigatórias `audit` e `semgrep`: o osv-scanner consulta osv.dev/deps.dev na hora, e o sha256 do tarball do codeload pode mudar se o GitHub regenerar o arquivo (o job falha fechado; a correção é um PR que fixa de novo) — DevOps — quando acontecer.

### API, exportação e acessibilidade (F-API-R3-xx, A11Y-R3-xx)

- F-API-R3-01 (defesa em profundidade) — `<set attributeName="onmouseover" to="alert(1)"/>` dentro de um SVG passa pelo `normalizeRender` e pelo `isUnsafeRender` (nenhuma das camadas olha `attributeName`; `<animate>` provavelmente igual [inferência]). Mitigado: a CSP da exportação `default-src 'none'` cobre `script-src-attr` (0 execuções observadas pela AppSec), e a impressão no app roda sob a CSP do app. Correção junto do CR3-B6 / APPSEC-R3-06 — frontend / AppSec — opcional.
- I-R3-1 (info) — uma tag de renderizador sem fim (`<a href="javascript:alert(1)"`) normaliza para `""`, que o core aceita, e o bloco sai vazio em vez de cru. Inerte; só um renderizador interno com defeito produziria isso — exportação — registro.
- A11Y-R3-01 (menor) — a contagem de sugestões é anunciada de novo depois de cada pausa na digitação, mesmo sem mudar ("1 sugestão, ↓ para escolher" a cada pausa). [Inferência] Enquanto o CodeMirror consulta de novo, `currentCompletions` fica `[]` por um instante e o anunciador zera a última contagem. Correção: só zerar quando `completionStatus(state) === null` (popup fechado de verdade) e um VT "`par` + pausa, `a` + pausa, mesma contagem → 1 anúncio" — frontend / a11y — próximo run.
- A11Y-R2-05 (moderado) — sem mudança no r3 (axe `region` no popper do M1).
- EC5-UX-1 (baixo) — o `<title>` da pizza exportada lê "Diagrama Mermaid: pie title Itens" (o cabeçalho cru da fonte); "Itens" sozinho leria melhor — UX / frontend — próximo run.
- ~~EC3-V-1 — continua (abas laterais cortadas a 1280 com o painel aberto), conferido no release `9ac6b53c…`.~~ — **corrigido no r7** (ver l.236).

### App real (macOS): teclado, IME, VoiceOver e chaves

- IME-ENTER-1 (médio, já existia; não causado pelo autocompletar) — no WKWebView, depois de um commit do IME japonês convertido com Espaço, o Enter seguinte não insere nada (5/5 com o autocompletar ligado e desligado; 2/2 depois das correções). A quebra de linha some e as linhas se juntam no arquivo — frontend / core (composição do CodeMirror no WKWebView) — próximo run. **Não se reproduz no WebView2** (sessão do r3 no Windows: depois do commit "日本語" convertido com Espaço, o Enter seguinte quebra a linha), então é do WKWebView.
- IME-POP-1 (baixo, cosmético) — durante a conversão com Espaço, o popup do CodeMirror pode abrir sob a janela de candidatos do IME listando a própria palavra em composição (~2,2 s, 1 de 4 conversões). Opcional: não abrir o popup enquanto `view.composing` — frontend — opcional.
- VO-KS-1 (baixo) — o VoiceOver lê o `aria-keyshortcuts` ao pé da letra: "Shortcuts available: 'Meta+W Delete'" (`TabBar.tsx` `MOD_ARIA`); no Mac o usuário ouve "Meta" — a11y / UX — próximo run.
- VO-ECHO-1 (info) — digitar `a` depois de `p` no editor é falado como "seleção substituída pa" — a11y — registro.
- MAC-K F-1 (baixo, UX/a11y) — Esc não fecha o diálogo de confirmação da chave: o AppKit não reconhece "Cancelar" (pt-BR) como o botão de cancelar (`AXCancelButton` ausente), o que contradiz o comentário de `keys.rs` ("Esc ou fechar o diálogo = Cancelar"); quem usa teclado precisa ir com Tab até Cancelar. Definir o equivalente de Esc no "Cancelar" ou corrigir o comentário — backend / UX — próximo run.
- MAC-K F-2 (observação) — Return confirma ("Salvar chave"/"Remover chave" é o botão padrão) e a ordem dos botões muda entre os dois diálogos (layout do AppKit pelo tamanho do título). Aceito no D-3 (acima); reavaliar junto do F-1 se Cancelar deve ser o padrão — AppSec + UX — próximo run.
- MAC-K F-3 (observação, leitura de código) — uma falha do `has_key` (`refreshKeys` → `'unknown'`) aparece como "Sem chave", o mesmo texto de uma chave ausente (`AiSettings.tsx`); um `KEYCHAIN_DENIED` futuro pareceria "sem chave", sem erro. Não observado — frontend / UX — próximo run.
- Processo (MAC-K F-4, EC5-ENV-1) — com o usuário presente, um clique físico caiu num diálogo de confirmação: nas próximas sessões MAC-K, pedir antes ao usuário que não toque nos diálogos do app. Outro app (WezTerm, Claude) ficou na frente duas vezes durante a QA; a guarda de app em primeiro plano recusou as teclas — QA — próximas sessões com GUI.

### Implementação e ferramentas do processo

- A regra de CSS `fetchesCss` existe duas vezes: no nível de texto em `packages/core/src/export/escape.ts` e no nível do DOM em `apps/desktop/src/export/normalize.ts`. Exportar uma só do `@simplemd/core` exige mexer no `index.ts` do core — exportação — próximo run.
- ApiTester do r1 em worktrees: o `vitest.config.ts` resolve o projeto a partir da própria pasta (sempre testa o checkout do PROJECT, nunca o worktree) e `tauri-surface.test.ts` precisa de `gen/schemas/capabilities.json`, gerado pelo `cargo` — QA — próximos runs com worktrees.
- Ferramenta de snapshot do NEXUS (fora do repositório): ignora `*.lock` (mudanças no `Cargo.lock` ficam invisíveis; o revisor confere pelo `git diff`) e não respeita o `.gitignore` (acusou `apps/desktop/src-tauri/gen/schemas/capabilities.json`, gerado pelo `tauri build` e ignorado na linha 6 do `.gitignore`). Complemento usado no r3: conferir que `git diff 765b9c1..HEAD` ⊆ alvos ∪ criados — processo NEXUS — próximo run.

## Run r4 (correções do Windows, W-01…W-06): decisões, achados não bloqueantes e resíduos

Achados dos relatórios do run r4 (evidência local em `.nexus/runs/r4-windows-fixes/`, "RUN r4"; PRs #14, #15 e #16). Nenhum é bloqueante. Cada item: ID — descrição — dono — alvo.

### Decisões registradas

- Q1/W-01 — TURN por TCP e `preconnect` no Windows: **mitigados** com o proxy morto como argumento nativo do app (diagnóstico da AppSec medido no PC do usuário); Q2 (subir ao usuário se nada fechasse o STUN/UDP) não foi preciso.
- Q3/W-03 — a tecla alternativa é `Ctrl+Shift+Espaço` (`{ key: 'Mod-Shift-Space' }`, então o macOS fica com `⌘⇧Espaço`, já reservado para plugins). A STR-93 do r2 (`arch-ux.md:827`, protótipo `design-0`) fica **substituída** pela redação de `RUN r4/diag-w03.md` §6 ("Para sugerir na hora: Ctrl+Espaço ou Ctrl+Shift+Espaço." no Windows/Linux); os arquivos do r2 são referência só de leitura (CR4-W03-3).
- CR4-W03-1 — aceito como evidência do AC-W03.3 o teste T4 mais as sondas de keymap por plataforma da revisão: o tipo `Platform` da API de plugins é `'mac' | 'other'`, e `'other'` cobre Windows e Linux (não existe `'win'`). Falta um teste que percorra `EDITOR_KEY_BINDINGS`, o keymap do markdown e os atalhos globais e garanta que `Ctrl+Shift+Espaço`/`Ctrl+Espaço` só abrem as sugestões — SeniorDev — próximo PR que mexer nos atalhos.
- Q5 — a volta pela nuvem do OneDrive (AC-B03.5, passo 4) foi **adiada**: continua NÃO TESTADO (`TAREFAS_PENDENTES.md`); o roteiro já manda fechar a aba antes do `attrib +U -P` (P-08).
- W02-D1 — a espera pelas fontes antes do painel de impressão tem teto de 2.500 ms (`PRINT_FONTS_TIMEOUT_MS`); passado o teto, o painel abre sem as fontes, como antes.
- DEV-W04-1 — no AC-W04.1, o único token a mais nos PDFs do Windows (`n,`) é a junção por quebra de linha dos dois tokens que faltam (`,` e `n`); o conjunto de caracteres é igual ao do PDF do CI e nenhum token de cabeçalho ou rodapé sobra: PASS pela intenção do AC.
- RG-R4-2-A e RG-R4-2-B — adaptações das suítes de QA de runs anteriores, só em cópias dentro de RUN r4 (os originais não mudaram): a prova negativa do r3 `negative-proofs.sh:18` mira a linha `--force-…` que saiu, então a cópia troca a política por `default` e espera exit 1; o regex `/…|shell/` do r1 `tauri-surface.test.ts:164` casava a palavra `content_shell` em dois comentários do Rust (`webview_net.rs:7` e `:145`), então a cópia tira os comentários antes desse regex, com prova negativa. Alternativa do produto, não feita: reescrever os dois comentários sem `shell` (RG4-API-1, TA-R4-2) — QA / backend — opcional.

### Windows (sessões do r3 e do r4)

- F-WIN-03 (fato do ambiente) — no PC de teste (Windows 10 LTSC), `Ctrl+Espaço` não chega à página: as teclas de atalho de IME do IMM (`0x10` e `0x70`) estão em `Ctrl+Espaço` e consomem a tecla antes do WebView2 (r3 e r4, 3/3). Por isso o W-03 acrescentou `Ctrl+Shift+Espaço`. Não testado com o teclado físico do usuário (R7, opcional) — QA — próxima sessão no Windows, se o usuário quiser.
- F-WIN-04 (observação, UX/segurança) — no Windows, nos diálogos nativos de chave o botão com foco e padrão é a **confirmação** ("Salvar chave"/"Remover chave") e Esc cancela. No macOS, Esc não fecha o diálogo (MAC-K F-1) e Return também confirma (MAC-K F-2). Decidir junto do F-1/F-2 se Cancelar deve ser o padrão nas duas plataformas — backend / UX / AppSec — próximo run.
- OneDrive (observação do r3) — só listar uma pasta do OneDrive "Arquivos sob demanda" já baixa todas as notas só online, porque o índice do catálogo lê toda nota. Avaliar não ler (ou adiar) notas que são marcadores só online, para não baixar o vault inteiro ao abrir — vault / catálogo — depois da etapa 13.
- OBS-W03-R8 (info) — com o IME japonês (MS-IME) aberto, `Ctrl+Shift+Espaço` não abre o popup: o IME insere U+3000 (espaço ideográfico). Esperado (RK3: quem usa IME CJK desliga o IME para usar o atalho) — UX — registro.
- OBS-A11Y-R4-1 (baixo, info) — no app com WebView2 154 + NVDA 2026.2, NVDA+Espaço é recebido mas não anuncia troca de modo; a navegação por objeto lê a dica do atalho em 4 pedaços e a revisão de tela diz "em branco"; só a leitura contínua lê a dica numa fala só — a11y — próximo run (ver também A11Y-R4-01).
- OBS-A11Y-R4-2 (baixo, info) — depois de fechar as Configurações, o NVDA diz "desconhecido" (foco num elemento sem papel) entre dois "simpleMD documento", 5/5 — a11y / frontend — próximo run.
- INC-01 / INC-02 (lições de método da QA, sessão do r3) — no seletor de pasta, a busca por UI Automation `AutomationId=1` casou com um item de lista e entrou numa subpasta de Documentos (nada aberto nem capturado); no "Salvar como", o `WM_SETTEXT` foi ignorado e o 1º PDF foi para `Downloads`. Correções: achar os controles do diálogo por `GetDlgItem` e preencher o nome por `WM_CHAR` com leitura de volta (`WM_GETTEXT`). Registradas no protocolo (P-06) — QA — aplicado.
- NOTE-HARNESS-1 (método) — com o NVDA no modo de foco, o Esc da limpeza foi consumido pelo NVDA ("Esc volta ao modo de navegação") e o popup ficou aberto; artefato do método, não do app — QA — próximas sessões com NVDA.
- P-01…P-08 (protocolo) — aplicados neste run em `docs/qa/windows-protocol.md` (§8, revisão r4): argumentos externos do WebView2 se somam (P-01), receita `(WD,AD)` do QR-05 (P-02), status das sessões (P-03), sonda com os vetores do W-01 e controle A/B (P-04), matriz do PDF e destino "Salvar como PDF" (P-05), INC-01/INC-02 (P-06), critério 5 com a tecla alternativa (P-07), OneDrive com a aba fechada (P-08) — QA — aplicado.

### Kit de QA no Windows (fora do repositório)

- KIT-01…KIT-06 — corrigidos pelo DevOps no kit `simpleMD-windows-kit` e conferidos no reteste do r4: o preflight sem alteração termina com o WebView2 aberto (KIT-01), o `01-verify-and-install.ps1 -File` acha a pasta do kit sozinho (KIT-02), zips com nomes UTF-8 (`finanças`, KIT-03), o `listener.py` falha se a porta já está em uso (KIT-04), zip da evidência com `/` (KIT-05) e limpeza das pastas de dados do app criadas na sessão (KIT-06) — DevOps — feito.
- ~~KIT-07 (médio, kit) — `99-cleanup.ps1:157`: no Windows PowerShell 5.1, `ConvertFrom-Json` entrega o array JSON como um objeto só, então `appdata-before.json` nunca casava e uma pasta de dados do app **que já existia antes da sessão seria apagada** (cláusula do AC-W05.10 em FAIL no reteste; deu certo só porque as pastas não existiam)~~ — **corrigido no kit** pelo DevOps (RUN r4 `kit-fixes.md`, "KIT-07 (+ S-R4-02)"): `_common.ps1` ganhou `Read-JsonArray` (enumera cada elemento), `Get-PreExistingAppData` e `Remove-SessionAppData`, que mantém a pasta que já existia (PENDENTE) e apaga só a criada pela sessão; a etapa 12b do `99-cleanup` usa essas funções e o log mostra quantas e quais pastas já existiam. A mesma leitura errada em `languages-before.json` também foi corrigida. Ensaio no PC com as funções reais e pastas de teste em `%TEMP%\smd-win-kit07` (as pastas reais do app nunca foram passadas): caso A (uma pasta já existia → mantida; a outra, criada na sessão → apagada), caso B (as duas já existiam → as duas mantidas), caso C (sem `appdata-before.json` → as duas apagadas). Os 14 `.ps1` do kit foram analisados no Windows com 0 erros. **Falta** rodar o `99-cleanup -Phase Final` inteiro numa sessão real — DevOps / QA — próxima sessão no Windows.
- KIT-OBS-1 (kit) — o `00-preflight -HelpersDir` calcula o hash da pasta de ajudantes numa seção só; um arquivo travado (`job.log`) apagou a seção inteira na sessão do r3. Calcular arquivo por arquivo — DevOps — próxima mudança no kit.
- S-R4-02 (baixo, kit) — a entrada do `authorized_keys` da sessão não tinha `from="<IP do Mac>"`/`restrict`, e o `sshd_config` não tem `PasswordAuthentication no`; só a regra do firewall limitava o IP. **Endurecido no kit** (`10-habilitar-ssh.ps1`, ainda não executado): a chave entra como `from="<IP do Mac>" ssh-ed25519 …`, aceita só a partir do Mac além da regra do firewall; uma linha antiga `smd-winqa` sem `from=` é trocada, nunca duplicada, e o `-Remover` continua tirando toda linha `smd-winqa`. O script **não** muda o `sshd_config`: no fim ele mostra o `PasswordAuthentication` configurado e avisa se não for `no` (o padrão do OpenSSH é `yes`); o cabeçalho documenta o passo manual de administrador (`PasswordAuthentication no` antes de qualquer bloco `Match`, reiniciar o sshd e desfazer no fim), que fica para a decisão do usuário. `restrict` não foi acrescentado, para não mudar o comportamento de sessão/pty sem teste — DevOps / usuário — próxima vez que o SSH de QA for ligado.
- A cópia do protocolo dentro do kit (`vm/docs/windows-protocol.md`) tem de ser igual byte a byte à do repositório (AC-W05.12): recopiar depois de cada mudança no protocolo — DevOps — a cada sessão.

### Revisão de código r4 (CR4-xx)

Corrigidos antes do merge: CR4-W0204-1 (atraso das fontes no e2e reduzido para 0,8 s; PR #15), CR4-W01-1 e CR4-W01-2 (portão sobre o código sem comentários e corte ancorado no `mod tests`) e CR4-W01-3 (redação do item 5; PR #16).

- CR4-W03-2 (nit) — o teste T1 roda só na plataforma `"key"` do CodeMirror (o `navigator.platform` do jsdom é vazio); "`Ctrl+Shift+Espaço` não faz nada no macOS" e "funciona em `win`" vêm da construção e das sondas da revisão. Um arquivo de teste separado, com a plataforma fixada no carregamento, tornaria o AC-W03.7 uma asserção do CI — SeniorDev — opcional.
- CR4-W0204-2 (nit) — a chave de fonte de `print-fonts.ts` não inclui `font-stretch` nem `font-variant`; nem o KaTeX nem o app usam. Usar o atalho `font` calculado se um plugin precisar — exportação — se aparecer o caso.
- CR4-W0204-3 (nit) — a varredura síncrona da árvore (`getComputedStyle` por nó de texto) roda antes do teto de 2,5 s: 5, 45 e 137 ms para 2.000, 20.000 e 60.000 nós de texto no Chromium — exportação — registro.
- CR4-W0204-4 (nit) — o construtor do `ExportController` grava `document.documentElement.dataset.printEngine` (efeito global, idempotente). Um `markPrintEngine()` chamado na partida deixaria a classe sem efeito colateral — frontend — opcional.
- CR4-W01-4 / AS-R4-02 (info, limite inerente) — um portão de texto não sabe qual `cfg` compila: manter a chamada certa sob `#[cfg(any())]` e a errada sob `#[cfg(windows)]` passa no `check:security` e nos testes Rust. Defesa durável proposta: **checagem do binário** no `desktop-build (windows-latest)`, ao lado do `assert-no-ai-recorder`, exigindo que o `simplemd.exe` de release contenha a string exata de `WEBVIEW2_ARGS` (no binário de `d4fe923` ela aparece 1 vez; a de dev isolada 0 vezes; `--force-` 0 vezes) — DevOps / AppSec — próximo PR que mexer no CI ou no portão.
- AS-R4-01 (baixo) — uma segunda chamada a `additional_browser_args(...)` **substitui** os argumentos endurecidos (o método do Tauri é um _replace_), e o `check:security`, os testes Rust e a checagem do binário não percebem. Portão **SG-3** proposto pela AppSec (`RUN r4/appsec-report.md` §3.3): `additional_browser_args(` uma única vez em `src-tauri/src` (sem comentários nem testes) e nada encadeado entre `webview_net::harden(builder)` e `.build()?`, com duas provas negativas em `tauri-security.test.ts` — backend / AppSec — próximo PR que mexer no portão.
- IMP-W01-1 (cosmético) — o comentário de seção `// ---- APPSEC-R2-01 (B-06): …` em `check-tauri-security.mjs` podia citar o W-01 — backend — opcional.
- IMP-W01-2 — o regex de `WEBVIEW2_ARGS` no portão exige o valor na mesma linha do `=`, e o de dev aceita quebra; se o rustfmt quebrar `WEBVIEW2_ARGS`, o portão falha fechado (acusa todo token ausente). Aceitar `=\s*"` nos dois — backend — opcional.
- IMP-W01-4 — o caminho de dev no Windows (`tauri dev`, sem o proxy) não foi rodado; que o proxy morto quebraria o servidor de dev e o HMR é inferência do diagnóstico. Conferir na próxima vez que alguém desenvolver no Windows — backend — quando houver.
- `PW_PORT` — `playwright.ci.config.ts` fixa a porta 4174 com `reuseExistingServer: !CI`; com vários agentes ou worktrees, uma execução local pode testar outro build sem aviso. Uma variável de ambiente para a porta evitaria isso — QA / DevOps — opcional.
- `pnpm check:ci` não existe como script da raiz (o `IMPL-CONTEXT` do r4 o cita); a checagem do CI roda dentro de `pnpm check:security`. Corrigir os textos de processo ou acrescentar o script — processo — próximo run.
- RK4 (W-03) — o app não tem tela com a lista de atalhos nem `aria-keyshortcuts` no `.cm-content`, então quem precisa da segunda tecla só a acha em Configurações — UX — escopo novo.

### AppSec r4 (AS-R4-xx) e resíduos do W-01

Veredito da AppSec r4: **PASS** (0 Crítico, 0 Alto, 0 Médio, 1 Baixo, 4 Info). AS-R4-01 e AS-R4-02 estão acima.

- AS-R4-03 (info, documentação) — a redação do resíduo R-4 cobria só "recebe os pedidos com o nome do host". Aplicada no r4 em `docs/plugins.md` (item 5) e no "Adendo r4" de `docs/seguranca/etapa-12.md`: um programa local de qualquer usuário que escute em `127.0.0.1:9` pode também repassar os pedidos, reabrindo TURN por TCP e `preconnect` — AppSec — feito.
- AS-R4-04 (info, já existia) — um plugin aprovado pode tomar o `Ctrl+Shift+Espaço` (como qualquer atalho embutido) com `registerEditorExtension` e um keymap próprio com `Prec.highest`, porque o compartimento de plugins vem antes do de sugestões. Dentro do modelo de confiança dos plugins; para atalhos que não possam ser tomados, filtrar as facetas de keymap das extensões de plugin ou pôr o keymap embutido antes de `#plugins` — design — escopo novo.
- AS-R4-05 / R-1 (médio latente) — se uma versão nova do WebView2 deixar de ler `--webrtc-ip-handling-policy`, STUN/UDP volta sem aviso (TCP e DNS continuam fechados). O app não consegue ler a política efetiva; a detecção é externa: harness do motor (K0 com tráfego, K-final 0) e sonda do app com controle A/B em **toda** sessão de QA no Windows, com a versão do WebView2 registrada — QA / AppSec — cada sessão no Windows.
- R-2 (baixo) — `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` ou a política `AdditionalBrowserArguments` se somam aos argumentos do app e o último vale; precisam de código rodando como o usuário. Documentado; o preflight confere que estão ausentes — AppSec — registro.
- R-4 (baixo) — porta 9 no loopback (ver AS-R4-03). O preflight da QA exige a porta 9 livre — AppSec — registro.
- R-3, R-5, R-6 (info) — o proxy corta também o tráfego de fundo do WebView2 (positivo para a privacidade); a ausência de DNS para o nome de um servidor STUN vem do código do Chromium, não de medição direta (opcional: um passo com pktmon/ETW na próxima sessão); duas versões do app com argumentos diferentes na mesma pasta de dados falhariam ao criar o ambiente do WebView2 [inferência] — AppSec — registro.
- TURN por TLS (`turns:`) não é afirmado como fechado (DOC-3): mesmo caminho de socket do proxy [inferência], sem medição. Opcional: um vetor `turns:` na próxima sonda — AppSec / QA — próxima sessão no Windows.

### Segredos r4 (S-R4-xx) e incidente

Veredito do Secrets r4: **PASS** (diff, histórico, CI, evidência do r3 e do reteste do r4).

- S-R4-01 (baixo, operacional, aberto) — a chave `~/.ssh/smd-winqa` é ED25519 **sem senha** e dá acesso de administrador ao PC pessoal do usuário (`administrators_authorized_keys`). Depois do reteste: o usuário roda `10-habilitar-ssh.ps1 -Remover`, o Main apaga `~/.ssh/smd-winqa*` no Mac e confere que o `authorized_keys` não tem mais a chave (`TAREFAS_PENDENTES.md`, run r4) — usuário + Main — agora.
- S-R4-03 (info, já existia) — sem hook local de pre-commit para segredos; só o portão do CI (mesmo de S2-02/S3-01) — desenvolvedor — opcional.
- S-R4-04 (info, aceito) — `env.txt` e `remote-analysis.txt` guardam o inventário da máquina que o protocolo pede (placa, CPU/RAM, tipo de conta, adaptadores de rede, DNS da LAN, IPs do Tailscale), sem e-mail, número de série nem IP público. Manter fora de qualquer publicação — QA — registro.
- S-R4-06 (info) — no macOS, a folha "Salvar como PDF" preenche o Autor com o nome completo da conta do macOS (está nos PDFs `qa/mac/pdf/r4-print-*.pdf` e nas capturas, junto do nome da impressora padrão da rede). É do sistema, não do app (os PDFs do WebView2 não têm Autor). Se o produto quiser PDFs anônimos, é escopo novo — produto — registro.
- S-R4-07 (info, aceito) — `mac-side/ssh-out/final2.out` lista os pontos de restauração do PC, um deles com o nome de um software do usuário (nível de inventário, como S-R4-04) — QA — registro.
- INC-SEC-R4-1 (incidente do agente de segredos, para ciência do usuário) — a varredura de material de chave no Windows percorreu todo o `C:\DevTemp` (o `%TEMP%` do usuário), e não só `C:\DevTemp\smd-win-*`, e passou por uma pasta de projeto pessoal do usuário (nome omitido) e por um checkout do simpleMD. O conteúdo só foi comparado na memória, no Windows; nada foi copiado, aberto, nem gravado na evidência ou em relatório. Uma primeira tentativa sem limite estourou o tempo e deixou um `powershell.exe` remoto, que o próprio agente identificou e encerrou. Somente leitura; nenhum estado do sistema mudou. Lição: limitar varreduras remotas a `C:\DevTemp\smd-win-*`, `%USERPROFILE%\.ssh` e `C:\ProgramData\ssh`, com teto de tempo — QA / Secrets — próximas sessões (informar o usuário).

### Testes, CI e acessibilidade (TA-R4-xx, A11Y-R4-xx, macOS)

- TA-R4-1 (tendência, já existia; TA-R3-1) — a guarda relativa de tempo do R4-01 precisou de `retry x1` em 3 de 11 execuções do `perf` no r4 (IC 95 % de Wilson 9,7–56,6 %; r3 + r4 juntos 4/32 = 12,5 %). O r4 não mexe no parser, e as 3 caíram numa janela de 10 minutos com execuções concorrentes. Com essa taxa, a chance de 20 execuções limpas é ≈ 6,9 %, então a regra de promoção do `perf` a verificação obrigatória quase não se cumpre se passar na nova tentativa contar como falha. Decidir a regra (TA-R3-1) e/ou estabilizar a guarda — DevOps / SeniorDev — antes de promover o `perf`.
- TA-R4-2 — ver RG-R4-2-B nas decisões (comentários com `content_shell`). As próximas cópias de suítes de QA devem tirar os comentários antes de procurar por palavras no Rust, como o `check-tauri-security.mjs` já faz — QA — próximos runs.
- TA-R4-3 (já existia) — o r2 EC `PLG-INACTIVE+…+PLG-ACTIVE` estoura o tempo na execução completa com 4 workers nesta máquina (2/2 em `d4fe923` e 2/2 no controle `569ef72`) e passa 3/3 sozinho; XPT-MENU Home/End e PAL-OPEN são as instabilidades de foco já registradas no r3. Pôr na lista de instáveis conhecidos e rodar esse spec com `workers: 1` ou espera do foco, com as asserções iguais — QA — próxima cópia da suíte.
- TA-R4-4 (info) — o r3 `negative-proofs.sh:41` muda o `release.yml` **pelo número da linha** (`107s`); desde o A3 do r3 a linha 107 é outra, e a prova ainda dá exit 1 por coincidência. Usar `sed` ancorado em padrão nas próximas cópias — AppSec / QA — próxima cópia.
- TA-R4-5 (info) — o tempo total do CI na `main` passou da referência do r3 (803, 926 e 592 s contra ≤ 687 s) por fila do `desktop-build (macos-latest)` atrás de PRs concorrentes (607/610/312 s); cada job continua dentro do NFR-40. Serializar os pushes de PR se o tempo total importar — DevOps — registro.
- TA-R4-6 (info) — o PR #16 teve 2 execuções vermelhas do `semgrep` (`detect-non-literal-regexp` em `check-tauri-security.mjs:237`), corrigidas antes do merge: o portão funcionou — registro.
- A11Y-R4-01 (menor, já existia) — a 800×600 a dica do atalho fica abaixo da área visível das Configurações → "Autocompletar" quando o foco está no último controle, e nenhum `aria-describedby` a liga a um controle, então quem navega por Tab num leitor de tela não a ouve (justamente no modo "Só pelo atalho"). Correção sugerida: `id` na dica e `aria-describedby` no seletor "Quando sugerir" (`AutocompleteSection.tsx`), ou a dica logo abaixo dele — frontend / a11y — próximo run.
- macOS O-2 (info) — a primeira impressão num vault novo levou 1.457 ms da tecla ao painel (as outras, 730–800 ms; NFR-32 ≤ 4.000 ms) e a marca `simplemd:export-print` agora sai depois da espera das fontes do W-02 (150–580 ms, contra 127 ms no r3), como desenhado — registro.
- macOS O-3 (baixo, a confirmar) — `AXPress` no botão "Exportar" (Radix) não abriu o menu; foco + Return abriu. Um VO-Espaço do VoiceOver talvez não abra o menu [inferência, não testado com VoiceOver]; não é mudança do r4 — a11y — próximo run (conferir com VoiceOver).
- macOS O-4 (info) — o painel de impressão do macOS fica em inglês com o app em pt-BR (idioma do sistema) — registro.
- Método macOS (O-1, M-1…M-3) — agentes no mesmo Mac precisam de dono para as portas da sonda (uma sonda de outro agente caiu no listener); as opções da paleta agora aparecem como `<Plugin>: <comando>`, então ferramentas do r3 que procuram só o título do comando recusam; o `shot.sh` do r3 grava na pasta de evidência do r3; o `api.vault.write` da sonda devolve `CONFLICT` se o arquivo de resultado já existe — QA — próximas sessões no macOS.
- API r4 (I-R4-1, I-R4-2; info, sem ação) — duas linhas do `check:ci` que davam exit 0 no r3 agora dão exit 1 (o `check:ci` ficou mais estrito); a crate de emulação de IPC da QA ainda avisa `dropping_copy_types` (artefato do teste) — registro.
- IMP-W01-3 — textos que ainda descreviam a flag do r3 como atual (`docs/qa/windows-protocol.md`, `docs/seguranca/etapa-12.md`, `MELHORIAS.md`) foram atualizados neste PR de docs; a entrada antiga do `CHANGELOG.md` fica como histórico — feito.

## Run r5 (pré-lançamento v0.1.0 sem assinatura): decisões, achados não bloqueantes e resíduos

Evidência em `.nexus/runs/r5-prerelease-v0.1.0/` ("RUN r5"). PR #18 (`a0b60b2`) e o PR das notas observadas. Os portões de publicação (relato privado de vulnerabilidades, 2FA, PRs #19/#20) estão em `TAREFAS_PENDENTES.md` › Run r5.

### Decisões registradas

- Só Apple Silicon (`aarch64`) no macOS: o runner `macos-latest` é arm64 e não há Mac Intel para QA. Build universal/Intel adiado: precisa de `rustup target add x86_64-apple-darwin`, `--target universal-apple-darwin`, caminhos novos no `release.yml` e no `assert-no-ai-recorder`, e um Mac Intel para testar — DevOps — quando houver usuário Intel.
- Só o instalador NSIS (`-setup.exe`, por usuário, sem UAC) é publicado no Windows. O `.msi` continua sendo gerado e conferido na lista exata do `publish-unsigned`, mas não sobe (decisão do r5, AS-R5-S03): instala para a máquina toda e pede elevação [inferência: a QA não instalou o `.msi`; o rótulo do UAC para um pacote sem assinatura não foi observado]; reavaliar no release assinado — produto.
- Selo ad-hoc (`APPLE_SIGNING_IDENTITY: '-'`) só no `tauri bundle` do `bundle-dry-run`: o SPIKE-1 mostrou que sem ele o `.dmg` baixado dá "danificado" e com ele dá "não pôde verificar" → "Abrir Mesmo Assim" (RUN r5 `qa/mac-r5/report.md` §2).
- O release assinado sai como `v0.1.1` ou depois (a tag `v0.1.0` é imutável).
- Releases imutáveis (AS-R5-S01) continuam desligados: ligar é mudança de configuração, decisão do usuário; se ligado, acrescentar `gh release verify`/`verify-asset` às notas — usuário / DevOps.

### Revisão de código r5 (CR5-xx)

- CR5-S1, CR5-S2, N2, N4 e N6 — corrigidos no PR #18. CR5-S3 (a) textos das notas observados na QA e (b) cópia das notas no RUN pelo `body` do rascunho, e N5 (data do `CHANGELOG.md`) — corrigidos no PR das notas observadas. CR5-S3 (c), ligar o relato privado de vulnerabilidades, continua como portão aberto em `TAREFAS_PENDENTES.md` › Run r5.
- N1 (info) — o `REPO_CODE` do `check:ci` também lê o texto das notas (o heredoc fica no mesmo `run` da lista): palavras como `node`, `git`, `bash`, `sh` ou `./` no texto fazem o portão falhar (fecha para o lado seguro). Opcional: tirar o corpo do heredoc antes de aplicar a regra — DevOps — quando as notas mudarem.
- N3 (info) — o nome do artefato no upload e no download não é conferido estaticamente; se divergir, o job falha no download (fecha para o lado seguro) — registro.
- N7 (info) — as notas não dizem que os logs do GitHub Actions expiram; a seção "Origem" aponta para o log das somas — produto — opcional.
- N8 (processo) — disparar o `release.yml` na tag uma vez só: a segunda execução no mesmo grupo de `concurrency` cancela a pendente; resolver antes a revisão da execução do push da tag — DevOps — na publicação.
- N9 (cosmético) — a mensagem do C8 no `check:ci` ainda diz "3 nos artefatos" e não fala da lista por perna — DevOps — próxima mudança do portão.
- N10 (baixo) — se o navegador renomear o arquivo baixado (`simpleMD_0.1.0_aarch64 (1).dmg`) ou o `SHA256SUMS`, as linhas de conferência imprimem erro, `False` ou nada, o que as notas já tratam como "não confere". Acrescentar "use os nomes originais dos arquivos" — produto — próxima versão das notas.

### AppSec r5 (AS-R5-REV-xx, AS-R5-QA-xx, AS-R5-Sxx)

- AS-R5-REV-01/02/03 — corrigidos no PR #18 (downloads em pastas separadas, linhas do macOS do `require-signing-secrets` fixadas, conferência que imprime `OK`/`True`).
- AS-R5-REV-04 (info) — no macOS, o `assert-no-ai-recorder` lê `target/release/simplemd` (antes da assinatura); o Mach-O publicado é a cópia reassinada dentro do `.app` (só o bloco da assinatura muda; a AppSec conferiu a cópia publicada: 0 marcadores). Apontar o assert também para `bundle/macos/simpleMD.app/Contents/MacOS/simplemd` — DevOps — próxima mudança do `release.yml`.
- AS-R5-REV-05 (info) — `syspolicy_check` dá "Notary Ticket Missing" como Fatal e `spctl` dá `rejected`: esperado sem notarização; só a GUI prova "não pôde verificar" (provado no r5) — registro.
- AS-R5-REV-06 / AS-R5-S07 (opcional) — `package-manager-cache: false` no `actions/setup-node` do `release.yml`, para o cache automático do npm nunca entrar se o gerenciador mudar — DevOps.
- AS-R5-QA-03 (doc) — o caminho manual do `scope.md` R-08 (1)/AC-R08.1 e o "4 assets / each of 3" do `diag-release.md` V7 (RUN r5) ficaram velhos frente ao desenho escolhido (2 instaladores + `SHA256SUMS`, `publish-unsigned`) — registro no RUN.
- AS-R5-QA-04 (info) — "aprovar" (V5) ou "rejeitar" (M16) a execução condenada do `bundle-release` no push da tag: as duas servem; aprovar só logo depois de ler 0 segredos — DevOps — na publicação.
- AS-R5-QA-05 (info) — a cópia das notas no RUN só vale depois de comparada com o `body` do rascunho (AC-R04.7) — DevOps — na publicação.
- AS-R5-S04/S05 (opcional) — anexar o bundle da atestação (`.sigstore.json`) ao release e atestar também o `SHA256SUMS` — DevOps — release assinado.
- AS-R5-S06 — a QA conferiu à mão, no `simplemd.exe` publicado, os argumentos do W-01 ×1 e `--force-…` ×0; não há passo automático no `release.yml` — DevOps — opcional.
- AS-R5-S08 — no `TAREFAS_PENDENTES.md` (portões do B-01).
- AS-R5-S10 (opcional) — tag anotada e assinada (`git tag -s`) — usuário.

### Testes, API e segredos (TA-R5-xx, I-R5-xx, SEC-R5-xx)

- TA-R5-1 (higiene da suíte de QA) — a prova do r3 "pull_request no release.yml" (`negative-proofs.sh`) ancora em `^  workflow_dispatch: {}` e virou no-op desde o input `unsigned_prerelease`; o portão continua recusando a mutação (suplemento com a âncora certa: exit 1). Ancorar as próximas cópias em padrão estável — AppSec / QA — próxima cópia.
- TA-R5-2 (info) — a troca de versão quebrou 2 asserções do r4 e 1 do r3 além da prevista (RG-R5-2-B/C aprovadas). Em trocas de versão futuras, listar antes toda asserção de QA que fixa bytes de `tauri.conf.json`/`Cargo.*` — QA — próxima troca de versão.
- TA-R5-3 — PRs em rascunho #19/#20 do Copilot: fechar antes da tag (`TAREFAS_PENDENTES.md`).
- I-R5-1 (texto de AC) — o AC-R07.1 espera "exceção de escrita release.yml#publish"; a saída agora é o plural com o `publish-unsigned` (desenho aprovado) — registro.
- I-R5-2 (info) — a linha "[release binary]" do r1 lê o binário local da época do r4, não o do r5; os bytes publicados são os do dry-run — registro.
- I-R5-3 (info) — o `check:ci` aceita qualquer subconjunto de contents/id-token/attestations: write e tolera `required: false` no input; a suíte do r5 fixa a igualdade exata — DevOps — opcional (apertar o portão).
- I-R5-4 (ferramenta) — `rsync --files-from` não copia pastas vazias (`src/{ai,vault}`), o que quebrou a primeira emulação Rust da QA — QA — registro.
- SEC-R5-01 (texto de AC) — os 3 `***` de cada perna do dry-run são o `GITHUB_TOKEN` efêmero do job mascarado pelo GitHub (entradas `token` padrão do `checkout`/`setup-node`), não um segredo do repositório; o AC-R02.7 deve dizer "nenhum segredo do repositório/Environment" — registro.
- SEC-R5-02 — a cópia das notas no RUN tem de vir do `body` do rascunho (igual ao AS-R5-QA-05).
- SEC-R5-03 (baixo, já existia) — o trufflehog do CI roda com `--only-verified`, e os non-provider patterns/validity checks do secret scanning estão desligados (a API não liga, B-08) — Secrets — registro.
- SEC-R5-04 (info) — a evidência do RUN fica fora do git (`.gitignore` `.nexus/`) e tem falsos positivos conhecidos do gitleaks (mapas de sha256, a linha do marcador do gravador, fixtures curtas `sk-proj-` da ApiTester); nunca publicar as fixtures da QA; refazer a varredura AC-R07.9 na evidência final — Secrets — antes do portão.

### QA dos instaladores no macOS (RUN r5 `qa/mac-r5/report.md`)

- I-1 (estado do usuário) — a permissão de Automação "WezTerm" → "Finder" ficou dada (pedido levantado por um `osascript` da QA); o usuário pode revogar em Privacidade e Segurança → Automação — usuário — opcional.
- I-2 (estado do usuário) — a permissão de Rede Local do simpleMD ficou dada na primeira impressão; o macOS a guarda depois de apagar o app — usuário — opcional.
- I-3 (info) — o macOS guarda a intenção do usuário ("Abrir Mesmo Assim") para o cdhash testado — registro.
- 5.6 (baixo, já existia) — menus do app misturam inglês e português («About simpleMD», «Undo», «Copy» ao lado de «Sair do simpleMD», «Editar»); o painel de impressão fica em inglês — produto / interface — próxima etapa de interface.
- NFR-32 no app instalado: 1 medição a frio (1 042 ms; o r4 teve 5) — QA — próximo run com o app instalado.
- M-1 (método) — a primeira abertura usou `open` (LaunchServices), não um duplo clique no Finder: o `open` do Finder por AppleScript no `.dmg` em quarentena falhou com "(null) não tem permissão" (artefato do harness). M-2 — a remoção foi `rm -rf` em vez de Lixo (mesmo estado final). M-3 — a quarentena do Tier 1 foi gravada com `xattr` sem linha no QuarantineEventsV2, então a linha de procedência ("baixado em…") só aparece no Tier 2 (download real pelo Safari). M-4 — as ferramentas do r4 foram adaptadas ao app empacotado (nome "simpleMD") — QA — próximos runs.

### QA dos instaladores no Windows (RUN r5 `qa/windows-r5/report.md`; desvio D1, Windows 10 LTSC)

- WIN-R5-01 ("editor desconhecido" nas notas) e WIN-R5-03 (atalho na Área de Trabalho e "Run simpleMD" marcados por padrão no fim da instalação) — corrigidos nas notas no PR das notas observadas.
- ~~WIN-R5-02 (baixo–médio) — os metadados instalados dizem `Publisher = github` (Uninstall do HKCU) e `CompanyName = github` no `simplemd.exe`, e a chave fica em `HKCU\Software\github\simpleMD` (padrão do Tauri a partir do segundo elemento do identificador, sem `bundle.publisher`). "github" pode ser lido como GitHub Inc.~~ — **corrigido antes da tag (RC-R5-04, decisão do usuário):** `bundle.publisher: "Rafael Brauner"` no `tauri.conf.json`. Isso muda os bytes dos instaladores; o dry-run de prova e a conferência dos metadados estão no RUN r5 (`impl-a.md` §12).
- WIN-R5-04 (baixo) — depois de desinstalar pelas Configurações, o desinstalador NSIS deixa `%TEMP%\~nsuN.tmp\Un.exe` [inferência: sem elevação não agenda a remoção no reboot] — DevOps — registro.
- WIN-R5-05 / D5 — **varredura do Defender NÃO TESTADA**: no PC de QA o antivírus ativo é o Kaspersky (Defender passivo, `MpCmdRun` exit 2). Substituto: Kaspersky 21.26 com 0 detecções no instalador e na pasta instalada. Para ter a prova do Defender é preciso outra máquina — QA / usuário — antes do release assinado.
- D6 (método) — "abrir pelo menu Iniciar" foi o `explorer.exe` no atalho do menu, não um clique; NOTE-HARNESS-R5-1 (`SendMessage(BM_CLICK)` no NSIS não volta; usar `PostMessage(WM_COMMAND)`) e NOTE-HARNESS-R5-2 (o SmartScreen roda em `CHXSmartScreen.exe`) — QA — kit.
- KIT-07 — o `99-cleanup -Phase Final` rodou inteiro na sessão do r5 (exit 0), o que fecha a verificação de ponta a ponta pendente do r4 — feito.
- Não testado no r5: Windows 11 e o Controle Inteligente de Aplicativos, download real por navegador (Tier 2) e as páginas InstFiles/"Uninstallation Complete" — QA — release assinado.

### Publicador do Windows (PR #22) e portão de release (RC-R5-xx, CR N15–N17, AS-R5-PR22-xx)

- RC-R5-04 / WIN-R5-02 — corrigido no PR #22 (ver acima); conferido no registro do Windows na instalação do rascunho (`Publisher` = "Rafael Brauner", `HKCU\Software\Rafael Brauner\simpleMD`, nada de `github`) — feito.
- RC-R5-05 — **fechado**: o `-setup.exe` publicado foi instalado no Windows antes da publicação (rascunho, mesmos bytes do release; RUN r5 `qa/windows-r5-draft/report.md`) — feito.
- N15 — os efeitos no registro, que eram inferência do script NSIS, foram observados nessa instalação — feito.
- N16 / AS-R5-PR22-03 (opcional) — nenhum portão fixa `bundle.publisher`: apagar a linha volta o "github" (padrão do identificador) e outro valor passaria sem aviso. Fixar `bundle.publisher === "Rafael Brauner"` no `check-tauri-security.mjs`, com prova negativa — DevOps / AppSec — release assinado.
- N17 / AS-R5-PR22-01 — manter o editor estável: o NSIS acha a instalação existente pela chave `HKCU\Software\<editor>` e o WiX pelo `Manufacturer`, então o `v0.1.1` assinado tem de manter "Rafael Brauner", e o titular do certificado Authenticode deve bater com ele (ou o `bundle.publisher` muda junto, com teste de atualização a partir do 0.1.0). Hoje o nome é metadado declarado, sem verificação — DevOps / produto — release assinado.
- AS-R5-PR22-02 (ferramenta de QA) — um job de QA do RUN procurava só `HKCU:\Software\github`; jobs e kit futuros usam a busca genérica `simplemd|devrafaelbrauner|Rafael Brauner` — QA — kit.
- RC-R5-02 (médio, já existia; não é regressão do r5) — na captura do macOS, os blocos `$$ … $$` de várias linhas aparecem como código no editor com o cursor longe deles; no Windows e no PDF do Mac eles renderizam — QA / editor — investigar no próximo run de editor.
- RC-R5-03 (processo) — passos de runbook velhos em documentos do RUN r5 (`appsec-report` §6, `scope` R-08, `diag` V7) que não valem mais; o runbook válido é o Δ1.5 do `reality-report` — registro.
- RC-R5-06 (privacidade, baixo) — a evidência do RUN tem o caminho de perfil do Windows com o nome real do usuário; o RUN fica fora do git e nunca deve ser anexado nem publicado — QA — registro.

### QA no release publicado (Tier 2; RUN r5 `qa/tier2-mac/report.md`, `qa/tier2-win/report.md`)

- **macOS F-1 (macOS, não do produto)** — no primeiro "Abrir Mesmo Assim", o painel de senha/Touch ID ficou fora da tela e o `syspolicyd` travou a avaliação: cada nova abertura do app ficava suspensa ("o app não abre"). Matar o `coreautha` não resolveu; o usuário saiu com `sudo killall syspolicyd` e depois "Abrir Mesmo Assim" + senha funcionou (`Allowing code due to user override`). Esse comando é a única saída observada e não vai para as notas. Os mesmos bytes abriram normalmente no Tier 1, então é intermitente [inferência: cliques repetidos em "Abrir Mesmo Assim" nos dois avisos enquanto a autenticação começava]. As notas e o README agora dizem: clicar uma vez só em cada aviso, concluir a senha sem trocar de janela e, se travar, forçar o encerramento (⌥⌘Esc) e reiniciar o Mac, "o que deve resolver" [inferência: o reinício recria o `syspolicyd` como o comando observado, mas não foi testado] — feito neste PR; confirmar o reinício se o travamento se repetir — QA.
- macOS O-1 / Windows F-1 — `gh attestation verify` no `SHA256SUMS` dá 404 (só os dois instaladores são sujeitos da atestação), e o comando só imprime `✓ Verification succeeded!` num terminal (com a saída redirecionada não imprime nada, com exit 0). As notas agora dizem "o `.dmg` ou o `-setup.exe`" e a saída esperada — feito neste PR.
- macOS O-2 (info) — no macOS 27.2 as linhas do QuarantineEventsV2 do Safari têm as colunas de URL vazias; a URL fica só no `kMDItemWhereFroms` — registro.
- macOS O-3 (método) — o terminal da QA não tem acesso a `~/Downloads` (TCC); o `cd ~/Downloads` das notas foi testado depois, com o usuário presente — QA — registro.
- macOS O-4 — o fluxo tem **dois** avisos: "O Item simpleMD Não Foi Aberto" na primeira abertura e, depois de "Abrir Mesmo Assim" nos Ajustes, "Abrir o Item simpleMD?" [Mover para o Lixo][Abrir Mesmo Assim][OK], de novo com "Mover para o Lixo" como botão destacado. As notas agora citam o segundo aviso — feito neste PR.
- macOS O-5 (info) — nenhum aviso real mostrou a linha "baixado em…" (dúvida do Tier 1 resolvida) — registro.
- macOS O-6 — o pedido de rede local na primeira impressão não foi exercitado no Tier 2 (NÃO TESTADO) — registro.
- Windows F-2 (baixo, já existia) — o `-setup.exe` não tem `CompanyName` nem `LegalCopyright` nas propriedades do arquivo (o modelo NSIS do Tauri não preenche); o editor aparece só no registro e no `simplemd.exe`. Ver junto com o Authenticode — DevOps — release assinado.
- Windows F-3 (protocolo de QA) — a varredura padrão do Kaspersky usa cache (2 objetos em vez de 14); evidência de antivírus neste PC usa `/iChecker=off /iSwift=off` — QA — kit.
- Windows F-4 (info) — os contadores de download do release incluem os downloads da QA — registro.
- Método Windows (M-1, M-2) — a marca da web (MotW) foi simulada, não escrita por navegador, e o SmartScreen não foi exercitado no Tier 2 (foi no rascunho, mesmos bytes) — registro.

### Kit de QA no Windows: incidente do r5

- **INC-R5D-01** — na instalação do rascunho, o Kaspersky (System Watcher) marcou como `PDM:Trojan.Win32.Generic` o `runner.ps1` do kit de QA (não o produto), encerrou o processo, fez uma cópia de backup e apagou o arquivo [inferência do gatilho: o job do assistente compila C# que abre o token de outro processo e manda mensagens para as janelas dele]. O instalador e a pasta instalada deram 0 detecções. A QA parou, sem tentar contornar o antivírus; o resto da instalação foi feito pelo usuário à mão. Sessões futuras no Windows: exclusão do Kaspersky para `%USERPROFILE%\smd-kit` com consentimento do usuário e reversão no fim, ou instalador conduzido à mão. O usuário apaga a cópia de backup (`TAREFAS_PENDENTES.md`) — QA / usuário.
- OBS-R5D-1 (info, L-1) — o Kaspersky põe o instalador, o app e o desinstalador sem assinatura no grupo "Baixa restrição"; o app funciona normalmente — registro.

## Run r7 (plugins adaptados, I-1…I-10): não-objetivos, achados não bloqueantes e resíduos

Evidência em `.nexus/runs/r7-plugins-adaptados/` ("RUN r7"). Itens fechados pelo r7 estão riscados acima (l.18, l.19 parcial, l.23, l.45 parcial, l.47, l.48, l.189, l.191 e EC3-V-1). Abaixo, só o que ficou aberto, com o ID da revisão de origem; os achados corrigidos dentro de cada PR estão nos relatórios do RUN e no `CHANGELOG.md`.

### Não-objetivos do r7 (product r7 §0; cada um é um "não" deliberado)

- Transclusão/embeds `![[nota]]` e `![[imagem.png]]` (D-37): `![[…]]` fica texto cru.
- Atualizar links ao renomear/mover notas (renomear/mover não existe no app, Q-3 do r1); painel de links de saída; "menções não ligadas"; voltar/avançar na navegação entre notas.
- Correções automáticas ("Corrigir") do lint (D-29): o lint só mostra.
- LanguageTool remoto (`api.languagetool.org`, Premium) ou Harper (U-2: só local) — sem revisitar.
- `dataviewjs`, JS em linha `$=` e funções JS em snippets LaTeX: a CSP não tem `'unsafe-eval'` e o código viria de notas sincronizadas — nunca (risco).
- DQL completo (FLATTEN, CALENDAR, campos em linha `chave::`, biblioteca de funções) e recorrências além do subconjunto (D-35/D-36, Q-R7-3): o resto mostra um erro nomeado.
- Conceal, prévia flutuante de fórmula e colorização de colchetes do latex-suite (D-33): o KaTeX já renderiza, e o conceal briga com o "revelar sob o cursor".
- Callouts `> [!note]`, imagens com largura `![alt|300](x)` e imagens remotas (remotas continuam texto, U-4).
- Paradas de Tab nos snippets do autocompletar do r2 (continuam sem campos; ver l.46).
- Atributos `class`, `id`, `name` e `style` de layout no HTML cru (D-31: impede sobrepor/imitar diálogos do app) — sem revisitar.
- Abrir por link arquivos que não são `.md` (PDF etc.): o opener aceita só `http`/`https`/`mailto` (U-3) — sem revisitar.
- Modo WYSIWYG das features do r7 (regra 4) — etapa 15+.
- Dobras do outliner persistidas no disco: dobra é estado de visualização (regra 1).

### Núcleo (pré-existente, registrado no r7)

- **Lezer-`[`** — custo superlinear do `@lezer/markdown` com `[` sem par num parágrafo enorme: já existe na base `52de38b` (`'[x`] '`repetido: 56/213/831 ms para 56/112/224 KB, ×3,8 a cada 2× de entrada; [inferência por extrapolação] ~1 min a 2 MiB, na thread principal). O S2 não acrescenta custo assintótico (1,00–1,15× do Lezer puro; guarda estrutural e limite relativo atrás do`SIMPLEMD_PERF`, JEV D-R7-S2-10). Opções: issue/PR no `@lezer/markdown`ou teto de tamanho por parágrafo no indexador — núcleo / editor (RUN r7`code-review-s2.md`Delta 2;`docs-notes/S2.md`).

### Fundações (S0; RUN r7 `code-review-s0.md`, `impl-s0.md` §11)

- **CR-S0-09** — os overrides do `pnpm-workspace.yaml` (`@tgrosinger/md-advanced-tables>lodash: 4.18.1`, `micromark-extension-math>katex: 0.19.0` e o antigo `mermaid>katex: 0.19.0`) são exatos e ficam fora da faixa declarada pelos upstreams. Rever os três a cada atualização do `md-advanced-tables`, do `markdownlint` ou do `mermaid` (o override pode ficar velho ou até rebaixar); o `pnpm audit --prod` do CI pega a regressão de segurança, não a de API.
- **CR-S0-12** — o `check-licenses` cobre só as dependências npm de produção (L-4). Ficam fora os crates Rust do binário Tauri e o pequeno código de runtime que o Vite injeta; cobrir com um inventário de crates (por exemplo `cargo about`) junto com a atribuição no pacote de release (CR-S0-03, em `TAREFAS_PENDENTES.md`).
- **S0-L3-dados** — o cabeçalho L-3 só é cobrado em arquivos de código; os `latex-snippets/data/*.json` (dados convertidos do latex-suite) e os casos-ouro `.spec.md` do outliner têm a atribuição pelo NOTICES e por comentário próprio, sem portão. Avaliar estender o `check-licenses` a arquivos não-código portados.
- **NFR-54-manifesto** — "uma cópia de cada `@codemirror/*`" é conferida no lockfile (`check-single-codemirror`); a conferência no manifesto do `vite build` (arch-frontend §3.7, D-R7-F21) continua em `TAREFAS_PENDENTES.md` com o PR de pedaços sob demanda.

### Superfície nativa (SN; RUN r7 `code-review-sn.md`, `appsec-sn.md`, `docs-notes/SN.md`)

- **SN-SEC-06 (resíduo Windows)** — no Windows, hard links e nomes curtos 8.3 (`GIT~1/x.png`) não são recusados em `vault_read_image` (contagem de links não é API estável do std; nomes curtos exigiriam `GetLongPathNameW`). Impacto: só bytes com assinatura de imagem; criar o link exige escrever no vault — backend.
- **SN-SEC-06 (resíduo r2)** — `vault_read_file` também não recusa hard links (fora do escopo SN) — backend.
- **SN-SEC-08** — o portão textual do LT (`check-tauri-security.mjs`, `LT_URL_FORMAT`) pode ser contornado de propósito (`concat!("http:", "//host")`, código depois do fim do `mod tests`, host sem esquema). O código real usa só `ENDPOINTS` constantes (teste `endpoints_are_loopback_8081_constants`). Endurecer: remover comentários só fora de literais, analisar até o fim do bloco `mod tests` por chaves, exigir `ENDPOINTS` exatamente igual à constante — AppSec / DevOps.
- **DF-01** — a mesma regra ignora tudo depois do 1º `mod tests` (o Rust aceita itens de produção depois dele); remover só o bloco por casamento de chaves ou reprovar código depois dele — DevOps.
- **SN-SEC-09** — espaço `Zs`/`Zl` no meio da URL (U+3000, U+00A0, U+2028) é aceito e codificado; o SO recebe só ASCII e a dica mostra a URL normalizada. Opcional: recusar `char::is_whitespace` em qualquer posição — backend.
- **SN-SEC-10 / DF-02** — `nlink > 1` recusa também hard links legítimos dentro da pasta (deduplicadores, `cp -al`, backups): a imagem aparece como "Imagem fora da pasta". Troca de segurança aceita; documentada no README.
- **DF-03** — o ramo `send_error` (tempo-limite de conexão → `CONNECTION_REFUSED`, D-R7-SN-14) só roda no CI Windows; falta um teste unitário independente do SO. O atraso de até ~1,4 s no Windows está em `docs/languagetool.md`.
- **OQ-B6** — o Rust não verifica gesto do usuário em `open_url` (hoje: validação + anteparo de 5 aberturas/10 s); documentado em `docs/plugins.md` §Segurança.
- **OQ-B2** — SVG em UTF-16 e `svgz` são recusados.
- **OQ-B9** — lembrar entre sessões o endereço LT preferido (hoje só na sessão).
- **D-27** — porta do LanguageTool configurável (hoje fixa em 8081).
- **T-4** — o LanguageTool local não tem autenticação; qualquer processo escutando em 8081 recebe o texto com o plugin ligado (aceito; documentado em `docs/languagetool.md` e `docs/plugins.md`).
- **TOCTOU-gateway** — pasta intermediária entre `walk_target` e `open_no_follow` (`O_NOFOLLOW` protege só o último componente) e troca por FIFO entre `walk` e `open`: já existiam no gateway r2, exigem atacante local fazendo corrida — backend.

### Shell do editor (ST; RUN r7 `code-review-st.md`, `docs-notes/ST.md`)

CR-ST-01…13 corrigidos no PR #28; CR-ST-14 no PR #35. Ficam:

- **ST-lista-1** — o fallback de lista (sem o outliner) não aninha o primeiro item (não há irmão anterior) e, ao desindentar um subitem do meio, os irmãos seguintes passam a filhos dele — core (o outliner ligado trata a estrutura).
- **ST-lista-2 (CR-ST-04 / N1 do PR #35)** — num documento muito grande ainda não analisado, se o orçamento de 50 ms do parse acabar, `Mod-]` usa a árvore que o estado tem e pode cair no `indentMore` (só a linha) ou mover a subárvore pela metade (sonda: `shifted 1296 of 4000`; um passo de desfazer reverte). Pré-existente ao PR #35 — core / PERF-F.
- **ST-motivo** — a linha "Desativado por você." aparece também para plugin interno desligado por padrão (texto herdado do r2); avaliar "Desligado por padrão." — UX.
- **CR-ST-08 (resíduo)** — o texto `info` das opções é relido ao abrir o grupo e quando os valores do plugin mudam; uma mudança só no arquivo de configuração (`.markdownlint.json`, `latex-snippets.json`) aparece ao reabrir o grupo. Avaliar assinar `files.onChange` no gerenciador — frontend.

### Comandos de paleta dos plugins internos (PR #33; RUN r7 `code-review-palette.md`)

- **CR-PAL-04** — o consumidor de `internalCommandsFacet` (`useBuiltinCommands`) não revalida prefixo nem privilégio e deriva `pluginId` por `slice` (com `indexOf = -1` sai truncado; ninguém lê o valor). Defesa em profundidade: aceitar só ids de internos com `palette` — frontend.
- **CR-PAL-05** — sem teste ponta a ponta "ligar plugin real → comando aparece → desligar → some" (o outliner/LaTeX/LT poderiam cobrir) — testes.
- **CR-PAL-06** — sem nota aberta os comandos dos internos (e os `problems:*`) somem em vez de aparecer desabilitados; decisão de UX.
- **CR-PAL-D01** — `host.palette` recusa os mesmos ids numa 2ª chamada na mesma ativação (documentado em `docs/plugins.md`: chamar uma vez por ativação; variantes por `Compartment`).
- **CR-PAL-D02** — um comando de paleta pulado por colisão com um comando v1 de mesmo id só reaparece no próximo `apply` da facet; sugerido teste que exige 0 avisos "comando de paleta repetido" com os internos ligados — testes.

### Live preview, links e imagens (S1; RUN r7 `code-review-s1.md`, `docs-notes/S1.md`)

- **CR-S1-02 (resíduo)** — o mapa `refused` (imagens recusadas com o `mtime` visto) não é podado ao fechar a aba (strings pequenas; limpo na troca de pasta) — frontend.
- **CR-S1-09** — `images.blobs()` ocupa 5 linhas em `harness/main.tsx` (adaptação aceita da regra "uma linha por contador", C-R7-F07); condensar num helper se a regra voltar a importar.
- **CR-S1-10** — `noRangeOverLinks` (`links/gesture.ts`) decide o modificador por `navigator.platform`, o ⌘/Ctrl-clique por `appPlatformFacet`; alinhar exige um `ViewPlugin` que guarde a plataforma (só difere com a plataforma forçada no harness) — frontend.
- **S1-img-viewport** — imagem mostrada que o teto de 200 MiB devolveu a "carregando" só é pedida de novo quando o widget volta a ser desenhado (rolar para fora e voltar); avaliar re-pedir ao entrar no viewport — frontend.
- **S1-export-50MiB** — na exportação HTML o teto de 50 MiB conta o tamanho do `data:` (base64): uma imagem raster de 20 MiB ocupa ~26,7 MiB embutida — registro.
- **S1-W1** — a dica W1 não mostra o motivo da recusa antes do clique (só o destino); avaliar sinalizar "não suportado" na própria dica — UX.
- **S1-img-margin** (achado do S10) — `.cm-md-img` de bloco usa `margin`; o CodeMirror mede blocos sem margem e o clique logo abaixo de uma imagem de bloco pode cair uma linha depois (o W4 do S10 usa padding num invólucro por isso) — frontend (dono S1).
- **PERF R4** — exportação HTML do `large-10k` +48 % depois do S1 (102,8 → 148,5 ms; PDF 352,6 → 437,9 ms), dentro do orçamento de 3.000 ms — PERF-F.

### HTML cru sanitizado (S10; RUN r7 `code-review-s10.md`, `appsec-s10.md`, `docs-notes/S10.md`)

- **S10-details** — `<details>` com linha em branco dentro: o CommonMark fecha o bloco HTML na linha em branco; editor e exportação mostram o `<details>` só com o resumo, o corpo como Markdown abaixo e o `</details>` solto cru. Avaliar juntar blocos HTML + Markdown entre `<details>` e `</details>` (como o GitHub) — core.
- **CR-S10-08** — tags em linha balanceadas: o conteúdo entre as tags é lido como HTML, não como Markdown (`<mark>**x**</mark>` mostra os asteriscos; ``<kbd>`<b>x</b>`</kbd>`` mostra o `<b>` em negrito), igual no editor e na exportação (JEV D-R7-S10-02). Avaliar renderizar o Markdown interno — core.
- **CR-S10-01 (decisão)** — bloco HTML aninhado (citação/lista) fica cru no editor e na exportação (JEV D-R7-S10-06): o campo de blocos é de topo. Renderizar os aninhados exige mudar o campo de blocos do S1 — core.
- **S10-br** — um grupo em linha com `<br>` e texto (`<b>a<br>b</b>`) vira uma caixa de duas linhas dentro da linha do editor; `<br>` sozinho quebra normalmente. Avaliar com o design — UX.
- **CR-S10-13** — a caixa atômica do HTML em linha (`inline-block` contido, defesa do CR-S10-03) não se parte entre linhas visuais: um `<mark>` longo desce inteiro e quebra por dentro. Avaliar `display: inline` com `clip-path`/`overflow-clip-margin` ou `contain: paint` no bloco pai — frontend / design.
- **S10-subsup** — `sub`/`sup` aninhados muito fundo ficam recortados (invisíveis) dentro da caixa contida do widget em linha — UX.
- **CR-S10-12** — `computeInlineDecorations`, documentada como pura, agora consulta a cache de sanitização e exige `window` (`ReferenceError` em ambiente node com HTML em linha); guarda sem DOM em `editorCache()`/`htmlInline` + VT em node — core.
- **CR-S10-06** — `imageSpec`/`IMAGE_EXT` (`live-preview/html.ts`) repetem o fim de `readImage` (`images/element.ts`) e `hasMod` é a 3ª cópia da regra de `links/gesture.ts`; exportar `imageSpecFor` e `hasMod` do S1 — core.
- **S10-img-x** — `<img src="x">` (relativo sem extensão de imagem) mostra o estado "Tipo de imagem não suportado" (coerente com `![](x)`), então o vetor clássico `<img src=x onerror=…>` aparece com o glifo de aviso — UX.
- **S10-oblique** — `font-style: oblique 90deg` é aceito (a inclinação pode pintar fora do glifo; hoje recortada pela moldura/caixa). Avaliar restringir a palavras-chave (`normal|italic|oblique`) — AppSec.
- **S10-SEC-04** — `FORBID_CONTENTS` é só `script`/`style`: o texto de `svg`/`math`/`template`/`noscript` fica (R-I10.1 pede "dos demais, o texto fica"; JEV D-R7-S10-08). No próximo ciclo de política, avaliar descartar o conteúdo desses quatro — produto / AppSec.
- **S10-SEC-05** — o pós-checagem recusa (fonte escapada) blocos legítimos cujo `title`/`alt` mencione `javascript:`/`url(`; avaliar ignorar atributos de texto no `isUnsafeRender` só para a saída da política — AppSec.
- **S10-export-perf** — `renderExportBody` com 230 blocos/linhas adversariais levou ~5 s no jsdom (observação de NFR, não de segurança) — PERF-F.
- **S10-QA-2** — na QA, medir AC-I10.3 também pela tinta (pixels de cor-sentinela fora da caixa; modelo `appsec-probes/deco4.mjs` e o teste "tinta" do smoke), não só por `getBoundingClientRect` — QA.

### Wikilinks, criação de nota e painel "Links" (S2; RUN r7 `code-review-s2.md`, `docs-notes/S2.md`)

- **N-4 / S2-célula** — no widget de tabela, a célula mostra `[[Bolo|na tabela]]` cru: o wikilink dentro da célula não ganha a decoração nem o gesto (o índice e a exportação contam/estilizam) — dono do widget de tabela.
- **S2-html** — em HTML em linha balanceado (`<mark>[[Bolo]]</mark>`, `<span>[[Nova]]</span>`) o widget do S10 cobre o trecho: o wikilink aparece como o widget o renderiza, sem gesto — dono do widget (S10).
- **CR-S2-06 (borda 3)** — `[a [[b]]](c.md)`: o editor desenha o wikilink dentro do rótulo do link e a extração conta só o `Link`; especificar o aninhamento (JEV D-R7-S2-08) — produto / core.
- **CR-S2-08** — o índice não tem teto no gravador (D-R7-B15 do r2 mantido: só um aviso de diagnóstico acima de 20 MiB); com o v3 maior (S9), avaliar gravar sem links acima do teto em vez da reconstrução a cada abertura — vault.
- **S2-painel-240** — no painel "Links" a 240 px, com dois links na mesma linha longa, o trecho destacado da 2ª ocorrência pode ficar cortado pelas reticências e parecer igual ao 1º; recortar o contexto em volta do trecho também quando a linha cabe em 200 caracteres mas não em 2 linhas visuais — frontend.
- **N-1** — `#Título` de wikilink compara sem caixa **e sem acento** (mesma regra `headingKey` dos links `.md` do S1); o R-I2.3 diz só "sem caixa" — UX / produto confirma.
- **N-2** — `export.css` usa `text-decoration: underline dotted` em vez de `border-bottom: 1px dotted` (equivalente visual) — design confirma.
- **N-3** — `COM¹`/`CONIN$` fora da lista de nomes reservados do Windows (pré-existente; a lista segue o R-I2.5) — dono do gateway (`toVaultPath`).
- **D-N1 (S2)** — `~x` é aceito numa subpasta (`p/~x.md`) e recusado na raiz (`NOT_ALLOWED`): assimetria da guarda `toVaultPath` (dica e clique dizem o mesmo) — vault.
- **D-N3 (S2)** — o foco no contêiner `tabIndex=-1` do painel mostra o `:focus-visible` global em volta do painel depois de uma interação por teclado — UX confirma.
- **S2-STR** — textos fora da tabela STR para a UX: motivos `EMPTY` ("tem um trecho vazio"), `PATH_TOO_LONG` ("o caminho passa de 1.024 caracteres"), `FORMAT_CHAR` ("contém caractere invisível"), `NOT_ALLOWED`/recusa do provider ("o caminho não é permitido"); STR-148 composto "Nota inexistente. <aviso STR-150>"; STR-152 × LNK-INDEXING/LNK-EMPTY (anunciado ou não; implementado sem anúncio); STR-149/STR-140 como texto + detalhe (confirmar a leitura como uma frase) — UX.
- **PERF R3 / R8** — NFR-1 (primeiras linhas do explorador FX-2000) +6,7 ms no S2 e +5,9 ms no ST (dentro de 200 ms); NFR-47 (índice FX-2000-TASKS) 641,9 → 1.043,3 ms com a extração de links (dentro de 3.600 ms) — PERF-F.

### Tabelas (S3; RUN r7 `code-review-s3.md`, `docs-notes/S3.md`)

- **S3-meaw** — largura de texto com marcas combinantes que não compõem em NFC (devanágari, tailandês) e emoji de um ponto de código em apresentação de texto (☺) segue o modelo East Asian Width do `meaw` (1 coluna por ponto de código), o que pode desalinhar em fonte monoespaçada — core.
- **S3-chunk** — o pedaço do motor sai como `lib-*.js` no `vite build`; nomear `tables-engine-*.js` exige `output.chunkFileNames`/`advancedChunks` no `vite.config.ts` — DevOps.
- **CR-S3-05** — mais de 66 emoji distintos de vários pontos de código numa tabela: do 67º em diante o aglomerado volta à largura do `meaw` (👍🏽 = 4 colunas) e a coluna desalinha (nada se perde). Opcional: caracteres de uso privado ausentes do texto como reservados extras — core.
- **CR-S3-08** — "Tabela: Próxima linha" mostra `aria-keyshortcuts="Enter"` na paleta sem o contexto "(na tabela)"; a UX decide entre o rótulo `↩ na tabela` ou tirar o atributo; a QA-3 confere — UX.
- **D-N1 (S3)** — na falha de carga do motor, Enter com seleção não vazia insere a quebra no `head` em vez de trocar a seleção (caminho improvável: instalação corrompida). Guardar `from`/`to` no `PendingCommand` — core.
- **D-N2 (S3)** — o texto "Não foi possível carregar os comandos de tabela" ainda não está nas tabelas STR — UX.
- **D-N3 (S3)** — `sort-asc` sem tabela-ouro que o distinga no AC-I3.2 (os testes de ordenação cobrem o comando) — testes.
- **D-N4 (S3)** — numa tabela com emoji de vários pontos de código, cada sessão de comando lê o documento inteiro uma vez (~1,4 ms por Tab em 376 KB, medido no PERF-3; dentro do NFR-50). Restringir a varredura às linhas da tabela se pesar — core.

### Checkpoint PERF a9cb8c6 e correções (PR #35; RUN r7 `perf-checkpoint-a9cb8c6.md`, `code-review-perf-fixes.md`)

R1 (CR-ST-14) e R2 (pré-carga de tabelas) corrigidos no PR #35. Ficam:

- **PERF-host** — as cláusulas "máx ≤ 50 ms" do NFR-41(a)/NFR-21(a)/NFR-5 e as de tarefas longas do NFR-23/27/33(d) ficaram INCONCLUSIVAS por carga do host (D-PERF-CK-04); NFR-23 (scroll) 20,6/20,4 ms contra 20 ms no mesmo ruído. Medir de novo num host quieto: fase F (A/B intercalado de NFR-1, NFR-6, NFR-21(a), NFR-23), `vt/tables.vt.test.ts`, NFR-43 com mediana e p95, NFR-46 "atualização ≤ 2 s" — PERF-F.
- **PERF R5** — NFR-6 (abrir 1 MB) +10–22 %, não atribuível (deriva de carga) — PERF-F.
- **CR-PF-03** — com o popup de sugestões visível mas desabilitado (cinza) durante uma consulta nova, o Escape não o conta como popup — core.
- **CR-PF-04** — a pré-carga do motor de tabelas reescrita não tem teste de tabela aninhada na linha do cursor, de árvore tardia nem de "sem `ensureSyntaxTree` nas atualizações" — testes.
- **CR-PF-01 / N2** — o teste do NFR-50 desconta os campos do estado junto com a view, e o comentário diz que eles estão incluídos; o relato do impl mede só o motor (1,2–1,4 ms; o estado soma 1,3–1,5 ms) — testes.
- **CR-PF-02** — a folga do item no `covers()` (`list-indent.ts`) não tem teste que a guarde (a mutação sobrevive) — testes.
- **N3 (PR #35)** — a contagem de `ensureSyntaxTree` em `keys.list-indent-parse.test.ts` é global (quebra se outro chamador passar a usá-lo); comentar que é um alarme de desempenho — testes.
- **NFR-50-PW** — levar a spec PW do NFR-50 (`specs/nfr50-format.spec.ts`, RUN r7 `impl-perf-fixes/`) para o repositório — testes.

### Carga sob demanda / bundle (PR #42 `a05e72a`; RUN r7 `code-review-bundle.md`)

O NFR-54 voltou ao orçamento (entrada +69,8 % mín / +69,1 % gzip contra `52de38b`). Ficam:

- **S1 (bundle)** — o ramo de falha do editor em `live-preview/html.ts` (`toDOM`: `else frame.textContent = this.source`, que desenha HTML cru de nota não confiável como texto quando o pedaço do sanitizador falha) não tem teste de regressão: a mutação `innerHTML` nesse ramo passa a suíte inteira. Teste: falha do pedaço → outra vista ou outro bloco com `<img src=x onerror=…>` → `textContent` = fonte, 0 filhos, 0 `[data-testid=html-inline]` — testes / core.
- **S2 (bundle)** — exportação com o pedaço do sanitizador falhando, sem teste: hoje a garantia "falha → a exportação falha, nada sai sem sanitizar" só existe pela leitura do código. Em `export-sanitizer-lazy.test.ts`, com `vi.doMock` que lança, conferir que `exportHtml` rejeita; no `controller`, que `saveTarget.write` não é chamado e sai o aviso `export-failed` — testes / desktop.
- **S3 (bundle)** — lacunas residuais do de-flake: a asserção nova do NFR-56 testa `catalog.candidates`, não que `findSnippets` o use (espião durante as teclas medidas); nos wikilinks, um trabalho O(N) somado à consulta só aparece com PERF (espião também em `paths[Symbol.iterator]`/`forEach`); tetos de tempo do LaTeX sob PERF folgados ×5 (5 → 25 e 20 → 100 ms) sem a medição que os justifique (registrar a do Windows ou usar o fator `CI ? 5 : 1`) — testes.
- **S4 (bundle)** — a guarda do ESLint não cobre a volta do serializador da exportação à entrada: imports estáticos de `../export/*` a partir do núcleo (fora de `export/**`) e de `@simplemd/core/export`/`./pipeline|./images|./normalize|./renderers` a partir de `apps/desktop/src` passam (≈ 17,6 KB de volta). Risco só de NFR-54 (o CI não o mede). Regra: no núcleo, `(^|/)export(/|$)` com `allowTypeImports` fora de `export/**`; no desktop, `@simplemd/core/export` restrito fora de `src/export/{pipeline,images,normalize,renderers}.ts` — DevOps / core.
- **N1 (bundle)** — em `load.ts`, um erro lançado dentro do `onOk` (`createHtmlSanitizer(window)`) não passa pelo `onErr`: `loading` fica rejeitada para sempre, `failed` não liga e a exportação nunca tenta de novo (falha fechada; caso praticamente impossível). Usar `.then(onOk).catch(onErr)` ou `try` no `onOk` — core.
- **N2 (bundle)** — depois de uma carga do editor que falhou e de uma nova tentativa bem-sucedida pela exportação, os blocos já desenhados como texto continuam em texto até o bloco mudar (`eq` reaproveita o DOM); o grupo em linha só vira widget no próximo `redecorate` — cosmético, core.
- **N3 (bundle)** — no estado de falha, um bloco novo recebe só `cm-md-html`, sem a classe `-pending`: o `white-space` volta ao normal e as quebras de linha da fonte colapsam. Pôr uma classe (`cm-md-html-pending` ou `cm-md-html-raw`) também no ramo `else` — core.
- **N4 (bundle)** — nomes de teste desatualizados: `wikilinks.test.ts` "1.000 resoluções ≤ 20 ms" e o "p95 … ≤ 2 ms" do NFR-56 hoje são asserções estruturais sem PERF; deixar claro no nome que o tempo só vale com `SIMPLEMD_PERF=1` — testes.

### Tarefas e consultas — dados (S9a; RUN r7 `code-review-s9a.md`)

- **N1 (S9a)** — data inválida "engole" texto do usuário no parse: `Comprar ✅ leite` → `text: "Comprar"`, `invalid: ["done"]`; `somar a ➕ b` → `"somar a"`; `x 📅 #tag` → a tag vira data inválida. Segue o R-I9.2 ao pé da letra, mas o upstream exige `AAAA-MM-DD`. Só tratar como campo um token que pareça data e deixar o resto na descrição (o B2 — nunca apagar esse texto ao reabrir — já foi corrigido) — core.
- **N2 (S9a)** — concluir uma tarefa que já tem um ✅ antigo válido (`- [ ] s ✅ 2020-01-01`) mantém a data antiga; o upstream grava a de hoje — core.
- **N4 (S9a)** — `dates.ts`: `Date.UTC` com ano < 100 vira 19xx (`addDays('0050-01-01', 1)` = `1950-01-02`); usar `setUTCFullYear` — core.
- **N5 (S9a)** — `line.ts`: `slice(0, TASK_TEXT_MAX)` pode partir um par substituto, e as tags vêm da descrição inteira, não da cortada (`cutText` do `note.ts` já trata o par) — core.
- **N6 (S9a)** — `sameTask` compara o `text` cortado em 1.000: duas linhas longas com o mesmo prefixo passam como "a esperada" — core.
- **N7 (S9a)** — defesa em profundidade: `editTask` poderia exigir `validIndexPath(ref.path)` ou uma entrada no instantâneo (o provider aceita `.simplemd/*.json` para gravação; hoje o chamador é um plugin interno) — desktop.
- **N8 (S9a)** — reabrir `[-]` → `[ ]` mantém o ❌; intencional? Documentar (UX-R7-D17) — UX.
- **N9 (S9a)** — revalidação quente 28 ms (v2) → ~110 ms (v3, 4,8 MB) pelo JSON maior e o sha256; ainda folgado — registro.
- **N10 (S9a)** — o texto `TASKS_CATALOG_TEXT.io` (falha de E/S ao marcar tarefa) é provisório (lacuna C-3) — UX.
- **N12 (S9a)** — falha no `import()` do extrator deixa o catálogo em "carregando" sem aviso visível (só `console.warn`); a reabertura tenta de novo — desktop.
- **N13 (S9a)** — duas marcações em paralelo com recorrência: a próxima ocorrência entra acima e desloca a linha esperada da outra tarefa → "A tarefa mudou no arquivo…" (0 gravações + reindexação, como o R-I9.7 pede). Relocalizar a tarefa pela identidade (`sameTask`) numa janela de ±N linhas — core / desktop.
- **NFR-47 (backlog 2–3)** — passar ao `indexProperties` o YAML já analisado pelo `meta` (~60 ms); no portão do VT do app, medir como o r2 (sem a suíte inteira em paralelo) ou calibrar `PERF_GATE` no CI para o job `perf` poder virar obrigatório (o parse único por nota já foi feito) — PERF-4.

### Tarefas e consultas — consultas (S9b; RUN r7 `code-review-s9b.md`, `docs-notes/S9b.md`)

- **CR-S9b-N01** — `limit 1001` → "Instrução não reconhecida…" (D-R7-S9b-01, documentado); uma mensagem mais exata ("limit acima de 1.000") exigiria texto novo no STR-177 — UX.
- **CR-S9b-N02** — `priority` no DQL usa os nomes do bloco `tasks` (o Dataview não tem `priority` a partir dos emojis; D-R7-S9b-05, documentado) — registro.
- **CR-S9b-N05** — DQL: vazios por último também em `ASC` (no Dataview, nulo vem primeiro em ASC); documentado — paridade, se importar.
- **CR-S9b-N06** — `tasks` sem `sort by` ordena por caminho + linha (o Obsidian Tasks ordena por status, urgência, vencimento, prioridade, caminho); documentado — paridade, se importar.
- **CR-S9b-N07** — `file.tags` não expande tags-pai (`#a/b` não dá `#a`; o `FROM #a` já trata subtags); o `text` do TASK não traz os sinais emoji — documentar ou expandir pais em `noteTags`.
- **CR-S9b-N08** — fixture S0 `consultas.md`: 2 das 20 consultas fora do subconjunto por desenho; `livros/grande-sertao-veredas.md` com YAML inválido (`title: Grande Sertão: Veredas` sem aspas) — S0 / QA-3.
- **CR-S9b-N09** — `setQuerySnapshotRenderer` não é zerado no `dispose` do plugin (higiene; a exportação já exige o plugin ligado) — plugins.
- **CR-S9b-N10** — literais `12px`/`2px` em `tasks/theme.ts` e `export.css` iguais a `--dimension-space-3`/`--dimension-focus-ring` — QA-3 (portão de tokens).
- **CR-S9b-N15** — uma cadeia `and`/`or` com mais de 64 termos num `WHERE`/`FROM` é recusada (a árvore desce pela esquerda; documentado). Opcional: nós n-ários planos, como no `tasks` — plugins.
- **CR-S9b-N16** — o `catch` da avaliação mostra qualquer defeito real do avaliador como "Instrução não reconhecida na linha N" sem registrar nada; acrescentar um `console.warn`/log de diagnóstico — plugins.
- **CR-S9b-N17** — a mensagem "Instrução não reconhecida" repete a linha patológica inteira (dezenas de KB no alerta e no HTML exportado); truncar o trecho citado exige texto novo — UX.
- **S9b-origem** — a origem "título › linha N" usa o título do índice: nota sem H1 → nome do arquivo em minúsculas (ex.: "lista") — UX.
- **S9b-$=** — `$=` só é reconhecido no início do bloco `dataview`; consultas em linha (`` `= …` ``) ficam código (documentado).

### Modo Vim (S4; RUN r7 `code-review-s4.md`, `docs-notes/S4.md`)

CR-S4-F01 ("1 linhas copiadas") corrigido no SZ. Ficam:

- **CR-S4-F02** — o `role="status"` da mensagem nasce já com o texto, dentro de um painel recém-inserido, e alguns leitores de tela não anunciam; chamar também o `announce` do host com o texto traduzido ou manter uma região persistente — plugins / a11y.
- **CR-S4-F03** — o comentário de `vim-app.test.tsx` diz "O Vim não viu `w` nem `P`", mas a asserção (bytes iguais) não detectaria isso; assinar `inputEvent`/`vim-keypress` e afirmar 0, e cobrir as 8 teclas de R-I4.4 — testes.
- **CR-S4-F04** — na confirmação de `:s///c`, o input se chama "Comando do Vim" e a instrução em inglês ("replace with b (y/n/a/q/l)") não está associada a ele (`aria-describedby`) — plugins / a11y.
- **CR-S4-F05** — `:wa`, `:qa` mostram "Comando não reconhecido" (D-44 lista só `:w :q :wq :x`); incluir as formas `all` em `SILENT_EX_COMMANDS` se a UX quiser — UX.
- **CR-S4-F06** — depois de Esc no prompt `:`, o teste confere só que o painel sumiu, não que o foco voltou ao editor — testes (a QA-4 cobre no PW).
- **S4-pcre** — a descrição inglesa da busca da biblioteca ("(JavaScript regexp: set pcre)", clicável só com o mouse) continua no painel `/`, com `lang="en"`; esconder ou traduzir — UX.
- **S4-mensagens** — mensagens do Vim fora da STR-161 (`:set`, `:registers`, `:marks`, "Press ENTER or type command to continue", confirmação de `:s///c`) aparecem em inglês com `lang="en"`; ampliar a tabela se a UX quiser — UX.
- **S4-aba** — o modo volta a "normal" ao trocar de aba (o estado do Vim é por documento na biblioteca) — registro.
- **S4-popup-Esc** — com o popup de sugestões aberto, o 1º Esc fecha o popup e o Vim continua em inserção (ordem vinculante da arch-ux §6.4); usuários de Vim podem estranhar — UX.

### Lint de Markdown (S5; RUN r7 `code-review-s5.md`, `docs-notes/S5.md`)

- **CR-S5-11** — textos fora da STR: o STR-165 sai como "Lint de Markdown: <arquivo> é inválido; …" (o host prefixa o nome do plugin; a STR diz "Lint: …"); a opção "Regras em uso" no estado inválido diz "Arquivo <arquivo> desta pasta inválido; usando o padrão do simpleMD"; o aviso de lint lento é texto novo (JEV D-R7-S5-11) — UX.
- **S5-arvore** — as exclusões do lint usam a árvore Lezer do estado: numa nota enorme ainda não analisada até o fim, um achado além do trecho analisado não é filtrado; o `=calc` do lint não confere parênteses — plugins.
- **S5-sobreposicao** — com lint e LanguageTool sobrepostos, o cartão mostra só o problema mais forte sob o cursor (o outro segue no painel) — UX.
- **S5-cardField** — o `cardField` guarda o diagnóstico antigo e o `TooltipView` o atual (duas fontes de verdade, corretas pela equivalência por conteúdo); trocar a referência no `update` do campo — plugins.
- **S5-runIdle** — em `runIdle`, `if (disposed) return;` deixa a promessa pendente para sempre (inofensivo: o plugin já foi descartado) — plugins.
- **D-S5-01 (pré-existente)** — `loadForVault` + `reload()` sobrepostos, ou 2 `reload()`, ativam um plugin externo aprovado 3× (cada `#rescan` monta `previous` antes de a varredura anterior gravar; entradas órfãs continuam ativas e registram em dobro). Serializar o `#rescan` — plugin-api.
- **D-S5-02 (pré-existente)** — com 2 ativações em voo, a 1ª a terminar zera o `busy`; se o usuário desligar nesse intervalo, a 2ª ativa o plugin contra a preferência gravada. Retornar cedo em `#activate` também com `entry.busy`, ou reconferir a preferência depois das esperas — plugin-api.
- **NFR-52-plano-C** — sem worker (plano C), o NFR-52 é NÃO CUMPRIDO por desenho (Q-R7-F04; aviso de lint lento em notas > 2.000 linhas) — registro.

### Snippets LaTeX (S6; RUN r7 `code-review-s6.md`, `impl-s6.md`)

CR-S6-01…11 resolvidos no PR #36. Ficam:

- **CR-S6-04** — exceção de posse aprovada pelo Main: o S6 editou `eslint.config.js` (bloco `shared: 'parent'`), `packages/plugins-internal/package.json` (`@codemirror/autocomplete`) e o `pnpm-lock.yaml` (só a aresta do importador), arquivos de dono único do S0 — registro.
- **S6-custo** — o custo estático das regex do usuário é conservador (`([a-z]+)([0-9]+)([a-z]+)` ≈ 10⁸ é recusado mesmo sem backtracking real; documentado "dois `\w*` em sequência cabem; três não"); pior caso aceito ≈ 1,7 ms por regex numa janela adversária e [inferência] ≈ 5 ms por tecla no arquivo inteiro com o orçamento de 3,5 × 10⁶ — plugins / PERF-F.
- **S6-cursores** — com vários cursores, os cursores sem gatilho perdem a posição numa expansão (aproximadamente como o upstream) — plugins.
- **S6-chaves** — quem copiar gatilhos do upstream com `{` solto precisa escapar (`\{`), porque as regex do usuário rodam sempre com a flag `u` — documentação.

### Outliner (S7; RUN r7 `code-review-s7.md`, `docs-notes/S7.md`)

- **CR-S7-01** — NFR-56 dobrar/desdobrar: a métrica de quadro tem piso de ≈ 1 vsync (um clique que não faz nada já mede p95 16,7 ms); o trabalho real fica ≤ ~6 ms. O PERF-F define a métrica de veredito (processamento + render, ou delta sobre o controle no-op) — PERF-F.
- **CR-S7-02** — o oráculo da Classe B do teste de conflitos é uma lista única para todas as plataformas (`Mod-Backspace` e `Ctrl-ArrowLeft` liberam duplicatas de `Ctrl-Backspace` no Windows/Linux e de `Ctrl-←` no macOS, onde o plugin não liga nada); entradas por plataforma e uma linha na arch-ux §6.4 com o ack da UX (D-R7-S7-01) — testes / UX.
- **CR-S7-04** — faltam guardas `completionStatus === 'active'` e `state.readOnly` nos handlers do outliner (`enter.ts`, `content-keys.ts`, `runMovement`); hoje sem efeito observado (o popup vem antes; o único editor `readOnly` não carrega plugins) — plugins.
- **CR-S7-05** — o nome acessível do marcador de dobra conta só linhas de item: um item só com notas/continuação dá "0 itens dobrados", e "Lista: Dobrar item" num título dobra a seção e anuncia "Item dobrado." — a11y.
- **CR-S7-06** — cobertura por arquivo de `outliner/features/` abaixo de 80 % (DnD 69,14 %, guias 70,31 %; o agregado passa) — testes.
- **CR-S7-07** — desfazer um "mover" de item dobrado perde a dobra (só visual; igual ao upstream e ao CM).
- **CR-S7-08** — o `mousedown` no marcador faz `preventDefault` + `stopPropagation` antes de saber se haverá arrasto: clicar no `•` não posiciona o cursor e Shift-clique não estende a seleção (igual ao upstream) — UX.
- **CR-S7-09** — arrasto com `mouseup` fora da janela fica ativo até o próximo movimento/clique (igual ao upstream); opcional: cancelar no `blur` da janela — plugins.
- **CR-S7-10** — Enter num item vazio de nível 1 **com filhos** (D-R7-S7-03) apaga o marcador e os filhos passam a continuar o item anterior (`"- a\n- \n  - child\n- b"` → `"- a\n\n  - child\n- b"`; nenhum byte de conteúdo se perde; como no Obsidian) — documentação.
- **CR-S7-11** — `defaultIndentChars` varre o documento a cada Enter/Tab/soltura e o primeiro "item indentado" pode estar dentro de um bloco de código cercado; `foldAll`/`listItemFoldRange` também reconhecem itens dentro de código. Pular nós `FencedCode` — plugins.
- **CR-S7-12** — o cursor grudado faz o parse da lista sob o cursor a cada mudança de seleção (`setTimeout(0)` por mudança, ≈ 1,0 ms/tecla numa lista de 4.003 linhas; linear no tamanho da lista, herdado do upstream); as guias são re-medidas por `requestMeasure` a cada mudança (custos em RUN r7 `evidence-s7/perf-log.txt`) — PERF-F.
- **S7-VimO** — `VimOBehaviourOverride` fora do porte (Q-R7-F08): com Vim + Outliner ligados, `o`/`O` seguem o Vim sem o tratamento de lista do upstream (não exercitado) — plugins.
- **S7-arrasto** — o destaque da linha do novo pai durante o arrasto (o upstream pinta a linha de destino) não está no DESIGN §R7.6.13: só o indicador de 2 px `accent` e as linhas arrastadas com fundo `hover` — design.
- **D-R7-S7-02** — 4 casos em que o outliner não age seguem o editor sem o plugin e diferem do Obsidian: o Backspace do `lang-markdown` apaga o marcador inteiro (Obsidian: 1 caractere) em 2 casos; Enter com seleção de várias linhas continua a lista com a indentação do `lang-markdown`; `[[` não vira `[[]]` — registro.

### Ortografia e gramática com LanguageTool (S8; RUN r7 `code-review-s8.md`, `impl-s8.md`)

B01–B03 e N1–N9 corrigidos no PR #37. Ficam:

- **CR-S8-a** — o "Verificar agora" em notas além do parse de fundo analisa em fatias de 100 ms, acima da tarefa longa de 50 ms (NFR-42/52; só no comando explícito, não na digitação); usar 40 ms por fatia — plugins.
- **CR-S8-b** — quando a guarda da troca recusa (o texto sob o sublinhado mudou), o cartão fecha sem anúncio (na prática inalcançável); anunciar "O trecho mudou; verifique de novo." — UX.
- **S8-STR** — desvios de texto declarados: STR-169 sem o prefixo "Ortografia e gramática:" (o host já prefixa o nome do plugin); nome acessível "Desativar regra <ID>" em vez de "Desativar a regra <ID>" (STR-168); código "pedido inválido" fora da lista STR-166 para `LT_INVALID_REQUEST`/`BODY_TOO_LARGE`/rejeição sem `code` — UX.
- **S8-sessao** — "1 aviso por sessão" vale por ativação do plugin (desligar e ligar reinicia) — registro.
- **S8-rolagem** — ao rolar, parágrafos nunca verificados só entram pelo comando ou por uma edição (D-R7-S8-03b; documentado) — registro.
- **S8-aquecimento** — a primeira verificação de um servidor recém-iniciado pode passar de 15 s (aquecimento do Java) → "sem resposta" e nova tentativa em 30 s (documentado) — registro.
