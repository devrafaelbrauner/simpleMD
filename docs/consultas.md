# Consultas de tarefas e notas

O plugin interno **Tarefas e consultas** (`simplemd.tasks`, ligado por padrão em Configurações →
Plugins) transforma blocos de código ```` ```tasks ```` e ```` ```dataview ```` numa lista viva de
tarefas ou notas da pasta aberta. As consultas leem o índice do vault (`.simplemd/index.json`): não
abrem as notas, não rodam código e não saem do computador.

- Com o cursor **fora** do bloco, ele aparece como resultado (lista, tabela ou tarefas).
- Com o cursor **dentro**, o bloco volta a ser texto para editar.
- Com o plugin **desligado**, os blocos ficam como código comum, no editor e na exportação.

As duas linguagens são **inspiradas** no [Obsidian Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks)
e no [Dataview](https://github.com/blacksmithgu/obsidian-dataview) (licença MIT; nenhum código
copiado para as consultas). São subconjuntos: o que não está nesta página não é aceito, e o bloco
mostra uma mensagem de erro em vez de resultados.

## Tarefas

Uma tarefa é uma linha de lista com caixa, em qualquer nota:

```markdown
- [ ] Enviar o orçamento revisado 📅 2026-10-12 ⏫ #trabalho
- [x] Pagar a conta de luz ✅ 2026-10-09
- [/] Revisar o capítulo 2 🛫 2026-10-01 🔁 every week
- [-] Reunião cancelada ❌ 2026-10-02
```

| Caixa | Estado |
|---|---|
| `[ ]` (e qualquer outro caractere) | a fazer |
| `[x]` ou `[X]` | feita |
| `[/]` | em andamento |
| `[-]` | cancelada |

| Sinal | Campo |
|---|---|
| 📅 | vencimento (`due`) |
| ⏳ | agendada (`scheduled`) |
| 🛫 | início (`start`) |
| ➕ | criada (`created`) |
| ✅ | concluída (`done`) |
| ❌ | cancelada |
| 🔺 ⏫ 🔼 🔽 ⏬ | prioridade máxima, alta, média, baixa, mínima (sem sinal = nenhuma) |
| 🔁 | regra de repetição |

Datas só no formato `AAAA-MM-DD`. Uma data que não existe (`2026-13-45`) é ignorada e o resultado
mostra "data inválida".

## Bloco `tasks`

Uma instrução por linha; maiúsculas e minúsculas tanto faz nas instruções. Todas as instruções de
filtro precisam valer ao mesmo tempo. Linhas em branco são ignoradas.

````markdown
```tasks
not done
due before 2026-10-15
tags include #trabalho
sort by due
limit 20
```
````

### Filtros

| Instrução | Mostra |
|---|---|
| `done` | feitas e canceladas (`[x]`, `[X]`, `[-]`) |
| `not done` | a fazer e em andamento |
| `due before <data>` · `due after <data>` · `due on <data>` | pela data de vencimento |
| `scheduled …` · `starts …` · `done …` · `created …` | idem para agendada, início, conclusão e criação |
| `has due date` · `no due date` | com ou sem vencimento (também `scheduled`, `start`, `done`) |
| `path includes <texto>` · `path does not include <texto>` | pelo caminho da nota (sem diferença de caixa) |
| `tags include <#tag>` · `tags do not include <#tag>` | pelas tags da tarefa (`tag includes …` também vale); `#trabalho` acha `#trabalho/reuniao` |
| `description includes <texto>` · `description does not include <texto>` | pelo texto da tarefa (sem diferença de caixa) |
| `priority is <nível>` · `priority is above <nível>` · `priority is below <nível>` | níveis `highest`, `high`, `medium`, `none`, `low`, `lowest` |
| `is recurring` · `is not recurring` | com ou sem 🔁 |

`<data>` é `AAAA-MM-DD`, `today`, `tomorrow` ou `yesterday`. "Hoje" segue o fuso do computador e
muda à meia-noite (ou quando a janela volta ao foco).

Como no Obsidian Tasks, `starts before/after/on` também mostra tarefas **sem** data de início (uma
tarefa sem início já pode começar). As outras datas exigem o campo.

### Combinações

Filtros entre parênteses combinam com `AND`, `OR` e `NOT` (em maiúsculas):

```text
(due before today) AND (priority is high)
(tags include #casa) OR (tags include #compras)
NOT (done)
((due before today) OR (is recurring)) AND NOT (path includes arquivo)
```

`NOT` vale mais que `AND`, que vale mais que `OR`; use parênteses para outra ordem.

### Ordem, grupos e limite

| Instrução | Efeito |
|---|---|
| `sort by <campo>` · `sort by <campo> reverse` | `due`, `scheduled`, `start`, `done`, `priority`, `path`, `description`; várias linhas = desempate na ordem escrita. Sem data vai para o fim; `priority` começa pela máxima. Sem `sort by`, a ordem é a do caminho da nota e da linha. |
| `group by <campo>` | `path`, `folder`, `filename`, `due`, `priority`, `tags`. Várias linhas formam um grupo por combinação, com o rótulo "a › b". Em `tags`, a tarefa aparece em cada tag. |
| `limit <n>` | no máximo `n` resultados (até 1.000; acima disso é erro). Sem `limit`, no máximo 1.000. |
| `hide <campo>` · `show <campo>` | esconde ou mostra `due date`, `scheduled date`, `start date`, `done date`, `priority`, `recurrence rule` ou `backlink` (a origem) |
| `short mode` | só a descrição e a origem, sem os metadados |

Uma linha fora desta lista gera o erro **"Instrução não reconhecida na linha N: …"** e nenhum
resultado.

## Bloco `dataview`

Subconjunto da linguagem DQL do Dataview. Palavras-chave sem diferença de caixa.

````markdown
```dataview
TABLE autor, ano AS "Ano"
FROM "livros" and #romance
WHERE lido = true
SORT ano DESC
LIMIT 10
```
````

### Tipo da consulta

| Forma | Resultado |
|---|---|
| `LIST` · `LIST <expressão>` | uma linha por nota (link da nota + o valor, se houver) |
| `TABLE <expressão> [AS "rótulo"], …` | tabela; a primeira coluna ("Nota") é o link da nota |
| `TASK` | as tarefas das notas, com caixa para marcar |

### Cláusulas

| Cláusula | Uso |
|---|---|
| `FROM` (logo depois do tipo) | `#tag` (inclui subtags), `"pasta"` (ou `"pasta/nota.md"`), `[[nota]]` (notas que apontam para ela, com wikilink ou link `.md`), combinados com `and`, `or`, `-`/`!`/`not` e parênteses |
| `WHERE <expressão>` | pode repetir; todas valem |
| `SORT <expressão> [ASC\|DESC], …` | vazios por último, também em `DESC` |
| `GROUP BY <expressão>` | um rótulo por valor (os grupos seguem a ordem do valor) |
| `LIMIT <n>` | até 1.000 (acima disso é erro); sem `LIMIT`, no máximo 1.000 |

### Expressões

- Campos da nota: `file.name`, `file.path`, `file.folder`, `file.mtime`, `file.size`,
  `file.tags` e as chaves do front matter (sem diferença de caixa no nome).
- Em `TASK`, também os campos da tarefa: `completed` (só `[x]`/`[X]`), `status` (o caractere da
  caixa), `text`, `due`, `scheduled`, `start`, `done`, `priority`, `tags`.
- `priority` usa os nomes do bloco `tasks`: `priority = "high"`, `priority > "medium"`.
- Valores: textos entre aspas, números, `true`, `false`, `null`.
- Comparações `=`, `!=`, `<`, `<=`, `>`, `>=`; lógica `and`, `or`, `!`; parênteses.
- Só duas funções: `contains(a, b)` (texto contém, ou lista com elemento que contém) e
  `date(AAAA-MM-DD)` / `date(today)` (também `tomorrow`, `yesterday`). Um texto `AAAA-MM-DD` do
  front matter é comparado como data quando o outro lado é `date(…)`.
- Valor ausente aparece como `-`.

### Fora do subconjunto

Estas construções do Dataview completo geram **"Não suportado nas consultas do simpleMD:
<construção> (linha N)."**: `FLATTEN`, `CALENDAR`, `WITHOUT ID`, campos inline (`chave::`),
qualquer outra função (`length()`, `dateformat()`, …), aritmética (`+ - * / %`), outros campos
`file.*` (`file.ctime`, `file.link`, …) e campos com ponto (`autor.nome`). Texto que não forma a
gramática gera "Instrução não reconhecida na linha N: …".

Blocos ```` ```dataviewjs ```` e consultas que começam com `$=` mostram **"Consultas em JavaScript
não são suportadas"**. Nada do bloco é executado. Consultas em linha (`` `= …` ``) não são
interpretadas e ficam como código.

## No editor

- O cabeçalho mostra "N resultados"; sem resultado, "Nenhum resultado". Enquanto o índice é
  construído aparece "Indexando…".
- Clique na caixa de uma tarefa para marcar ou desmarcar. A mudança vai para a nota da tarefa: se
  ela está aberta numa aba, no editor dessa aba (dá para desfazer lá); senão, gravada no arquivo
  com conferência do conteúdo. Se a linha mudou no disco, nada é gravado e aparece "A tarefa mudou
  no arquivo; a consulta foi atualizada". Concluir acrescenta ` ✅ AAAA-MM-DD` (opção "Registrar
  data de conclusão") e cria a próxima repetição de `every …`.
- ⌘-clique (Ctrl-clique fora do macOS) na origem "Nota › linha N" abre a nota na linha da tarefa.
- Teclado: com o cursor no bloco (ou na linha vizinha), **⌘⇧Enter** (Ctrl+Shift+Enter) entra nos
  resultados. ↑/↓, Home/End e PageUp/PageDown percorrem; **Espaço** marca a tarefa; **Enter** abre
  a nota; **Esc** ou Shift-Tab voltam ao início do bloco; **Tab** vai para a linha depois do bloco.
- Os resultados se atualizam até 1 s depois de uma nota ser salva. Consultas fora da área visível
  só são avaliadas quando aparecem.

## Na exportação

HTML e PDF levam um **instantâneo** dos resultados na hora da exportação: o mesmo conteúdo do
editor, sem controles — caixas como `☐`/`☑` e a origem como texto. Com o plugin desligado, os
blocos saem como código.
