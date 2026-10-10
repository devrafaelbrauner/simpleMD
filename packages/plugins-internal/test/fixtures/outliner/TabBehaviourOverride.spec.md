<!-- Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Origem: specs/features/TabBehaviourOverride.spec.md. -->

# Tab should indent line

- applyState:

```md
- qwe
- qwe|
```

- keydown: `Tab`
- assertState:

```md
- qwe
  - qwe|
```

# Tab should indent children

- applyState:

```md
- qwe
- qwe|
  - qwe
```

- keydown: `Tab`
- assertState:

```md
- qwe
  - qwe|
    - qwe
```

# Tab should not indent line if it's no parent

- applyState:

```md
- qwe
  - qwe|
```

- keydown: `Tab`
- assertState:

```md
- qwe
  - qwe|
```

# Tab should keep cursor at the same text position

- applyState:

```md
- qwe
  - qwe
  - q|we
```

- keydown: `Tab`
- assertState:

```md
- qwe
  - qwe
    - q|we
```

# Tab should keep numeration

- applyState:

```md
1. one
    1. two
    2. three|
    3. four
```

- keydown: `Tab`
- assertState:

```md
1. one
    1. two
        1. three|
    2. four
```
