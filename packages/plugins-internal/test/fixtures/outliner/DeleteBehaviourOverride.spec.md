<!-- Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Origem: specs/features/DeleteBehaviourOverride.spec.md. -->

# delete should remove next item if cursor is on the end

- applyState:

```md
- qwe|
  - ee
```

- keydown: `Delete`
- assertState:

```md
- qwe|ee
```

# delete should remove next item if cursor is on the end and have notes

- applyState:

```md
- qwe
  notes|
  - ee
```

- keydown: `Delete`
- assertState:

```md
- qwe
  notes|ee
```

# delete should remove next line if cursor is on the end and have notes

- applyState:

```md
- qwe|
  notes
  - ee
```

- keydown: `Delete`
- assertState:

```md
- qwe|notes
  - ee
```

# delete should remove next line if cursor is on the end, issue #175

- applyState:

```md
- 1
- 2|

3
```

- keydown: `Delete`
- keydown: `Delete`
- assertState:

```md
- 1
- 2|3
```
