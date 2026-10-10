# Snippets LaTeX

Plugin interno **"Snippets LaTeX"** (`simplemd.latex-snippets`), **desligado por padrão**. Liga em
Configurações → Plugins. Porte da parte CodeMirror 6 do
[obsidian-latex-suite](https://github.com/artisticat1/obsidian-latex-suite) 1.9.8 (commit
`5db51cf`, MIT; atribuição em `THIRD-PARTY-NOTICES.md`), sem o pacote `obsidian`.

## Onde vale

- **Matemática** = `$…$` em linha e blocos `$$…$$`, pelas **mesmas regras** de delimitação do plugin
  KaTeX (Pandoc: `$` de abertura sem espaço depois; de fechamento sem espaço antes nem dígito
  depois; `\$` é cifrão; `$$` nunca abre fórmula em linha; bloco = parágrafo cuja primeira linha é
  só `$$` até a próxima linha só `$$`).
- Enquanto você digita, a fórmula ainda sem o fechamento também conta: um `$` de abertura válido
  sem `$` de fechamento na linha (ex.: `$x/2` vira `$\frac{x}{2}`), o par vazio `$|$` e um bloco
  cuja linha `$$` ainda não foi fechada.
- **Atenção a preços:** um `$` seguido de número, sem `$` de fechamento, também conta como fórmula
  até o fim da linha. Com o plugin ligado, `Custa $5` seguido de `/` vira `Custa $\frac{5}{}`
  (um ⌘Z desfaz). Para escrever cifrão literal, use `\$` (`Custa \$5/mês`).
- **Nunca** dentro de código (em linha, cercado, indentado), front matter ou HTML (bloco, tag ou
  comentário). A opção `c` do latex-suite (expandir em código) fica desativada.
- Fora de matemática valem só os snippets de texto (opção `t`, ex.: `mk` → `$|$`, `dm` → bloco).

## Como dispara

| O quê                            | Tecla                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| Snippets automáticos (opção `A`) | ao digitar                                                                                      |
| Demais snippets                  | **Expandir snippet LaTeX** (⌘⇧E / Ctrl+Shift+E), sempre; e Tab com "Tecla Tab no editor" ligada |
| Próximo / anterior campo         | ⌘⌥→ / ⌘⌥← (Ctrl+Alt+→/← fora do macOS), sempre; Tab / Shift-Tab com a chave ligada              |
| Encerrar os campos               | Esc (ou sair da região com o cursor)                                                            |

Nada expande durante composição de IME. Cada expansão é **um passo de desfazer**: ⌘Z logo depois
devolve o texto do gatilho.

Campos (paradas): o campo ativo é a seleção; os pendentes têm sublinhado pontilhado (campo vazio =
um pequeno espaço pontilhado); o último campo não tem marca. Anúncios: "Campo <i> de <n>" (na
primeira vez, com o atalho), "Campos encerrados." e "Nenhum snippet LaTeX para expandir aqui.".
Na sintaxe do latex-suite, `$0` é o **primeiro** campo e os demais seguem em ordem crescente.

## Opções do plugin (padrão: ligadas)

- **Fração automática** — `/` depois de um termo: `x/` → `\frac{x}{}`, `(a+b)/` → `\frac{a+b}{}`,
  `\pi/`, `2^{n}/`. Com seleção, a seleção vira o numerador.
- **Atalhos de matriz** — dentro de `matrix`, `pmatrix`, `bmatrix`, `Bmatrix`, `vmatrix`, `Vmatrix`,
  `array`, `align`, `gather` e `cases`: Enter → `\\` (+ nova linha no bloco); Tab → `&` (só com
  a chave Tab).
- **Sair do par com Tab** (só com a Tecla Tab no editor) — Tab pula o próximo `}`, `)`, `]`, `>`,
  `|`, `\rangle` ou o fim da fórmula; digitar `)`/`]`/`}` em frente ao mesmo caractere passa por cima.
- **Ampliar delimitadores** — `( … )` com `\sum`, `\int`, `\frac`, `\prod`, `\bigcup`, `\bigcap`
  vira `\left( … \right)` (também `[ ]`, `\{ \}`, `\langle \rangle`, `\lvert \rvert`, `\lVert \rVert`,
  `\lceil \rceil`, `\lfloor \rfloor`).
- **Snippets desta pasta** — informa se há `.simplemd/latex-snippets.json` e quantos valem/ignorados.

## Conjunto padrão

É o `default_snippets.js` do latex-suite 1.9.8 convertido para dados
(`packages/plugins-internal/src/latex-snippets/data/default-snippets.json`, 206 entradas, com as
variáveis `${GREEK}`, `${SYMBOL}` e `${MORE_SYMBOLS}` de `default-snippet-variables.json`). Exemplos:
letras gregas `@a` `@b` `@G` `:e` `ome`; `sr` `cb` `rd` `_` `sq` `//` `ee` `invs`; subscrito
automático `x2` → `x_{2}`; `xhat` `xbar` `xvec`…; `ooo` `sum` `prod` `lim` `+-` `...` `xx` `!=`
`<=` `->` `=>` `inn` `RR` `CC`; `dint` `oinf` `infi`; matrizes `pmat` `bmat` (bloco quebra linhas,
em linha não), `cases` `align` `array`; visuais (com seleção) `U` `O` `B` `C` `K` `S` e `(` `[`
`{`; pares `avg` `norm` `ceil` `floor` `lr(`…; `tayl`; `iden1`…`iden6`.

### O que mudou em relação ao padrão do upstream

- `iden(\d)` era uma **função JavaScript** que gerava a matriz identidade n × n. Snippets nunca
  executam código no simpleMD, então ela virou **seis snippets de dados** fixos, `iden1`…`iden6`
  (mesma saída para n = 1…6; n ≥ 7 não existe), cada um com a descrição do upstream com o n
  trocado (`N x N identity matrix` → `2 x 2 identity matrix` etc.). Era a única função do conjunto
  padrão; nenhuma outra foi retirada.
- Gatilhos `RegExp` do arquivo `.js` viraram texto com a opção `r` (mesmo padrão, sem flags).
- As variáveis `${GREEK}`, `${SYMBOL}` e `${MORE_SYMBOLS}` são trocadas em **todas** as ocorrências
  do gatilho (o upstream trocava só a primeira).
- Os trechos que o upstream deixa comentados (travessões, letras soltas viram fórmula) continuam
  fora.

## Snippets desta pasta: `.simplemd/latex-snippets.json`

Uma **lista JSON** (até 256 KB; só leitura) de objetos:

```json
[
  { "trigger": "qq", "replacement": "\\quad ", "options": "mA" },
  { "trigger": "vv(\\w)", "replacement": "\\vec{[[0]]}", "options": "rmA", "description": "vetor" },
  { "trigger": "nn", "replacement": "\\cap $0", "options": "m", "priority": 1 }
]
```

| Campo         | Regra                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trigger`     | texto não vazio, até 200 caracteres; com `r`, expressão regular (ancorada no cursor; grupos `[[0]]`, `[[1]]`… na substituição; variáveis `${GREEK}` etc. valem)                             |
| `replacement` | **sempre texto**: nada é executado; algo como `(m) => m[1]` é inserido literalmente. `$0`, `$1`… e `${1:texto}` são campos; `${VISUAL}` torna o snippet visual                              |
| `options`     | só as letras `A` (automático), `r` (regex), `m` (matemática), `M` (só bloco), `n` (só em linha), `t` (texto), `v` (visual), `w` (limite de palavra). Sem letra de modo = texto e matemática |
| `flags`       | opcional, só `i`, `s`, `u` (`m` não: o gatilho tem de terminar no cursor, nunca no fim de uma linha anterior). A regex é **sempre** compilada com `u`                                       |
| `priority`    | opcional, número (maior primeiro; empate = gatilho mais longo)                                                                                                                              |
| `description` | opcional, texto                                                                                                                                                                             |

Entradas inválidas são **puladas** e um aviso diz quantas ("3 snippets ignorados em
.simplemd/latex-snippets.json."). São inválidas: forma errada (sem `replacement` de texto etc.),
opção `c` ou letra desconhecida, flag desconhecida, gatilho vazio ou com mais de 200 caracteres,
regex que não compila **com a flag `u`** (ex.: `{` ou `}` soltos — escreva `\{`/`\}`, como em
`\\hat\{([A-Za-z])\}(\d)`; `\u{1,}` ou `\k<` sem grupo nomeado), regex com mais de 1024
caracteres depois das variáveis e regex fora do
orçamento de desempenho. O orçamento é conferido **sem executar** a regex, sobre o padrão já com
as variáveis:

- grupo repetido (`*`, `+`, `?`, `{m,n}`) que contém outra repetição ou alternância é recusado
  (`(a+)+`, `(xx?)+`, `(a|a)*`, `(${GREEK})+`);
- no resto, conta-se de quantas formas o padrão pode casar o mesmo trecho dos 100 caracteres
  (repetições, `?` e alternâncias se multiplicam em sequência). Dois `\w*` em sequência cabem; três
  não, nem `a?a?a?…` longo;
- o arquivo inteiro tem um orçamento somado: a regex que passaria dele é ignorada e contada.

Arquivo que não é JSON, não é lista ou passa de 256 KB é ignorado inteiro, com aviso. As regex
são compiladas uma vez e testadas só contra os 100 caracteres antes do cursor; o casamento tem de
terminar no cursor. O arquivo é relido quando muda (vale sempre a leitura mais recente).

## Fora do escopo

Conceal, prévia flutuante de fórmula e colchetes coloridos do latex-suite (o KaTeX já desenha as
fórmulas); funções JavaScript em snippets; blocos de código `math` como matemática.
