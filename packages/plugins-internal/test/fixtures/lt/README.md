# Respostas gravadas do LanguageTool (r7 S8)

Respostas reais de um servidor LanguageTool local, usadas pelos testes do plugin
"Ortografia e gramática (LanguageTool)" (`languagetool.test.ts`, `languagetool.units.test.ts` e
`apps/desktop/test/languagetool-plugin.test.tsx`).

| Item               | Valor                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Servidor           | LanguageTool **6.8** (build `e807fcd`, `buildDate` 2026-09-11 17:31:55 +0000), Homebrew, macOS arm64                                     |
| Comando            | `/opt/homebrew/opt/languagetool/bin/languagetool-server --config /opt/homebrew/etc/languagetool/server.properties --port 8081`             |
| Gravação           | 2026-10-10 (commit `d3aa7c3`); regravadas em 2026-10-10 na correção pós-revisão de S8, com resultado byte a byte igual                    |
| Como gravar        | servidor no ar em `localhost:8081` e `SIMPLEMD_LT_RECORD=1 pnpm vitest run packages/plugins-internal/test/languagetool.record.test.ts`      |

O pedido de cada gravação é montado pelo mesmo código do plugin (`planRequests` + `requestLanguage`),
então os deslocamentos das respostas valem para a nota de origem.

| Arquivo                    | Origem                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `languages.json`           | `GET /v2/languages`                                                                       |
| `pt-BR-check.{md,json}`    | `POST /v2/check`, idioma `pt-BR` (inclui `em [o`, trecho que cobre markup de link)        |
| `en-US-check.{md,json}`    | `POST /v2/check`, `lang: en-US` do front matter                                           |
| `pt-BR-auto.{md,json}`     | `POST /v2/check`, `language=auto` + `preferredVariants=pt-BR,en-US`                       |
| `err-offset.json`          | derivado de `pt-BR-check.json` (1º `offset` = 100.000), para o validador                  |
| `err-missing-matches.json` | derivado de `pt-BR-check.json` (sem `matches`), para o validador                          |

O texto das notas é sintético: nenhuma nota real foi enviada ou gravada.
