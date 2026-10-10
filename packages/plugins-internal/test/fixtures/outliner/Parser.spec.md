<!-- Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Origem: specs/services/Parser.spec.md. -->

# should ignore space on last line


- applyState:

```md
- one
  - two
  - three|
 
```

- execute: `obsidian-outliner:move-list-item-up`
- assertState:

```md
- one
  - three|
  - two
 
```
