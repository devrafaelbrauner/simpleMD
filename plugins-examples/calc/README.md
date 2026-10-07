# Cálculo (exemplo de plugin do simpleMD)

É o mesmo código do plugin interno “Cálculo” (`packages/plugins-internal/src/calc`), empacotado
como um plugin externo comum: `manifest.json` + `main.js`, que importa só os módulos do host
(`@codemirror/state`, `@codemirror/view`, `@codemirror/language`). Serve de prova de que a API v1
basta para um plugin de renderização.

Para testar, desligue “Cálculo” em Configurações → Plugins → Plugins internos (senão os dois
desenham o mesmo resultado), copie `manifest.json` e `main.js` para
`<sua pasta>/.simplemd/plugins/com.exemplo.calc/`, clique em “Recarregar lista” e ligue
“Cálculo (exemplo)”. Leia o aviso: um plugin roda com o mesmo acesso que o simpleMD (não é sandbox).

- `=2+3` vira `5`; `=1/0` mostra “divisão por zero”. Com o cursor no token, aparece o texto cru.
- O separador decimal é só o ponto (`=0.1+0.2` → `0.3`).
- O token termina no próximo espaço ou no fim da linha: `=2+3.` (com ponto final) não é calculado.

`main.js` é gerado — não edite à mão. Para refazer: `node scripts/build-plugin-example.mjs`
(o CI confere que o arquivo commitado é igual ao gerado). Referência completa: `docs/plugins.md`.
