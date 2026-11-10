# Ortografia offline

O plugin interno **Ortografia offline** (`simplemd.spell`) sublinha as palavras que não estão no
dicionário de português do Brasil que vem com o app (o VERO, pt_BR, embutido) nem no **seu
dicionário**. Funciona sem internet e sem servidor: a verificação roda no próprio app e o texto não
sai do computador. Ele vem **ligado**; para desligar, use Configurações → **Plugins** → "Ortografia
offline" (a escolha vale para a pasta e fica no `.simplemd/config.json` dela).

Com o corretor desligado numa pasta, o dicionário embutido (cerca de 29 MiB na memória) nem é
carregado ao abrir a pasta.

## O que é verificado

- **Só o texto de leitura.** Front matter, blocos e trechos de código, fórmulas (`$…$`, `$$…$$`),
  endereços de links e de imagens, alvos de `[[wikilinks]]` (o apelido depois do `|` é verificado),
  HTML e as marcas do Markdown ficam de fora — as mesmas regras do LanguageTool.
- **Palavra** é uma sequência de letras; hífen e apóstrofo entre letras fazem parte dela
  ("guarda-chuva", "d’água" ou "d'água"). Não são verificadas: uma letra sozinha, siglas (todas as
  letras em maiúsculas, como "IBGE"), palavras coladas a número, `_`, `@` ou `#` no próprio texto
  (código, e-mail, etiquetas: `snake_case`, `abc1`) e palavras com mais de 64 caracteres. A marca de
  ênfase não cola: `_palavra_` e `__palavra__` são verificadas, como `*palavra*`.
- **Só o trecho que está na tela e o que você edita.** A nota é verificada ao abrir, 400 ms depois
  de você parar de digitar e 150 ms depois de rolar. Partes da nota que ainda não apareceram na tela
  não são verificadas: o painel "Problemas" lista o que já passou pela tela.
- A palavra que você está **escrevendo** espera o cursor sair dela para ser sublinhada (nada de
  sublinhado no meio da palavra). Parar o cursor numa palavra não a esconde.

## Língua

- A língua da nota é a do `lang:` do front matter (por exemplo `lang: pt-BR`). Sem `lang:`, vale
  **português do Brasil** — ou, com o LanguageTool ligado, o **Idioma padrão** dele (português do
  Brasil em "Automático").
- Só português do Brasil é verificado. Numa nota em outra língua (`lang: en-US`, `lang: pt-PT`…)
  nada é sublinhado.
- **Notas em inglês sem `lang:`** são verificadas como português e quase toda palavra fica
  sublinhada: ponha `lang: en-US` no front matter (ou desligue o corretor nessa pasta). Com o
  LanguageTool ligado em English, as notas sem `lang:` ficam com ele.

## O cartão

Passe o ponteiro sobre a palavra sublinhada ou ponha o cursor nela e use **⌘⇧↩**
(**Ctrl+Shift+Enter**): o cartão "Ortografia" diz "“palavra” não está no dicionário (Português do
Brasil)." e traz:

- **Trocar por “sugestão”** (até 5): troca a palavra pela sugestão, como texto, num passo só de
  desfazer (⌘Z / Ctrl+Z volta a palavra). Só sugestões que são palavras (letras, com hífen,
  apóstrofo ou espaço entre elas) viram botão: nada com marcação do Markdown ou do HTML (`<`, `[`,
  `*`, `_`, `#`, `&`…), número ou pontuação.
- **Ignorar**: esconde a palavra em todas as notas **desta janela** até você fechá-la. Nada é
  gravado; numa janela nova (ou ao abrir o app de novo), ela volta a ser sublinhada.
- **Adicionar ao dicionário**: grava a palavra no `pessoal.txt` da camada escolhida em "Adicionar
  palavras ao" (abaixo); o sublinhado sai depois de gravado, em todas as notas abertas.

Com o foco no cartão, Tab e Shift+Tab passam pelos botões e Esc fecha e volta ao texto. **⌘⇧M**
(**Ctrl+Shift+M**) abre o painel "Problemas"; **F8**/**Shift+F8** vão ao próximo/anterior. O cartão,
o painel e os atalhos são os mesmos do Lint e do LanguageTool.

As sugestões chegam logo depois do sublinhado, primeiro para as palavras mais perto do cursor (até
20 da tela). Se o cartão estiver aberto quando a sugestão chegar, ele pode fechar: abra de novo.

## Opções

Configurações → Plugins → **Opções** de "Ortografia offline":

- **Adicionar palavras ao**: **Este computador** (padrão; vale em todas as pastas abertas aqui) ou
  **Esta pasta** (fica em `.simplemd/dictionaries/pessoal.txt` e viaja com a pasta).
- **Dicionário**: a lista das duas camadas, a mesma das opções do LanguageTool — buscar, remover
  palavras e importar, renomear ou remover listas de termos (veja
  [`languagetool.md`](languagetool.md#dicionário)). Uma palavra removida volta a ser sublinhada na
  próxima verificação daquele trecho.

Quando o seu dicionário muda (uma palavra adicionada, uma lista importada, um `.txt` da pasta
alterado por outro programa), o corretor recarrega as camadas um quarto de segundo depois; as
palavras que passaram a valer deixam de ser sublinhadas na hora.

## Com o LanguageTool

Os dois podem ficar ligados juntos, e **um erro de ortografia aparece uma vez só**: na nota que o
corretor offline cobre, o LanguageTool deixa a ortografia com ele (não pede nem mostra erros de
ortografia) e continua com a gramática, a pontuação e o estilo. Numa nota em outra língua, ou sem
`lang:` com o Idioma padrão do LanguageTool fora do português do Brasil, a ortografia fica com o
LanguageTool. Veja [`languagetool.md`](languagetool.md#ortografia-offline).

## Privacidade

- Nada vai para a rede. As palavras da nota vão só ao motor de ortografia dentro do app (no Rust), e
  só as da tela e as editadas.
- "Ignorar" nunca é gravado. "Adicionar ao dicionário" grava só a palavra, no `pessoal.txt` da
  camada escolhida.
- O registro do app guarda só contagens (quantas palavras foram verificadas), nunca palavras.
- Plugins de terceiros que você aprovou também conseguem perguntar ao motor se uma palavra existe —
  inclusive as do seu dicionário. Veja [Segurança em `plugins.md`](plugins.md#segurança).

## Limites

- Até 20.000 palavras por pedido ao motor, um pedido por vez; as respostas ficam guardadas (até
  50.000 palavras) até o dicionário mudar. Digitar nunca espera o motor.
- Num trecho da tela com mais de 50.000 palavras diferentes (uma linha enorme, sem quebra), só as
  primeiras 50.000 são verificadas; as outras ficam sem sublinhado.
- Se o motor estiver ocupado (`TIMEOUT`), o corretor tenta de novo em 2 s, sem repetir antes disso.

## Solução de problemas

| Sintoma                                                                   | O que fazer                                                                                                                                                 |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Ortografia offline: o dicionário não carregou; nada é sublinhado até a…" | O motor não leu o dicionário ou, ao ligar, outro pedido tomou a vez. Feche e abra a pasta, ou adicione uma palavra ao dicionário; o corretor tenta de novo. |
| Nada é sublinhado numa nota                                               | Confira se o plugin está ligado nesta pasta e o `lang:` da nota (só `pt-BR` é verificado). Com o LanguageTool em inglês, a nota sem `lang:` fica com ele.   |
| Uma palavra certa (nome, termo técnico) aparece sublinhada                | Use "Adicionar ao dicionário" no cartão, ou importe uma lista de termos nas Opções.                                                                         |
| Uma sigla ou um termo com números não é verificado                        | É de propósito: siglas e palavras coladas a números, `_`, `@` ou `#` ficam de fora.                                                                         |
| Uma nota em inglês fica cheia de sublinhados                              | Ponha `lang: en-US` no front matter.                                                                                                                        |
