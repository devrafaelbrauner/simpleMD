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
  - **Dicionário pessoal:** quantas palavras você já adicionou (até 10.000), guardadas nesta pasta,
    em `.simplemd/plugins/simplemd.languagetool/data.json`. Como no LanguageTool, uma palavra
    adicionada em minúsculas vale também com inicial maiúscula ou toda em maiúsculas ("excessão"
    cobre "Excessão" e "EXCESSÃO"); uma adicionada com maiúscula ("Brasil") vale só assim. Se a
    gravação falhar, o sublinhado continua e aparece um aviso.
  - **Regras desativadas:** cada regra desligada pelo cartão, com o botão "Reativar <ID>".

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

| Sintoma                                                         | O que fazer                                                                                                                                                                                         |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "servidor não encontrado em localhost:8081"                     | Suba o servidor (seção acima) e confira com o `curl`. O simpleMD tenta de novo sozinho depois de 30 s, 1, 2 e 5 minutos (e a cada 5 minutos), ao voltar para a janela do app e em "Tentar de novo". |
| "sem resposta (tempo esgotado)" logo depois de subir o servidor | A primeira verificação de um servidor recém-iniciado pode passar de 15 s enquanto o Java aquece. Espere alguns segundos e use "Tentar de novo".                                                     |
| "erro 413"                                                      | O pedido foi grande demais para a configuração do servidor; o simpleMD já manda no máximo 20.000 caracteres por vez. Confira `maxTextLength` no `server.properties`.                                |
| "erro 500" ou outro número                                      | O servidor falhou; veja o terminal (ou `docker logs languagetool`).                                                                                                                                 |
| "erro resposta inválida" / "erro resposta grande demais"        | A resposta não tinha o formato esperado ou passou de 2 MB e foi descartada inteira. Atualize o LanguageTool.                                                                                        |
| Outro programa já usa a porta 8081                              | O simpleMD só fala com a porta 8081 (não é configurável). Pare o outro programa ou mude a porta dele.                                                                                               |
| Uma língua não é reconhecida                                    | Confira se o servidor tem a língua na lista do `curl` e use o código dela (`longCode`) no `lang:` do front matter.                                                                                  |
