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

## Achados da revisão de código adiados (CR-xx)

- RR-02 (resíduo de CR-02): no caminho "Fechar sem salvar" da troca de pasta, o segundo diálogo de pasta roda sem novo flush; edições digitadas nele em abas sem erro (fora da lista do L4) se perdem. Só com diálogo não modal (Windows, inferido). Corrigir com `flushAll()` após o diálogo ignorando só os caminhos descartados, ou casca `inert` enquanto `opening`.
- RR-03 (resíduo de CR-06): a autorização de escrita do vault ainda se baseia no mtime; com escrita externa no mesmo tique de mtime da leitura base (FAT 2 s, rede, nuvem) e outro leitor lendo depois, a gravação com a base antiga ainda sobrescreve. Correção completa: base de conteúdo fornecida pelo chamador (hash ou bytes) em vez do mtime. Relevante quando plugins/índices lerem arquivos abertos (etapa 6).
- CR-09: segurança em profundidade do escopo de arquivos — revogar o escopo da pasta anterior ao trocar de pasta; recusar `/` e `$HOME` como vault; no Windows, negar `.git/`, `.env` etc. também no escopo do Tauri (hoje só a guarda JS bloqueia); restringir `dialog:allow-open` a arquivos. Só explorável com execução de script no webview (nenhum vetor encontrado).
- CR-11: com um tema salvo ausente ou inválido, a próxima mudança de preferência regrava `config.json` com `simplemd-light`; gravar só as chaves alteradas na sessão.
- CR-13: o vault guarda os bytes de todo arquivo lido/gravado na sessão (`#lastKnown`); guardar hash + tamanho ou esquecer ao fechar a aba/pasta.
- CR-14: `tablePreviewField` recalcula todas as tabelas a cada transação; mapear as decorações e recalcular só as tabelas afetadas (medir NFR-5 antes).
- CR-17: asserções redundantes `expect(screen.getBy…).toBeDefined()` nos testes de UI.
- RR-01 (regressão de CR-07): aba em conflito cujo arquivo é removido fora do app — o evento é de um caminho aberto, então não há nova listagem, e `checkTab` ignora abas em conflito; o explorador mantém a linha do arquivo removido até "Manter ambos", um clique na linha ou outro evento. Corrigir relistando em `#reloadOriginal` (NOT_FOUND) ou tratando remoção também em abas em conflito.
- RR-04: quando as 5 rodadas de flush ao fechar se esgotam (digitação contínua com gravações lentas), a aba fica `dirty` em vez de `error`; o L4 lista o arquivo, mas "Voltar" procura `error` e não ativa nada. Sem perda de dados. Marcar `error` ao esgotar ou usar `unsavedClose.paths[0]` no "Voltar".
- RR-05: `CHANGELOG.md` — "Corrigido" aparece antes de "Alterado" e "Documentação (dívida)" não é categoria do Keep a Changelog; reordenar e mover a lista de textos STR para cá ou para `TAREFAS_PENDENTES.md`.
- RR-06: `decodeDocument` faz três `split()` por abertura/recarga (≈ 75 mil strings num arquivo de 1 MB); trocar por um laço único com `charCodeAt`.
