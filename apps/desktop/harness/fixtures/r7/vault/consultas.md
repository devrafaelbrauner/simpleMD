# Consultas

## tasks

```tasks
not done
```

```tasks
done
```

```tasks
not done
due before 2026-10-15
sort by due
```

```tasks
priority is high
```

```tasks
tags include #trabalho
group by filename
```

```tasks
not done
path includes tarefas
limit 5
```

```tasks
is recurring
```

```tasks
has due date
sort by priority
limit 10
```

```tasks
description includes relatório
```

```tasks
status.type is CANCELLED
```

## dataview

```dataview
TASK
FROM "tarefas"
WHERE !completed
```

```dataview
TABLE autor, ano, nota
FROM "livros"
SORT ano ASC
```

```dataview
LIST
FROM #romance
```

```dataview
TABLE nota
FROM "livros"
WHERE lido = true
SORT nota DESC
```

```dataview
LIST
FROM [[Bolo]]
```

```dataview
TASK
WHERE contains(text, "bolo")
```

```dataview
TABLE autor
FROM "livros"
WHERE ano > 1900
LIMIT 2
```

```dataview
LIST file.name
FROM "diario"
```

```dataview
TASK
FROM "tarefas/projeto-a.md"
GROUP BY completed
```

```dataview
TABLE length(file.tasks) AS tarefas
FROM "tarefas"
```

## Recusadas

```dataview
TABLE x FLATTEN y
```

```dataviewjs
dv.paragraph("nunca executa")
```

```tasks
instrução inventada
```
