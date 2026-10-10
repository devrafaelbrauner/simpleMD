<!-- Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Origem: specs/services/ChangesApplicator.spec.md. -->

# should keep foldind on change

- applyState:

```md
- one #folded
  - two
- three|
```

- execute: `obsidian-outliner:move-list-item-up`
- assertState:

```md
- three|
- one #folded
  - two
```

# should keep foldind on change, issue #236

- applyState:

```md
- one
  - two #folded
    - three
  - four|
  - five
```

- keydown: `ArrowRight`
- assertState:

```md
- one
  - two #folded
    - three
  - four
  - |five
```

# should keep subfoldind on change, issue #258

- applyState:

```md
- one
  - two
    - three|
      - four
  - five
```

- execute: `obsidian-outliner:fold`
- keydown: `ArrowUp`
- assertState:

```md
- one
  - two|
    - three #folded
      - four
  - five
```

- execute: `obsidian-outliner:fold`
- keydown: `ArrowDown`
- keydown: `Cmd-ArrowRight`
- assertState:

```md
- one
  - two #folded
    - three  #folded
      - four
  - five|
```

- execute: `obsidian-outliner:move-list-item-up`
- assertState:

```md
- one
  - five|
  - two #folded
    - three #folded
      - four
```
