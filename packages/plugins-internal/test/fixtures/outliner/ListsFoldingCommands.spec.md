<!-- Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Origem: specs/features/ListsFoldingCommands.spec.md. -->

# should fold

- applyState:

```md
- one|
  - two
```

- execute: `obsidian-outliner:fold`
- assertState:

```md
- one| #folded
  - two
```
