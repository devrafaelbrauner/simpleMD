<!-- Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Origem: specs/features/ShiftTabBehaviourOverride.spec.md. -->

# Shift-Tab should outdent line

- applyState:

```md
- qwe
  - qwe|
```

- keydown: `Shift-Tab`
- assertState:

```md
- qwe
- qwe|
```

# Shift-Tab should outdent children

- applyState:

```md
- qwe
  - qwe|
    - qwe
```

- keydown: `Shift-Tab`
- assertState:

```md
- qwe
- qwe|
  - qwe
```

# Shift-Tab should outdent in case #144

- applyState:

```md
- qwe
  - qwe
    - qwe
  - qwe
  - qwe|
```

- keydown: `Shift-Tab`
- assertState:

```md
- qwe
  - qwe
    - qwe
  - qwe
- qwe|
```
