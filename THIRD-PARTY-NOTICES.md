# Avisos de terceiros (THIRD-PARTY-NOTICES)

O simpleMD é distribuído sob a licença MIT (`LICENSE`). Este arquivo lista o código de terceiros
portado ou adaptado para o simpleMD e todas as dependências npm de produção, com as licenças e os
avisos que elas exigem (product r7 §7, L-2). Ele é conferido em todo `pnpm lint` por
`scripts/check-licenses.mjs` (L-4):

- toda dependência de produção (`pnpm -r licenses list --prod --json`) precisa de uma linha, com a
  mesma licença, na tabela "Dependências npm de produção"; licenças GPL, AGPL, LGPL, SSPL, ausentes
  ou desconhecidas reprovam (exceções nominais justificadas no próprio script);
- todo arquivo de código dentro de um destino da tabela "Destinos dos portes" precisa começar pelo
  cabeçalho L-3: `// Portado de <repo>@<commit> (<licença>), © <autor>. Modificado para o simpleMD.`

Nenhum código GPL/AGPL é copiado (L-1). O LanguageTool (LGPL-2.1) não é empacotado: o simpleMD só
fala com um servidor local instalado à parte pelo usuário, por HTTP (L-5).

## Código portado ou adaptado

### retronav/ixora

- Repositório: https://codeberg.org/retronav/ixora (espelho https://github.com/retronav/ixora)
- Commit fixado: `1734bce24307fd80c4ea538257efb6f612dc9715` (`main`, pacote `@retronav/ixora`
  0.3.3, 2026-07-20)
- Licença: Apache-2.0 (texto integral abaixo). O upstream não tem arquivo `NOTICE`.
- Copyright: © Pranav Karawale (retronav), autor do pacote.
- Origem → destino: `packages/ixora/src/plugins/blockquote.ts` → `live-preview/blockquote.ts`;
  `hide-mark.ts` → `live-preview/{strikethrough,inline-code}.ts`; `link.ts` → `live-preview/links.ts`;
  `list.ts` → `live-preview/tasks.ts`; `image.ts` + `state/image.ts` →
  `live-preview/images/{element,widget}.ts`; trechos de `util.ts` → `live-preview/context.ts` (todos
  em `packages/core/src/`).
- Apache-2.0 §4(b): **os arquivos de destino foram modificados** pelo simpleMD (algoritmos adaptados
  para contribuidores de uma passada única; arch-frontend r7 D-R7-F23); cada um diz isso no
  cabeçalho L-3.

### silverbulletmd/silverbullet

- Repositório: https://github.com/silverbulletmd/silverbullet
- Commit fixado: `70e58486e5e9d47dbfb13971e8576212896993c8` (tag 2.12.0)
- Licença: MIT. Copyright 2022, Zef Hemel (texto abaixo).
- Origem → destino: `client/markdown_parser/parser.ts` l.33–88 (`WikiLink`) + `constants.ts`
  (`wikiLinkRegex`) → `packages/core/src/wikilinks/syntax.ts`;
  `client/markdown_parser/extended_task.ts` → `packages/core/src/tasks/syntax.ts`.

### artisticat1/obsidian-latex-suite

- Repositório: https://github.com/artisticat1/obsidian-latex-suite
- Commit fixado: `5db51cf36abccdbbfa51184bb5fe86be8157cc2f` (tag 1.9.8)
- Licença: MIT. Copyright (c) 2022 artisticat1 (texto abaixo).
- Origem → destino: `src/snippets/*` → `packages/plugins-internal/src/latex-snippets/engine/` e
  `cm/`; `src/snippets/codemirror/*` → `latex-snippets/cm/`; `src/features/*` →
  `latex-snippets/features/`; `src/default_snippets.js` e `src/default_snippet_variables.js` →
  `latex-snippets/data/*.json` (dados convertidos para JSON, sem comentário possível: a atribuição é
  esta entrada).

### vslinko/obsidian-outliner

- Repositório: https://github.com/vslinko/obsidian-outliner
- Commit fixado: `b51918d4eaa75223780a404c40f2d9406df6a3c0` (tag 4.10.2)
- Licença: MIT. Copyright (c) 2021 Viacheslav Slinko (texto abaixo).
- Origem → destino: `src/root/index.ts`, `src/services/{Parser,ChangesApplicator,OperationPerformer}.ts`
  → `packages/plugins-internal/src/outliner/model/`; `src/operations/*.ts` → `outliner/operations/`;
  `src/utils/*` → `outliner/utils/`; `src/features/*` → `outliner/features/`; testes
  `src/**/__tests__/*.test.ts` e `specs/**/*.spec.md` → `packages/plugins-internal/test/outliner.*`.

### obsidian-tasks-group/obsidian-tasks

- Repositório: https://github.com/obsidian-tasks-group/obsidian-tasks
- Commit fixado: `9173205606e49846f456caf438fdc0e5baded77e` (tag 8.4.0)
- Licença: MIT. Copyright (c) 2021 Clare Macrae, Ilyas Landikov and Martin Schenck (texto abaixo).
- Origem → destino: `src/Task/TaskRegularExpressions.ts`, a tabela de símbolos e as expressões dos
  campos de `src/TaskSerializer/DefaultTaskSerializer.ts` e `src/Task/Priority.ts` →
  `packages/core/src/tasks/line.ts` (adaptados, sem `moment`). A recorrência e as consultas são
  reescritas (só ideias).

### blacksmithgu/obsidian-dataview

- Repositório: https://github.com/blacksmithgu/obsidian-dataview
- Commit de referência: `77ab745aee787d519642a87ed8f68be12fdc4b0d` (tag 0.5.70)
- Licença: MIT. Copyright (c) 2021 Michael Brenan (texto abaixo).
- **Nenhum código copiado**: o parser do subconjunto DQL
  (`packages/plugins-internal/src/tasks/query/dql-parser.ts`) é reescrito, inspirado na gramática de
  `src/query/parse.ts` e `src/expression/parse.ts`.

## Destinos dos portes

Todo arquivo de código (`.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`) que casa com um destino abaixo começa
pelo cabeçalho L-3 da origem da linha. Destino terminado em `/` = tudo dentro da pasta; `*` = qualquer
nome no último trecho. Um porte novo fora destes destinos precisa de uma linha nova aqui.

| Destino                                                  | Origem                                                                         | Licença    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------- |
| `packages/core/src/live-preview/blockquote.ts`           | `retronav/ixora@1734bce24307fd80c4ea538257efb6f612dc9715`                      | Apache-2.0 |
| `packages/core/src/live-preview/strikethrough.ts`        | `retronav/ixora@1734bce24307fd80c4ea538257efb6f612dc9715`                      | Apache-2.0 |
| `packages/core/src/live-preview/inline-code.ts`          | `retronav/ixora@1734bce24307fd80c4ea538257efb6f612dc9715`                      | Apache-2.0 |
| `packages/core/src/live-preview/links.ts`                | `retronav/ixora@1734bce24307fd80c4ea538257efb6f612dc9715`                      | Apache-2.0 |
| `packages/core/src/live-preview/tasks.ts`                | `retronav/ixora@1734bce24307fd80c4ea538257efb6f612dc9715`                      | Apache-2.0 |
| `packages/core/src/live-preview/context.ts`              | `retronav/ixora@1734bce24307fd80c4ea538257efb6f612dc9715`                      | Apache-2.0 |
| `packages/core/src/live-preview/images/element.ts`       | `retronav/ixora@1734bce24307fd80c4ea538257efb6f612dc9715`                      | Apache-2.0 |
| `packages/core/src/live-preview/images/widget.ts`        | `retronav/ixora@1734bce24307fd80c4ea538257efb6f612dc9715`                      | Apache-2.0 |
| `packages/core/src/wikilinks/syntax.ts`                  | `silverbulletmd/silverbullet@70e58486e5e9d47dbfb13971e8576212896993c8`         | MIT        |
| `packages/core/src/tasks/syntax.ts`                      | `silverbulletmd/silverbullet@70e58486e5e9d47dbfb13971e8576212896993c8`         | MIT        |
| `packages/plugins-internal/src/latex-snippets/engine/`   | `artisticat1/obsidian-latex-suite@5db51cf36abccdbbfa51184bb5fe86be8157cc2f`    | MIT        |
| `packages/plugins-internal/src/latex-snippets/cm/`       | `artisticat1/obsidian-latex-suite@5db51cf36abccdbbfa51184bb5fe86be8157cc2f`    | MIT        |
| `packages/plugins-internal/src/latex-snippets/features/` | `artisticat1/obsidian-latex-suite@5db51cf36abccdbbfa51184bb5fe86be8157cc2f`    | MIT        |
| `packages/plugins-internal/src/outliner/model/`          | `vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0`           | MIT        |
| `packages/plugins-internal/src/outliner/operations/`     | `vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0`           | MIT        |
| `packages/plugins-internal/src/outliner/utils/`          | `vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0`           | MIT        |
| `packages/plugins-internal/src/outliner/features/`       | `vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0`           | MIT        |
| `packages/plugins-internal/test/outliner.*`              | `vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0`           | MIT        |
| `packages/core/src/tasks/line.ts`                        | `obsidian-tasks-group/obsidian-tasks@9173205606e49846f456caf438fdc0e5baded77e` | MIT        |

## Dependências npm novas de produção do r7

Versões e commits das dependências diretas acrescentadas no r7 (arch-frontend r7 §15.2); todas as
transitivas estão na tabela seguinte.

- `@replit/codemirror-vim` 6.4.0 (MIT) — https://github.com/replit/codemirror-vim, tag `v6.4.0` =
  `4ca4d66bfaa12b3a5d8283b8c38532dec7328a68`; traz `@replit/codemirror-vim-core` 0.1.0 (MIT).
- `markdownlint` 0.41.1 (MIT) — https://github.com/DavidAnson/markdownlint, tag `v0.41.1` =
  `e41e5a40ba934f079da0ffbdea0309869c034d47`; traz `micromark` 4 e os pacotes `micromark-*`,
  `string-width`, `get-east-asian-width`, `strip-ansi`, `ansi-regex`, `parse-entities`,
  `character-*`, `is-*`, `decode-named-character-reference`, `devlop`, `dequal` (todos MIT). O
  `micromark-extension-math` pede `katex` ^0.16; o `pnpm-workspace.yaml` força o `katex` 0.19.0 do
  app (override `micromark-extension-math>katex`, como o `mermaid>katex`: o 0.16.47 tem um aviso de
  segurança corrigido no 0.18.2), então não entra uma segunda cópia (o lint só usa a sintaxe).
- `@tgrosinger/md-advanced-tables` 3.11.0 (MIT) — https://github.com/tgrosinger/md-advanced-tables,
  tag `3.11.0` = `147ac635ee23a508c79955c2e7e098586589df82`; traz `meaw` 5.0.0, `lodash` 4.17.21,
  `decimal.js` 10.4.3 e `ebnf` 1.9.1 (MIT). O `lodash` sai no 4.18.1 (override
  `@tgrosinger/md-advanced-tables>lodash` no `pnpm-workspace.yaml`: o 4.17.21 fixado pelo upstream tem
  o aviso alto GHSA-r5fr-rjxr-66jc).
- `dompurify` 3.4.16 — https://github.com/cure53/DOMPurify, tag `3.4.16` =
  `b9b9d80f7e401771c2ccaef5f45def7eec8f27d7`. Licença dupla `(MPL-2.0 OR Apache-2.0)`: o simpleMD
  **elege a Apache-2.0** (texto integral abaixo). Já estava na árvore pelo Mermaid; uma única cópia.
- `@codemirror/lint` ^6.9.7, `@codemirror/search` ^6.7.2 e `@codemirror/commands` ^6.11.1 (MIT) —
  https://github.com/codemirror, mesmas cópias do núcleo (`scripts/check-single-codemirror.mjs`).

## Dependências npm de produção

Todas as dependências de produção dos pacotes do workspace, como `pnpm -r licenses list --prod`
as informa (versões exatas em `pnpm-lock.yaml`). Um pacote com versões de licenças diferentes tem
uma linha por licença. O texto da MIT e o da Apache-2.0 estão no fim; os avisos de copyright de cada
pacote acompanham o próprio pacote.

| Pacote                                              | Licença                 | Autor                            | Página                                                                                  |
| --------------------------------------------------- | ----------------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| `@antfu/install-pkg`                                | MIT                     | Anthony Fu                       | https://github.com/antfu-collective/install-pkg#readme                                  |
| `@braintree/sanitize-url`                           | MIT                     | —                                | https://github.com/braintree/sanitize-url#readme                                        |
| `@chevrotain/cst-dts-gen`                           | Apache-2.0              | —                                | https://github.com/Chevrotain/chevrotain#readme                                         |
| `@chevrotain/gast`                                  | Apache-2.0              | —                                | https://github.com/Chevrotain/chevrotain#readme                                         |
| `@chevrotain/regexp-to-ast`                         | Apache-2.0              | —                                | https://github.com/Chevrotain/chevrotain#readme                                         |
| `@chevrotain/types`                                 | Apache-2.0              | Shahar Soel                      | https://chevrotain.io/documentation/                                                    |
| `@chevrotain/utils`                                 | Apache-2.0              | Shahar Soel                      | https://github.com/Chevrotain/chevrotain#readme                                         |
| `@codemirror/autocomplete`                          | MIT                     | Marijn Haverbeke                 | —                                                                                       |
| `@codemirror/commands`                              | MIT                     | Marijn Haverbeke                 | —                                                                                       |
| `@codemirror/lang-css`                              | MIT                     | Marijn Haverbeke                 | https://github.com/codemirror/lang-css#readme                                           |
| `@codemirror/lang-html`                             | MIT                     | Marijn Haverbeke                 | —                                                                                       |
| `@codemirror/lang-javascript`                       | MIT                     | Marijn Haverbeke                 | https://github.com/codemirror/lang-javascript#readme                                    |
| `@codemirror/lang-markdown`                         | MIT                     | Marijn Haverbeke                 | —                                                                                       |
| `@codemirror/language`                              | MIT                     | Marijn Haverbeke                 | —                                                                                       |
| `@codemirror/lint`                                  | MIT                     | Marijn Haverbeke                 | —                                                                                       |
| `@codemirror/search`                                | MIT                     | Marijn Haverbeke                 | —                                                                                       |
| `@codemirror/state`                                 | MIT                     | Marijn Haverbeke                 | —                                                                                       |
| `@codemirror/view`                                  | MIT                     | Marijn Haverbeke                 | —                                                                                       |
| `@floating-ui/core`                                 | MIT                     | atomiks                          | https://floating-ui.com                                                                 |
| `@floating-ui/dom`                                  | MIT                     | atomiks                          | https://floating-ui.com                                                                 |
| `@floating-ui/react-dom`                            | MIT                     | atomiks                          | https://floating-ui.com/docs/react-dom                                                  |
| `@floating-ui/utils`                                | MIT                     | atomiks                          | https://floating-ui.com                                                                 |
| `@iconify/types`                                    | MIT                     | Vjacheslav Trushkin              | https://github.com/iconify/iconify                                                      |
| `@iconify/utils`                                    | MIT                     | Vjacheslav Trushkin              | https://iconify.design/docs/libraries/utils/                                            |
| `@lezer/common`                                     | MIT                     | Marijn Haverbeke                 | —                                                                                       |
| `@lezer/css`                                        | MIT                     | Marijn Haverbeke                 | —                                                                                       |
| `@lezer/highlight`                                  | MIT                     | Marijn Haverbeke                 | —                                                                                       |
| `@lezer/html`                                       | MIT                     | Marijn Haverbeke                 | https://github.com/lezer-parser/html#readme                                             |
| `@lezer/javascript`                                 | MIT                     | Marijn Haverbeke                 | —                                                                                       |
| `@lezer/lr`                                         | MIT                     | Marijn Haverbeke                 | —                                                                                       |
| `@lezer/markdown`                                   | MIT                     | Marijn Haverbeke                 | —                                                                                       |
| `@marijn/find-cluster-break`                        | MIT                     | Marijn Haverbeke                 | https://code.haverbeke.berlin/marijn/find-cluster-break                                 |
| `@mermaid-js/parser`                                | MIT                     | Yokozuna59                       | https://github.com/mermaid-js/mermaid/tree/develop/packages/mermaid/parser/#readme      |
| `@noble/hashes`                                     | MIT                     | Paul Miller                      | https://paulmillr.com/noble/                                                            |
| `@radix-ui/primitive`                               | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-alert-dialog`                      | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-arrow`                             | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-collection`                        | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-compose-refs`                      | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-context`                           | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-dialog`                            | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-direction`                         | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-dismissable-layer`                 | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-dropdown-menu`                     | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-focus-guards`                      | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-focus-scope`                       | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-id`                                | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-menu`                              | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-popper`                            | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-portal`                            | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-presence`                          | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-primitive`                         | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-roving-focus`                      | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-slot`                              | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-use-callback-ref`                  | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-use-controllable-state`            | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-use-effect-event`                  | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-use-is-hydrated`                   | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-use-layout-effect`                 | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-use-rect`                          | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/react-use-size`                          | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@radix-ui/rect`                                    | MIT                     | —                                | https://radix-ui.com/primitives                                                         |
| `@replit/codemirror-vim`                            | MIT                     | —                                | https://github.com/replit/codemirror-vim#readme                                         |
| `@replit/codemirror-vim-core`                       | MIT                     | Yunchi Luo                       | https://github.com/replit/codemirror-vim#readme                                         |
| `@tanstack/react-virtual`                           | MIT                     | Tanner Linsley                   | https://tanstack.com/virtual                                                            |
| `@tanstack/virtual-core`                            | MIT                     | Tanner Linsley                   | https://tanstack.com/virtual                                                            |
| `@tauri-apps/api`                                   | Apache-2.0 OR MIT       | —                                | https://github.com/tauri-apps/tauri#readme                                              |
| `@tgrosinger/md-advanced-tables`                    | MIT                     | Tony Grosinger                   | https://github.com/tgrosinger/md-advanced-tables#readme                                 |
| `@types/d3`                                         | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3                 |
| `@types/d3-array`                                   | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-array           |
| `@types/d3-axis`                                    | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-axis            |
| `@types/d3-brush`                                   | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-brush           |
| `@types/d3-chord`                                   | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-chord           |
| `@types/d3-color`                                   | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-color           |
| `@types/d3-contour`                                 | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-contour         |
| `@types/d3-delaunay`                                | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-delaunay        |
| `@types/d3-dispatch`                                | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-dispatch        |
| `@types/d3-drag`                                    | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-drag            |
| `@types/d3-dsv`                                     | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-dsv             |
| `@types/d3-ease`                                    | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-ease            |
| `@types/d3-fetch`                                   | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-fetch           |
| `@types/d3-force`                                   | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-force           |
| `@types/d3-format`                                  | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-format          |
| `@types/d3-geo`                                     | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-geo             |
| `@types/d3-hierarchy`                               | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-hierarchy       |
| `@types/d3-interpolate`                             | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-interpolate     |
| `@types/d3-path`                                    | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-path            |
| `@types/d3-polygon`                                 | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-polygon         |
| `@types/d3-quadtree`                                | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-quadtree        |
| `@types/d3-random`                                  | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-random          |
| `@types/d3-scale`                                   | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-scale           |
| `@types/d3-scale-chromatic`                         | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-scale-chromatic |
| `@types/d3-selection`                               | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-selection       |
| `@types/d3-shape`                                   | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-shape           |
| `@types/d3-time`                                    | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-time            |
| `@types/d3-time-format`                             | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-time-format     |
| `@types/d3-timer`                                   | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-timer           |
| `@types/d3-transition`                              | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-transition      |
| `@types/d3-zoom`                                    | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3-zoom            |
| `@types/debug`                                      | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/debug              |
| `@types/geojson`                                    | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/geojson            |
| `@types/katex`                                      | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/katex              |
| `@types/ms`                                         | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/ms                 |
| `@types/unist`                                      | MIT                     | —                                | https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/unist              |
| `@upsetjs/venn.js`                                  | MIT                     | Ben Frederickson                 | https://github.com/upsetjs/venn.js                                                      |
| `ansi-regex`                                        | MIT                     | Sindre Sorhus                    | https://github.com/chalk/ansi-regex#readme                                              |
| `aria-hidden`                                       | MIT                     | Anton Korzunov                   | https://github.com/theKashey/aria-hidden#readme                                         |
| `character-entities`                                | MIT                     | Titus Wormer                     | https://github.com/wooorm/character-entities#readme                                     |
| `character-entities-legacy`                         | MIT                     | Titus Wormer                     | https://github.com/wooorm/character-entities-legacy#readme                              |
| `character-reference-invalid`                       | MIT                     | Titus Wormer                     | https://github.com/wooorm/character-reference-invalid#readme                            |
| `chevrotain`                                        | Apache-2.0              | Shahar Soel                      | https://chevrotain.io/docs/                                                             |
| `commander`                                         | MIT                     | TJ Holowaychuk                   | https://github.com/tj/commander.js#readme                                               |
| `cose-base`                                         | MIT                     | —                                | https://github.com/iVis-at-Bilkent/cose-base#readme                                     |
| `crelt`                                             | MIT                     | Marijn Haverbeke                 | https://code.haverbeke.berlin/marijn/crelt                                              |
| `cytoscape`                                         | MIT                     | —                                | http://js.cytoscape.org                                                                 |
| `cytoscape-cose-bilkent`                            | MIT                     | —                                | https://github.com/cytoscape/cytoscape.js-cose-bilkent                                  |
| `cytoscape-fcose`                                   | MIT                     | iVis-at-Bilkent                  | https://github.com/iVis-at-Bilkent/cytoscape.js-fcose                                   |
| `d3`                                                | ISC                     | Mike Bostock                     | https://d3js.org                                                                        |
| `d3-array`                                          | BSD-3-Clause            | Mike Bostock                     | https://d3js.org/d3-array/                                                              |
| `d3-array`                                          | ISC                     | Mike Bostock                     | https://d3js.org/d3-array/                                                              |
| `d3-axis`                                           | ISC                     | Mike Bostock                     | https://d3js.org/d3-axis/                                                               |
| `d3-brush`                                          | ISC                     | Mike Bostock                     | https://d3js.org/d3-brush/                                                              |
| `d3-chord`                                          | ISC                     | Mike Bostock                     | https://d3js.org/d3-chord/                                                              |
| `d3-color`                                          | ISC                     | Mike Bostock                     | https://d3js.org/d3-color/                                                              |
| `d3-contour`                                        | ISC                     | Mike Bostock                     | https://d3js.org/d3-contour/                                                            |
| `d3-delaunay`                                       | ISC                     | Mike Bostock                     | https://github.com/d3/d3-delaunay                                                       |
| `d3-dispatch`                                       | ISC                     | Mike Bostock                     | https://d3js.org/d3-dispatch/                                                           |
| `d3-drag`                                           | ISC                     | Mike Bostock                     | https://d3js.org/d3-drag/                                                               |
| `d3-dsv`                                            | ISC                     | Mike Bostock                     | https://d3js.org/d3-dsv/                                                                |
| `d3-ease`                                           | BSD-3-Clause            | Mike Bostock                     | https://d3js.org/d3-ease/                                                               |
| `d3-fetch`                                          | ISC                     | Mike Bostock                     | https://d3js.org/d3-fetch/                                                              |
| `d3-force`                                          | ISC                     | Mike Bostock                     | https://d3js.org/d3-force/                                                              |
| `d3-format`                                         | ISC                     | Mike Bostock                     | https://d3js.org/d3-format/                                                             |
| `d3-geo`                                            | ISC                     | Mike Bostock                     | https://d3js.org/d3-geo/                                                                |
| `d3-hierarchy`                                      | ISC                     | Mike Bostock                     | https://d3js.org/d3-hierarchy/                                                          |
| `d3-interpolate`                                    | ISC                     | Mike Bostock                     | https://d3js.org/d3-interpolate/                                                        |
| `d3-path`                                           | BSD-3-Clause            | Mike Bostock                     | https://d3js.org/d3-path/                                                               |
| `d3-path`                                           | ISC                     | Mike Bostock                     | https://d3js.org/d3-path/                                                               |
| `d3-polygon`                                        | ISC                     | Mike Bostock                     | https://d3js.org/d3-polygon/                                                            |
| `d3-quadtree`                                       | ISC                     | Mike Bostock                     | https://d3js.org/d3-quadtree/                                                           |
| `d3-random`                                         | ISC                     | Mike Bostock                     | https://d3js.org/d3-random/                                                             |
| `d3-sankey`                                         | BSD-3-Clause            | Mike Bostock                     | https://github.com/d3/d3-sankey                                                         |
| `d3-scale`                                          | ISC                     | Mike Bostock                     | https://d3js.org/d3-scale/                                                              |
| `d3-scale-chromatic`                                | ISC                     | Mike Bostock                     | https://d3js.org/d3-scale-chromatic/                                                    |
| `d3-selection`                                      | ISC                     | Mike Bostock                     | https://d3js.org/d3-selection/                                                          |
| `d3-shape`                                          | BSD-3-Clause            | Mike Bostock                     | https://d3js.org/d3-shape/                                                              |
| `d3-shape`                                          | ISC                     | Mike Bostock                     | https://d3js.org/d3-shape/                                                              |
| `d3-time`                                           | ISC                     | Mike Bostock                     | https://d3js.org/d3-time/                                                               |
| `d3-time-format`                                    | ISC                     | Mike Bostock                     | https://d3js.org/d3-time-format/                                                        |
| `d3-timer`                                          | ISC                     | Mike Bostock                     | https://d3js.org/d3-timer/                                                              |
| `d3-transition`                                     | ISC                     | Mike Bostock                     | https://d3js.org/d3-transition/                                                         |
| `d3-zoom`                                           | ISC                     | Mike Bostock                     | https://d3js.org/d3-zoom/                                                               |
| `dagre-d3-es`                                       | MIT                     | —                                | https://github.com/tbo47/dagre-es#readme                                                |
| `dayjs`                                             | MIT                     | iamkun                           | https://day.js.org                                                                      |
| `debug`                                             | MIT                     | Josh Junon                       | https://github.com/debug-js/debug#readme                                                |
| `decimal.js`                                        | MIT                     | Michael Mclaughlin               | https://github.com/MikeMcl/decimal.js#readme                                            |
| `decode-named-character-reference`                  | MIT                     | Titus Wormer                     | https://github.com/wooorm/decode-named-character-reference#readme                       |
| `delaunator`                                        | ISC                     | Vladimir Agafonkin               | https://github.com/mapbox/delaunator#readme                                             |
| `dequal`                                            | MIT                     | Luke Edwards                     | https://github.com/lukeed/dequal#readme                                                 |
| `detect-node-es`                                    | MIT                     | Ilya Kantor                      | https://github.com/thekashey/detect-node                                                |
| `devlop`                                            | MIT                     | Titus Wormer                     | https://github.com/wooorm/devlop#readme                                                 |
| `dompurify`                                         | (MPL-2.0 OR Apache-2.0) | Dr.-Ing. Mario Heiderich, Cure53 | https://github.com/cure53/DOMPurify                                                     |
| `ebnf`                                              | MIT                     | Agustin Mendez @menduz           | https://github.com/menduz/node-ebnf#readme                                              |
| `elkjs`                                             | EPL-2.0                 | Ulf Rüegg                        | https://github.com/kieler/elkjs#readme                                                  |
| `es-module-lexer`                                   | MIT                     | Guy Bedford                      | https://github.com/guybedford/es-module-lexer#readme                                    |
| `es-toolkit`                                        | MIT                     | —                                | https://es-toolkit.dev                                                                  |
| `get-east-asian-width`                              | MIT                     | Sindre Sorhus                    | https://github.com/sindresorhus/get-east-asian-width#readme                             |
| `get-nonce`                                         | MIT                     | Anton Korzunov                   | https://github.com/theKashey/get-nonce                                                  |
| `hachure-fill`                                      | MIT                     | Preet Shihn                      | https://github.com/pshihn/hachure-fill#readme                                           |
| `iconv-lite`                                        | MIT                     | Alexander Shtuchkin              | https://github.com/ashtuchkin/iconv-lite                                                |
| `import-meta-resolve`                               | MIT                     | Titus Wormer                     | https://github.com/wooorm/import-meta-resolve#readme                                    |
| `internmap`                                         | ISC                     | Mike Bostock                     | https://github.com/mbostock/internmap/                                                  |
| `is-alphabetical`                                   | MIT                     | Titus Wormer                     | https://github.com/wooorm/is-alphabetical#readme                                        |
| `is-alphanumerical`                                 | MIT                     | Titus Wormer                     | https://github.com/wooorm/is-alphanumerical#readme                                      |
| `is-decimal`                                        | MIT                     | Titus Wormer                     | https://github.com/wooorm/is-decimal#readme                                             |
| `is-hexadecimal`                                    | MIT                     | Titus Wormer                     | https://github.com/wooorm/is-hexadecimal#readme                                         |
| `katex`                                             | MIT                     | —                                | https://katex.org                                                                       |
| `khroma`                                            | MIT                     | —                                | https://github.com/fabiospampinato/khroma#readme                                        |
| `layout-base`                                       | MIT                     | —                                | https://github.com/iVis-at-Bilkent/layout-base#readme                                   |
| `lodash`                                            | MIT                     | John-David Dalton                | https://lodash.com/                                                                     |
| `lodash-es`                                         | MIT                     | John-David Dalton                | https://lodash.com/custom-builds                                                        |
| `markdownlint`                                      | MIT                     | David Anson                      | https://github.com/DavidAnson/markdownlint                                              |
| `marked`                                            | MIT                     | Christopher Jeffrey              | https://marked.js.org                                                                   |
| `meaw`                                              | MIT                     | Susisu                           | https://github.com/susisu/meaw#readme                                                   |
| `mermaid`                                           | MIT                     | Knut Sveidqvist                  | https://github.com/mermaid-js/mermaid#readme                                            |
| `micromark`                                         | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark/tree/main#readme                                 |
| `micromark-core-commonmark`                         | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark/tree/main#readme                                 |
| `micromark-extension-directive`                     | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark-extension-directive#readme                       |
| `micromark-extension-gfm-autolink-literal`          | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark-extension-gfm-autolink-literal#readme            |
| `micromark-extension-gfm-footnote`                  | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark-extension-gfm-footnote#readme                    |
| `micromark-extension-gfm-table`                     | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark-extension-gfm-table#readme                       |
| `micromark-extension-math`                          | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark-extension-math#readme                            |
| `micromark-factory-destination`                     | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark/tree/main#readme                                 |
| `micromark-factory-label`                           | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark/tree/main#readme                                 |
| `micromark-factory-space`                           | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark/tree/main#readme                                 |
| `micromark-factory-title`                           | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark/tree/main#readme                                 |
| `micromark-factory-whitespace`                      | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark/tree/main#readme                                 |
| `micromark-util-character`                          | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark/tree/main#readme                                 |
| `micromark-util-chunked`                            | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark/tree/main#readme                                 |
| `micromark-util-classify-character`                 | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark/tree/main#readme                                 |
| `micromark-util-combine-extensions`                 | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark/tree/main#readme                                 |
| `micromark-util-decode-numeric-character-reference` | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark/tree/main#readme                                 |
| `micromark-util-encode`                             | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark/tree/main#readme                                 |
| `micromark-util-html-tag-name`                      | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark/tree/main#readme                                 |
| `micromark-util-normalize-identifier`               | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark/tree/main#readme                                 |
| `micromark-util-resolve-all`                        | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark/tree/main#readme                                 |
| `micromark-util-sanitize-uri`                       | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark/tree/main#readme                                 |
| `micromark-util-subtokenize`                        | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark/tree/main#readme                                 |
| `micromark-util-symbol`                             | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark/tree/main#readme                                 |
| `micromark-util-types`                              | MIT                     | Titus Wormer                     | https://github.com/micromark/micromark/tree/main#readme                                 |
| `ms`                                                | MIT                     | —                                | https://github.com/vercel/ms#readme                                                     |
| `package-manager-detector`                          | MIT                     | Anthony Fu                       | https://github.com/antfu-collective/package-manager-detector#readme                     |
| `parse-entities`                                    | MIT                     | Titus Wormer                     | https://github.com/wooorm/parse-entities#readme                                         |
| `path-data-parser`                                  | MIT                     | Preet Shihn                      | https://github.com/pshihn/path-data-parser#readme                                       |
| `points-on-curve`                                   | MIT                     | Preet Shihn                      | https://github.com/pshihn/bezier-points#readme                                          |
| `points-on-path`                                    | MIT                     | Preet Shihn                      | https://github.com/pshihn/points-on-path#readme                                         |
| `react`                                             | MIT                     | —                                | https://react.dev/                                                                      |
| `react-dom`                                         | MIT                     | —                                | https://react.dev/                                                                      |
| `react-remove-scroll`                               | MIT                     | Anton Korzunov                   | https://github.com/theKashey/react-remove-scroll#readme                                 |
| `react-remove-scroll-bar`                           | MIT                     | Anton Korzunov                   | https://github.com/theKashey/react-remove-scroll-bar#readme                             |
| `react-style-singleton`                             | MIT                     | Anton Korzunov                   | https://github.com/theKashey/react-style-singleton#readme                               |
| `robust-predicates`                                 | Unlicense               | Vladimir Agafonkin               | https://github.com/mourner/robust-predicates#readme                                     |
| `roughjs`                                           | MIT                     | Preet Shihn                      | https://roughjs.com                                                                     |
| `rw`                                                | BSD-3-Clause            | Mike Bostock                     | https://github.com/mbostock/rw                                                          |
| `safer-buffer`                                      | MIT                     | Nikita Skovoroda                 | https://github.com/ChALkeR/safer-buffer#readme                                          |
| `scheduler`                                         | MIT                     | —                                | https://react.dev/                                                                      |
| `string-width`                                      | MIT                     | Sindre Sorhus                    | https://github.com/sindresorhus/string-width#readme                                     |
| `strip-ansi`                                        | MIT                     | Sindre Sorhus                    | https://github.com/chalk/strip-ansi#readme                                              |
| `style-mod`                                         | MIT                     | Marijn Haverbeke                 | https://code.haverbeke.berlin/marijn/style-mod                                          |
| `stylis`                                            | MIT                     | Sultan Tarimo                    | https://github.com/thysultan/stylis.js                                                  |
| `tailwindcss`                                       | MIT                     | —                                | https://tailwindcss.com                                                                 |
| `tinyexec`                                          | MIT                     | James Garbutt                    | https://github.com/tinylibs/tinyexec#readme                                             |
| `ts-dedent`                                         | MIT                     | Tamino Martinius                 | https://github.com/tamino-martinius/node-ts-dedent#readme                               |
| `tslib`                                             | 0BSD                    | Microsoft Corp.                  | https://www.typescriptlang.org/                                                         |
| `use-callback-ref`                                  | MIT                     | theKashey                        | —                                                                                       |
| `use-sidecar`                                       | MIT                     | theKashey                        | https://github.com/theKashey/use-sidecar                                                |
| `uuid`                                              | MIT                     | —                                | https://github.com/uuidjs/uuid#readme                                                   |
| `w3c-keyname`                                       | MIT                     | Marijn Haverbeke                 | https://github.com/marijnh/w3c-keyname#readme                                           |
| `yaml`                                              | ISC                     | Eemeli Aro                       | https://eemeli.org/yaml/                                                                |
| `zustand`                                           | MIT                     | Paul Henschel                    | https://github.com/pmndrs/zustand                                                       |

## Textos das licenças

### MIT — SilverBullet

```text
Copyright 2022, Zef Hemel

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### MIT — obsidian-latex-suite

```text
MIT License

Copyright (c) 2022 artisticat1

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### MIT — obsidian-outliner

```text
Copyright (c) 2021 Viacheslav Slinko

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### MIT — obsidian-tasks

```text
MIT License

Copyright (c) 2021 Clare Macrae, Ilyas Landikov and Martin Schenck

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### MIT — obsidian-dataview

```text
MIT License

Copyright (c) 2021 Michael Brenan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Apache License 2.0 (ixora; DOMPurify pela eleição Apache-2.0; demais pacotes Apache-2.0)

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
