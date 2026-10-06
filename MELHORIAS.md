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
