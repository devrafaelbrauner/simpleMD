# Roteiro de QA: notas só na nuvem (OneDrive e Proton Drive)

Confere na máquina real o que os testes automáticos só simulam (run r36b, AC-R36-2): uma nota cujo conteúdo não está no disco entra no catálogo **só pelo nome, sem ser baixada**; ela é lida quando fica no disco ou com `index.cloudOnly` ligado; abrir a nota no editor continua baixando-a. A sincronização é do cliente do sistema (D-P26-01); o simpleMD não fala com a nuvem.

- **Quando:** na run de QA real (r40), em Windows e macOS. O resultado vai para o item MC-R36B-1 de `manual-checks.md` do programa.
- **Como o app detecta** (`apps/desktop/src-tauri/src/vault/ops.rs`, `is_cloud_only`): no Windows, o atributo `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` (`0x400000`) ou `FILE_ATTRIBUTE_OFFLINE` (`0x1000`); no macOS, a marca `SF_DATALESS` (`0x40000000`, a que o `ls -lO` mostra como `dataless`). Só os metadados da listagem são lidos: nenhuma abertura de arquivo.
- **O que os testes já provam:** os bits (Rust, nos 3 SO), `attrib +o` no Windows (CI) e o índice sobre a porta em memória (`packages/vault/test/catalog-cloud.test.ts`). O que falta é o comportamento do cliente de nuvem de verdade.

## 1. Regras

- Só contas de teste dos serviços (OneDrive, Proton Drive), nunca a conta pessoal do usuário. O agente nunca digita senha: o usuário entra na conta.
- Só uma pasta de teste dentro da pasta sincronizada (por exemplo `smd-nuvem-teste`), só com as notas criadas aqui.
- Evidência fora do repositório, na pasta do run (`.nexus/runs/<run>/qa/nuvem-<SO>-<AAAA-MM-DD>/`), com `report.md` (uma linha por passo: esperado, observado literal, PASS / FAIL / NOT TESTED) e `SHA256SUMS`. Sem o cliente ou sem "arquivos sob demanda" = NOT TESTED, nunca PASS.
- Registre: SO e versão, cliente e versão (OneDrive, Proton Drive), revisão do app (`git rev-parse HEAD` do binário) e a pasta usada.

## 2. Preparação

1. Na pasta de teste, crie pelo terminal (não pelo app) `receitas/bolo.md`, `receitas/pudim.md` e `ideias.md`, cada uma com front matter conhecido, por exemplo:

   ```markdown
   ---
   title: Bolo de fubá
   tags: [receita, doce]
   ---

   # Corpo
   ```

   Registre o sha256 de cada uma. Sem `.simplemd/` na pasta (o índice nasce do zero).

2. Espere sincronizar e libere o espaço das três notas:
   - **Windows (OneDrive; Proton Drive com arquivos sob demanda):** Explorer → botão direito → "Liberar espaço", ou `attrib +U -P <nota>` (como no `windows-protocol.md` §5.5). Registre `attrib <nota>` (com `U`) e os atributos em hexa: `'{0:X}' -f [int](Get-Item <nota> -Force).Attributes`. O app marca a nota quando aparece o bit `400000` ou o `1000`; registre qual dos dois.
   - **macOS (OneDrive e Proton Drive em `~/Library/CloudStorage/…`):** Finder → botão direito → "Remover download". Registre `ls -lO <nota>`: a coluna de marcas mostra `dataless`.

   Se nenhuma marca aparecer, o cliente não deixou a nota só na nuvem: o passo seguinte é NOT TESTED para esse cliente.

## 3. Passos

1. **Abrir a pasta não baixa nada.** Com o app fechado, sem `index` no `.simplemd/config.json` (padrão: desligado), abra a pasta. Esperado:
   - o explorador lista as três notas, como qualquer outra (sem ícone de nuvem, D-R36-9);
   - o catálogo mostra cada uma pelo nome do arquivo ("bolo", "pudim", "ideias"), sem tags;
   - depois de o catálogo ficar pronto, `attrib` ainda mostra `U` (Windows) e `ls -lO` ainda mostra `dataless` (macOS) nas três;
   - feche o app (o índice é gravado ao fechar) e confira em `.simplemd/index.json` `"cloud": true` nas três entradas e nenhum trecho do corpo delas.
2. **Reabrir continua sem baixar.** Abra a pasta de novo: mesmas marcas do passo 1 depois de o catálogo ficar pronto.
3. **Abrir a nota baixa normalmente.** Abra `receitas/bolo.md` no editor. Esperado: o texto aparece (nunca vazio nem com bytes zerados), sem `INVALID_PATH`, `OUTSIDE_VAULT` nem recusa como link; o sha256 do arquivo no disco é o do passo 2.1; a marca some (`attrib` sem `U`, `ls -lO` sem `dataless`). Registre se o catálogo passou a mostrar "Bolo de fubá" e as tags sozinho (evento do observador) ou só depois de reabrir a pasta; com o observador ativo, focar a janela não relista.
4. **Ficar no disco fora do app relê.** Com o app aberto, baixe `receitas/pudim.md` pelo cliente (Explorer: "Sempre manter neste dispositivo"; Finder: "Baixar agora"). Esperado: o catálogo passa a mostrar o título e as tags do front matter (registre se veio pelo evento do observador ou só ao reabrir a pasta; focar a janela não relista com o observador ativo).
5. **Liberar uma nota já indexada mantém os dados.** Libere de novo `receitas/bolo.md` (passo 2.2), com o app aberto e a aba da nota fechada (no r3, com a aba aberta, o OneDrive não liberou). Esperado: o catálogo continua com "Bolo de fubá" e as tags, e a nota continua só na nuvem (o app não a baixa de volta).
6. **Preferência ligada baixa e indexa.** Feche o app, ponha `"index": { "cloudOnly": true }` no `.simplemd/config.json` (depois da r36c, também por Configurações → "Pasta") e abra a pasta. Esperado: `ideias.md` é baixada (a marca some) e aparece com o título e as tags; em `.simplemd/index.json` nenhuma entrada fica com `"cloud"`.
7. **Pasta grande na nuvem.** Gere 2.000 notas na pasta de teste (`node scripts/gen-vault.mjs <pasta>`), espere sincronizar, libere todas e abra a pasta com a preferência desligada. Esperado: a interface não congela; o catálogo fica pronto (registre o tempo até o "Indexando…" sumir); nenhuma nota é baixada (amostre 10 com `attrib`/`ls -lO`).

## 4. Achados possíveis (registrar, não corrigir na sessão)

- **Windows, placeholder "disfarçado":** se as notas liberadas forem baixadas ao abrir a pasta (passo 1), registre os atributos vistos (hexa) antes e depois: o processo pode estar vendo os placeholders como arquivos comuns (`RtlSetProcessPlaceholderCompatibilityMode`), e nesse caso o app lê como antes da r36b (risco aceito no desenho).
- **Windows, abertura sem seguir ponto de reanálise:** o gateway abre as notas com `FILE_FLAG_OPEN_REPARSE_POINT` (desde a r2, para não seguir links). Se o passo 3 mostrar texto vazio, bytes zerados ou erro de E/S numa nota só online, é achado BLOCKING para a próxima run do vault.
- **macOS:** listar uma pasta que está só na nuvem pode baixar a lista de itens dela (é o esperado); baixar o conteúdo de notas não é.

## 5. Limpeza

1. Feche o app.
2. Apague a pasta de teste também na nuvem (pelo site do serviço ou esperando a sincronização da exclusão) e registre.
3. O usuário sai da conta de teste, se ela foi aberta só para a sessão.
