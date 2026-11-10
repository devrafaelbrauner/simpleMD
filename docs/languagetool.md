# Ortografia e gramática com o LanguageTool local

O plugin interno **Ortografia e gramática (LanguageTool)** sublinha erros de ortografia e de gramática
enquanto você escreve. Ele não traz corretor próprio: conversa com um servidor
[LanguageTool](https://languagetool.org) que **você instala e roda neste computador**, em
`http://localhost:8081`. O plugin vem desligado; ligue em **Configurações → Plugins**.

O LanguageTool é software livre (LGPL-2.1) e roda num processo separado. O simpleMD não inclui nem
modifica o LanguageTool: só envia pedidos HTTP a ele.

## Instalar o servidor

### macOS com Homebrew

```sh
brew install languagetool
```

O Homebrew instala também o Java de que o servidor precisa (OpenJDK 17). Para rodar o servidor só
enquanto o terminal estiver aberto:

```sh
"$(brew --prefix)/opt/languagetool/bin/languagetool-server" \
  --config "$(brew --prefix)/etc/languagetool/server.properties" --port 8081
```

Para deixá-lo sempre ligado (sobe de novo ao entrar no computador):

```sh
brew services start languagetool
```

e, para desligar, `brew services stop languagetool`.

O simpleMD não precisa da opção `--allow-origin`: quem fala com o servidor é o próprio app, não a
página do editor.

### Docker (macOS, Windows, Linux)

```sh
docker run -d --name languagetool -p 127.0.0.1:8081:8010 erikvl87/languagetool
```

A imagem escuta na porta 8010 dentro do contêiner; o `-p 127.0.0.1:8081:8010` publica a porta 8081
só neste computador. Para parar: `docker stop languagetool`; para voltar: `docker start languagetool`.

## Conferir se o servidor está no ar

```sh
curl http://localhost:8081/v2/languages
```

A resposta é uma lista JSON de línguas (`[{"name":"Arabic","code":"ar","longCode":"ar"}, …]`). Se
o `curl` disser `Connection refused`, o servidor não está rodando.

## Usar no simpleMD

- **Ligar:** Configurações → Plugins → "Ortografia e gramática (LanguageTool)". A linha do plugin
  lembra que é preciso um servidor local e tem o botão "Como instalar" (esta página).
- **Barra de status:** no fim do editor aparece o estado — "LanguageTool: verificando…",
  "LanguageTool: N problemas", "LanguageTool: servidor não encontrado em localhost:8081",
  "LanguageTool: sem resposta (tempo esgotado)", "LanguageTool: erro <código>" ou
  "LanguageTool: verificação manual". Clique (ou Enter) nele para "Tentar de novo",
  "Verificar ortografia e gramática agora" e "Como instalar".
- **Sublinhados:** ondulado para ortografia, tracejado para gramática e estilo. Passe o mouse ou
  use **⌘⇧Enter** (Ctrl+Shift+Enter) com o cursor no trecho para abrir o cartão do problema:
  até 5 sugestões "Trocar por “…”" (cada troca se desfaz com ⌘Z/Ctrl+Z), "Ignorar" (só nesta
  sessão), "Adicionar ao dicionário" (para erros de ortografia) e "Desativar regra". Quando o
  trecho apontado inclui marcação (por exemplo `em [o` em `em [o site](…)`), o cartão não oferece
  "Trocar por", porque a troca apagaria a marcação; corrija à mão. **F8** e **Shift+F8** vão ao
  próximo e ao anterior; **⌘⇧M** (Ctrl+Shift+M) mostra a lista de problemas.
- **Opções** (Configurações → Plugins → Opções do plugin):
  - **Verificação:** "Automática (ao parar de digitar)" verifica 1 segundo depois da última tecla,
    só os parágrafos que mudaram, e o trecho visível quando você abre uma nota; a nota inteira é
    verificada pelo comando "Verificar ortografia e gramática agora" (⌘⇧O / Ctrl+Shift+O), em
    pedidos de até 20.000 caracteres (um parágrafo ou tabela maior vai em pedaços). "Manual (pelo
    comando)" só verifica pelo comando: nem depois de "sem resposta" ele tenta de novo sozinho.
  - **Idioma padrão:** Português (Brasil) por padrão. Uma nota pode escolher a própria língua no
    front matter, com `lang: en-US` (ou `pt-PT`, `es`, `de`…). "Automático" deixa o servidor
    detectar entre português do Brasil e inglês dos EUA.
  - **Adicionar palavras ao:** onde "Adicionar ao dicionário" grava a palavra — "Este computador"
    (padrão) ou "Esta pasta" (veja [Dicionário](#dicionário)). O anúncio diz qual ("“excessão”
    adicionada ao dicionário deste computador."). Se a gravação falhar ou o dicionário estiver no
    limite, o sublinhado continua e aparece um aviso.
  - **Regras desativadas:** cada regra desligada pelo cartão, com o botão "Reativar <ID>".
  - **Dicionário:** as palavras de cada camada, para buscar e remover, e as listas de termos
    importadas, com o plugin ligado ou desligado (veja [Dicionário](#dicionário)).

## Dicionário

Uma palavra que está no seu dicionário não é sublinhada como erro de ortografia. O dicionário tem
duas camadas, e vale a união delas:

- **Deste computador:** vale em qualquer pasta aberta neste computador e não viaja com as pastas.
  Fica nos dados do app, em `dictionaries/` (macOS:
  `~/Library/Application Support/io.github.devrafaelbrauner.simplemd/dictionaries/`; Windows:
  `%APPDATA%\io.github.devrafaelbrauner.simplemd\dictionaries\`). Um arquivo dela mudado por fora
  (outro programa, outra janela do simpleMD) é relido ao abrir uma pasta, não na hora.
- **Desta pasta:** os arquivos `.txt` em `.simplemd/dictionaries/` da pasta de notas. Viajam com a
  pasta (sincronização, cópia) e valem só nela. Um `.txt` novo ou alterado por outro programa, por
  outra janela ou pela sincronização vale na hora, sem reabrir a pasta.

"Adicionar ao dicionário" acrescenta a palavra ao `pessoal.txt` da camada escolhida em "Adicionar
palavras ao" (o arquivo nasce na primeira vez). Os outros `.txt` você mesmo cria e edita, por
exemplo uma lista de termos da sua área, neste formato:

- UTF-8, uma palavra por linha; linha que começa com `#` é comentário; linha vazia não conta.
- Cada palavra tem de 1 a 64 caracteres, sem espaço nem caractere de controle ou invisível; uma
  linha fora disso é ignorada. Palavra repetida conta uma vez.
- Como no LanguageTool, uma palavra em minúsculas vale também com inicial maiúscula ou toda em
  maiúsculas ("excessão" cobre "Excessão" e "EXCESSÃO"); uma com maiúscula ("Brasil") vale só
  assim. A mesma palavra com acento composto ou decomposto (NFC/NFD) é uma só.

Limites por camada: 200.000 palavras, 16 arquivos e 20 MiB no total, e até 10 MiB por arquivo. O
`pessoal.txt` vem primeiro, e os outros pela ordem do nome; o que passar dos limites fica de fora,
com um aviso do app (na área de avisos, ⚠): uma vez por camada e por motivo em cada sessão, mesmo
com o plugin ligado ou desligado — quem avisa é o app, não o plugin. A lista "Dicionário" das
opções mostra o aviso de cada arquivo, sempre. Com a camada no limite, "Adicionar ao dicionário"
avisa e não grava.

**Ver e remover.** Em Configurações → Plugins → "Ortografia e gramática (LanguageTool)" → Opções →
"Dicionário", com o plugin ligado ou desligado: escolha a camada ("Este computador" ou "Esta pasta";
sem pasta aberta, "Esta pasta" pede para abrir uma), busque (sem acento nem maiúsculas: "excessao"
acha "excessão") e use "Remover" ao lado da palavra. A lista mostra até 100 palavras, na ordem dos
arquivos (`pessoal.txt` primeiro), com a contagem; para achar uma palavra de depois, busque.
Remover tira a palavra de **todos** os `.txt` lidos da camada (os comentários e as outras linhas
ficam) e, se o foco segue na lista, leva-o à palavra seguinte; o sublinhado volta na próxima
verificação. Um arquivo deixado de fora pelos limites não é lido: a palavra que só está nele não
aparece na lista, e nele a palavra continua depois de remover. Se outro programa mudou
um dos arquivos entre a leitura e a gravação, o app relê a camada e tenta mais uma vez, sem aviso.
Se a gravação falhar, a mensagem aparece acima da lista e a palavra fica; com a palavra em mais de
um arquivo, os gravados antes da falha já ficam sem ela, e remover de novo termina o resto.

**Importar uma lista de termos.** Na mesma lista "Dicionário", "Importar lista de termos…" abre o
diálogo do sistema e grava a lista escolhida na camada marcada em "Camada" (o botão diz para onde:
"Vai para: Este computador" ou "Vai para: Esta pasta"; sem pasta aberta, "Esta pasta" deixa o botão
desabilitado e diz por quê). Escolha o próprio arquivo, não um atalho ou link. Vale:

- um `.txt` com uma palavra por linha, no formato acima, em UTF-8 (com ou sem BOM; UTF-16 com BOM
  também); um arquivo que não é UTF-8 válido é lido como Windows-1252;
- um `.dic` do Hunspell (por exemplo, `pt_BR.dic`): a contagem da primeira linha e as marcas depois
  da `/` saem (`casa/S` vira `casa`), e a codificação vem da linha `SET` do `.aff` de mesmo nome ao
  lado (`UTF-8`, `ISO8859-1`, `ISO8859-15` ou `microsoft-cp1252`). Com o `.aff`, os dois arquivos
  originais também ficam guardados na camada, em `hunspell/`.

Até 10 MiB por arquivo. Palavras fora do formato e repetidas ficam de fora e são contadas como
descartadas. A lista vira um `.txt` novo na camada, com o nome do arquivo em minúsculas, sem acento
e com `-` no lugar dos espaços (`Termos Médicos.txt` vira `termos-medicos.txt`; se esse nome já
existe, `termos-medicos-2.txt`): nada é sobrescrito. O resumo diz o que entrou ("“termos-medicos”
importado: 50.000 palavras, 3 descartadas (lido como ISO-8859-1).") e o sublinhado das palavras
importadas sai na hora, sem novo pedido ao servidor. Com a camada no limite (16 arquivos, 200.000
palavras ou 20 MiB), a importação é recusada com uma mensagem: remova uma lista antes.

**Listas importadas.** Abaixo do botão ficam as listas da camada (todos os `.txt` dela, menos o
`pessoal.txt`), cada uma com o número de palavras. "Renomear" abre um campo com o nome: Enter
renomeia, Esc desiste, e o foco volta ao botão. "Remover" pede confirmação ("Remover
“termos-medicos” e suas 50.000 palavras?" → "Confirmar remoção"; Esc ou "Cancelar" desistem) e leva
a lista e os arquivos do Hunspell dela; o foco vai à lista seguinte. Como ao remover uma palavra, o
sublinhado volta na próxima verificação. O `pessoal.txt` não pode ser renomeado nem removido, e
nenhuma lista pode passar a se chamar "pessoal".

Os dicionários não vão ao servidor LanguageTool: o app tira da resposta os erros de ortografia de
palavras conhecidas. Plugins de terceiros aprovados conseguem ler e regravar o dicionário deste
computador, que vale em todas as pastas; numa pasta com nomes de pacientes ou de clientes, use
"Esta pasta" (veja [Segurança dos plugins](plugins.md#segurança)).

**Dicionário antigo.** Até a versão 0.1.2, "Adicionar ao dicionário" gravava a palavra no
`data.json` do plugin (`.simplemd/plugins/simplemd.languagetool/data.json`, chave `dictionary`), só
para a pasta. Na primeira vez que o plugin liga numa pasta, essas palavras passam para o
`.simplemd/dictionaries/pessoal.txt` dela, e só depois de gravadas saem do `data.json`; se a
gravação falhar, nada sai e a próxima vez tenta de novo. Uma palavra fora do formato acima continua
no `data.json`.

## Ortografia offline

O app tem também um **corretor ortográfico offline** (o plugin interno `simplemd.spell`: sem
servidor, sem rede). Quando ele está ligado e cobre a língua da nota — o `lang:` do front matter
(sem ele, português do Brasil) — a **ortografia fica com ele**: o LanguageTool deixa de pedir os
erros de ortografia daquela nota (o pedido vai com a categoria `TYPOS` desligada) e descarta
qualquer erro de ortografia que ainda venha na resposta, para a mesma palavra não ser sublinhada
duas vezes. Gramática, pontuação e estilo continuam com o LanguageTool, como sempre.

Quando o corretor liga, desliga ou recarrega o dicionário, o LanguageTool apaga os diagnósticos e
verifica de novo o trecho visível. Numa nota cuja língua o corretor não cobre (por exemplo
`lang: en-US`), o LanguageTool verifica a ortografia como sempre.

## Privacidade

- O texto vai **só** para o servidor em `127.0.0.1:8081` (ou `[::1]:8081`) deste computador, e só
  com o plugin ligado. Com ele desligado, nada é enviado.
- Front matter, blocos e trechos de código, fórmulas (`$…$`, `$$…$$`), endereços de links e de
  imagens, alvos de `[[wikilinks]]` e tags HTML **não são verificados**. Quando ficam entre dois
  trechos verificados do mesmo pedido, eles vão ao servidor local como marcação (sem verificação),
  para que as posições dos erros no texto continuem certas.
- O registro do app guarda só contagens e tempos dos pedidos, nunca trechos da nota.
- O LanguageTool não tem senha: qualquer programa deste computador que esteja escutando na porta
  8081 recebe o texto enviado. Use um servidor que você mesmo instalou.

## Solução de problemas

| Sintoma                                                         | O que fazer                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "servidor não encontrado em localhost:8081"                     | Suba o servidor (seção acima) e confira com o `curl`. O simpleMD tenta de novo sozinho depois de 30 s, 1, 2 e 5 minutos (e a cada 5 minutos), ao voltar para a janela do app e em "Tentar de novo". Quando o servidor volta, o modo automático verifica a nota inteira de novo (no manual, use "Verificar ortografia e gramática agora"). No Windows, com o servidor parado, a porta fechada não recusa a conexão na hora: o aviso pode levar até ~1,4 s (dois endereços × 700 ms). |
| "sem resposta (tempo esgotado)" logo depois de subir o servidor | A primeira verificação de um servidor recém-iniciado pode passar de 15 s enquanto o Java aquece. Espere alguns segundos e use "Tentar de novo".                                                                                                                                                                                                                                                                                                                                     |
| "erro 413"                                                      | O pedido foi grande demais para a configuração do servidor; o simpleMD já manda no máximo 20.000 caracteres por vez. Confira `maxTextLength` no `server.properties`.                                                                                                                                                                                                                                                                                                                |
| "erro 500" ou outro número                                      | O servidor falhou; veja o terminal (ou `docker logs languagetool`).                                                                                                                                                                                                                                                                                                                                                                                                                 |
| "erro resposta inválida" / "erro resposta grande demais"        | A resposta não tinha o formato esperado ou passou de 2 MB e foi descartada inteira. Atualize o LanguageTool.                                                                                                                                                                                                                                                                                                                                                                        |
| Outro programa já usa a porta 8081                              | O simpleMD só fala com a porta 8081 (não é configurável). Pare o outro programa ou mude a porta dele.                                                                                                                                                                                                                                                                                                                                                                               |
| Uma língua não é reconhecida                                    | Confira se o servidor tem a língua na lista do `curl` e use o código dela (`longCode`) no `lang:` do front matter.                                                                                                                                                                                                                                                                                                                                                                  |
