# simpleMD

Editor de markdown open source (MIT), extensível por plugins e temas, em que o **markdown fica visível** (modelo Obsidian / VSCodium), com renderização inline. Os arquivos são `.md` puros em uma pasta do usuário ("vault").

O plano completo está em [`PLANO.md`](PLANO.md). O andamento por etapa está em [`TAREFAS_PENDENTES.md`](TAREFAS_PENDENTES.md), as mudanças em [`CHANGELOG.md`](CHANGELOG.md) e as ideias para depois em [`MELHORIAS.md`](MELHORIAS.md).

## Instalar (pré-lançamento sem assinatura)

A única fonte oficial dos instaladores é a página de releases: <https://github.com/devrafaelbrauner/simpleMD/releases>. Não baixe o simpleMD de outro lugar. A versão 0.1.0 é um **pré-lançamento sem assinatura de código**: nem a Apple nem a Microsoft conferiram quem publicou os arquivos, então o macOS e o Windows avisam que não conseguem verificar o desenvolvedor. Uma versão assinada virá depois, com outro número de versão.

- **Plataformas:** macOS em Apple Silicon (M1 ou mais novo; Macs Intel não são suportados nesta versão), arquivo `simpleMD_<versão>_aarch64.dmg`; Windows x64, arquivo `simpleMD_<versão>_x64-setup.exe` (instala em `%LOCALAPPDATA%\simpleMD`, só para o seu usuário, sem administrador). Testado no macOS 27.2 (Apple Silicon) e no Windows 10 IoT Enterprise LTSC 21H2 (x64); Windows 11 não foi testado. Não há atualização automática.
- **Antes de abrir, confira o arquivo.** Baixe também o `SHA256SUMS` do release para a mesma pasta. No macOS, `shasum -a 256 -c --ignore-missing SHA256SUMS` (na pasta dos arquivos) tem de imprimir `<arquivo>: OK`; no Windows (PowerShell, na pasta dos arquivos), `(Get-FileHash .\<arquivo> -Algorithm SHA256).Hash -eq ((Select-String -SimpleMatch '<arquivo>' .\SHA256SUMS).Line -split '\s+')[0]` tem de imprimir `True`. Qualquer outra saída quer dizer que o arquivo não confere. Com o GitHub CLI autenticado (`gh auth login`) dá para conferir também a atestação de proveniência (que o arquivo saiu do workflow de release deste repositório, na tag do release), com o `.dmg` ou o `-setup.exe` no lugar de `<arquivo>` (o `SHA256SUMS` não tem atestação própria): `gh attestation verify <arquivo> --repo devrafaelbrauner/simpleMD --signer-workflow devrafaelbrauner/simpleMD/.github/workflows/release.yml --source-ref refs/tags/<tag> --deny-self-hosted-runners`, que num terminal tem de mostrar `✓ Verification succeeded!`. A soma e a atestação provam de onde o arquivo veio, não que o código está livre de defeitos.
- **Se a soma não bater, se a atestação falhar ou se o sistema disser que o app está "danificado": não abra, apague o arquivo e avise de forma privada (veja [`SECURITY.md`](SECURITY.md)).** Não tente contornar.
- **Só depois de conferir, e só para esse arquivo:** as notas do release descrevem a primeira abertura. No macOS, o aviso "O Item simpleMD Não Foi Aberto" tem o botão destacado "Mover para o Lixo": clique em "OK" e depois, em Ajustes do Sistema → "Privacidade e Segurança", seção "Segurança" ("O app simpleMD foi bloqueado para proteger o Mac."), em "Abrir Mesmo Assim". Se aparecer um segundo aviso, "Abrir o Item simpleMD?", clique em "Abrir Mesmo Assim" (não no botão destacado "Mover para o Lixo"). Clique em "Abrir Mesmo Assim" uma vez só em cada aviso e confirme com a senha ou o Touch ID sem trocar de janela. Se o pedido de senha/Touch ID não aparecer e o simpleMD não abrir: force o encerramento do simpleMD (⌥⌘Esc, escolha o simpleMD e clique em "Forçar Encerrar") e reinicie o Mac, o que deve resolver; depois repita "Abrir Mesmo Assim" uma vez só em cada aviso. No primeiro ⌘P, o macOS pergunta "Permitir que “simpleMD” busque dispositivos em redes locais?": o simpleMD só precisa disso para imprimir numa impressora de rede; se você não usa uma, clique em "Não Permitir". No Windows, o SmartScreen ("O Windows protegeu o computador") mostra, depois de "Mais informações", "Fornecedor: Fornecedor desconhecido" e o botão "Executar assim mesmo". O aviso do sistema existe para proteger você de apps de origem desconhecida: não desligue nenhuma proteção do sistema; o simpleMD não precisa disso. Se o Controle Inteligente de Aplicativos do Windows bloquear o instalador, aguarde a versão assinada.
- **Chaves de IA:** no macOS, cada nova versão sem assinatura pede uma vez acesso às chaves já salvas no Keychain; permita só logo depois de instalar uma versão que você conferiu e acabou de usar a IA, e negue em qualquer outro momento. No Windows, as chaves ficam no Gerenciador de Credenciais da sua conta, legíveis por qualquer programa que você execute. Desinstalar não apaga as chaves: use "Remover chave" em Configurações → IA antes.

## Regras de arquitetura

1. **Markdown no disco é a fonte da verdade.** Nenhum motor, cache ou índice pode alterar um `.md` sem ação do usuário.
2. **`packages/core` não conhece Tauri nem React.** Só JavaScript/TypeScript puro + CodeMirror/Milkdown.
3. **A API de plugins não expõe React nem Tauri.** `registerPanel` recebe um `HTMLElement`; acesso a arquivos passa por `api.vault`.
4. **Feature nova nasce no modo fonte.** O modo WYSIWYG recebe depois, ou nunca, se não fizer sentido.
5. **`<CodeMirrorEditor>` cria o `EditorView` uma única vez.** Comunicação por `dispatch`, não por props.
6. **Nunca sobrescrever silenciosamente** um arquivo cujo `mtime` mudou fora do app: detectar e oferecer "manter ambos".
7. **Chaves e tokens só no keychain do SO.** Nunca em arquivo de configuração.

As fronteiras entre pacotes (regras 2 e 3) são verificadas pelo ESLint (`no-restricted-imports` em `eslint.config.js`): um import proibido faz `pnpm lint` falhar.

## Estrutura

```
apps/
  demo/          página Vite de demonstração do editor (etapa 1)
  desktop/       app Tauri 2 (src/), harness de testes no Chromium (harness/) e casca Rust (src-tauri/)
packages/
  core/          editor CodeMirror 6 + lang-markdown (GFM), comandos, atalhos e live preview; sem React/Tauri
  themes/        tokens CSS (tokens.css), temas embutidos, validador de theme.json, preferências
                 do vault (.simplemd/config.json), fontes mono embutidas (woff2 + OFL)
  ui/            componentes React compartilhados, como <CodeMirrorEditor>
  vault/         VaultProvider + LocalFsProvider sobre uma porta de arquivos injetável (Tauri,
                 Node nos testes, memória no harness); guarda de caminhos, conflitos, EOL/BOM
scripts/         check-tauri-security.mjs e assert-no-harness.mjs (portões do CI)
```

Os pacotes internos são consumidos como código-fonte TypeScript (sem etapa de build por pacote).

## Desenvolvimento

Requisitos: Node.js 22 (a versão do CI está em `.node-version`), pnpm 12 (a versão exata está em `packageManager` no `package.json`) e, para o app desktop, Rust com os pré-requisitos do Tauri 2 (Xcode CLT no macOS; WebView2 e MSVC no Windows). A versão do Rust é fixada em `rust-toolchain.toml` e o rustup a instala sozinho. O `pnpm-workspace.yaml` liga a política de cadeia de suprimentos do pnpm (versões com menos de 1 dia, rebaixamento de confiança e dependências transitivas fora do registro são recusados, inclusive no `--frozen-lockfile`).

```sh
pnpm install          # instala as dependências do monorepo
pnpm lint             # ESLint + prettier --check
pnpm typecheck        # tsc --noEmit em cada pacote
pnpm test             # Vitest em todos os pacotes
pnpm test:coverage    # Vitest com cobertura (relatório em build/coverage)
pnpm format           # prettier --write
pnpm check:security   # portão estático do Tauri: capabilities sem escopo fixo, sem shell/process, CSP
pnpm dev              # app desktop (tauri dev; o mesmo que pnpm dev:desktop)
pnpm dev:harness      # a mesma interface no navegador, com vault em memória (http://localhost:5174)
pnpm dev:demo         # demo do editor em http://localhost:5173
pnpm tauri build --no-bundle   # binário de release em apps/desktop/src-tauri/target/release/
```

### App desktop

`pnpm dev` abre a janela do simpleMD. "Abrir pasta…" (`Mod-O`) mostra o diálogo nativo; o app só recebe acesso à pasta escolhida (e à `.simplemd/` dentro dela) durante a sessão. Arquivos `.md` aparecem no explorador; clique ou Enter abre uma aba. As alterações são salvas 1 s depois da última tecla, e também ao fechar a aba (`Mod-W`) ou a janela. Se o arquivo mudar fora do app com alterações pendentes, o diálogo de conflito oferece "Manter ambos" (as suas alterações vão para `<nome> (conflito AAAA-MM-DD HH-mm-ss).md`) ou "Recarregar do disco"; nada é sobrescrito sem você ver. No terminal, o app imprime `simplemd:ready <ms>` no primeiro quadro e `simplemd:conflict-shown <ms>` quando o diálogo de conflito aparece.

### Harness de testes (Chromium)

`pnpm dev:harness` serve a interface do desktop com o `LocalFsProvider` real sobre um vault em memória (nunca entra no build do Tauri). Parâmetros: `?vault=FX-SMALL` (ou `FX-EMPTY`, `FX-2000`, `FX-LP`, `FX-DUP`, `FX-LONG`, `FX-10K`, `FX-1MB`, `FX-CFG-BAD`, `FX-CFG-UNK`, `FX-LATIN1`), `&expand=all` e `&persist=1`. O objeto `window.__simplemdHarness` simula mudanças externas (`externalWrite`, `touch`, `remove`), injeta falhas (`fault('write', { error: 'IO' })`), registra as chamadas (`calls()`), troca o resultado do diálogo de pasta (`dialogs.open`), fixa o relógio (`setClock`) e simula o fechamento da janela (`requestWindowClose()`).

### Live preview

O editor (demo e app desktop) mostra o markdown renderizado sem mudar o texto do arquivo: títulos `#` a `######` sem as marcas e com tamanho por nível, negrito e itálico sem os marcadores, links `[texto](url)` só com o texto sublinhado, marcadores de lista como `•` (números continuam visíveis), blocos de código cercados com fundo próprio e cercas atenuadas, e tabelas GFM como `<table>` com o alinhamento da linha `:---:`. Com o editor focado, o elemento sob o cursor ou a seleção volta a mostrar o markdown cru: o nó (ênfase, link), a linha (título, marcador de lista) ou o bloco (código, tabela). Clicar numa tabela põe o cursor na célula correspondente da fonte. Links não são clicáveis nesta versão. Tachado, código em linha, listas de tarefas e citações ficam como texto cru.

### Temas e fontes

A engrenagem "Configurações" (ou `Mod-,`) abre o diálogo com o tema ("simpleMD Claro" / "simpleMD Escuro"), a família da fonte do editor (JetBrains Mono, Fira Code, Cascadia Code ou a monoespaçada do sistema), o tamanho (10–32 px) e as ligaduras. Tudo vale na hora, sem recarregar. Com uma pasta aberta, as escolhas vão para `<pasta>/.simplemd/config.json` (outras chaves do arquivo são preservadas) e voltam ao reabrir a pasta; se o arquivo estiver malformado, o app usa os padrões e não o regrava. Os temas usam os tokens de `packages/themes/src/tokens.css` (nomes `--<grupo>-<nome>`, ver `PLANO.md` §4.2); as fontes embutidas e suas licenças OFL ficam em `packages/themes/src/fonts/`.

### Editor de temas

Em "Configurações", "Editor de temas…" abre um formulário com as 8 cores, as duas fontes e o tamanho do tema, mais nome e base (claro/escuro), e uma prévia ao vivo que só muda dentro do próprio editor. "Salvar como novo tema" grava `<pasta>/.simplemd/themes/<slug>/theme.json` (nunca substitui um tema existente: `<slug>-2`, `<slug>-3`…) e ativa o tema na hora. "Exportar tema…" grava o tema selecionado num arquivo à sua escolha; "Importar tema…" valida um `theme.json` (até 256 KB) e o copia para a pasta sem ativá-lo. No harness, a exportação vira um download e a importação usa o campo de arquivo `set-import-input` (exemplos em `apps/desktop/harness/fixtures/themes/`).

### Exportação

O menu "Exportar" da barra (e a paleta; `Mod-P` = PDF) exporta a nota ativa como ela está no editor, mesmo antes de salvar. "Exportar como Markdown…" grava os mesmos bytes que salvar gravaria (com a opção "Sem front matter"); "Exportar como HTML…" gera um único arquivo com estilo claro embutido, diagramas Mermaid em SVG, fórmulas KaTeX (fontes embutidas só quando há fórmula) e resultados do `calc`, sem scripts; HTML cru da nota sai renderizado pela mesma política de segurança do editor (veja "HTML cru" abaixo). "Exportar como PDF…" abre o painel de impressão do sistema com só o documento, em A4, sempre claro ("Salvar como PDF" no macOS). O destino é escolhido no diálogo do sistema e o próprio arquivo da nota é recusado. No harness, `dialogs.save` aceita `same-as-source`/`denied`, `exportText(i)` devolve o arquivo gerado, `print.mode = 'hold'` segura a impressão até `print.release()` e `exportHtml(md)` devolve o HTML de produção.

HTML cru (I-10): blocos HTML e tags em linha balanceadas no mesmo parágrafo (`<kbd>`, `<mark>`, `<br>`, `<details>`/`<summary>`, `<sub>`/`<sup>`, tabelas…) aparecem renderizados no editor fora do cursor e na exportação; com o cursor dentro, ou com tag sem fechamento, o cru volta. Tudo passa por uma política única (DOMPurify): sem scripts, manipuladores `on*`, formulários, mídia, `iframe`/`object`/`embed`, SVG/MathML, `class`/`id`/`name`; `style` só com cor, fundo, alinhamento, peso, itálico e decoração do texto; links só `http`/`https`/`mailto` ou relativos (no editor, ⌘/Ctrl-clique abre; clique simples põe o cursor na fonte); `<img>` só do vault (remota vira o texto alternativo). Um bloco em que nada sobra mostra "HTML sem conteúdo exibível (removido por segurança)."; `<details>` abre e fecha só na vista (o arquivo não muda), e "Interagir com o elemento sob o cursor" (⌘⇧↩ / Ctrl+Shift+Enter) leva o foco ao resumo e aos links do bloco.

Limitação conhecida (NB-R1): na exportação HTML/PDF, um diagrama Mermaid cujo SVG usa `foreignObject` (por exemplo `journey`) sai como o código do diagrama, não como desenho: a verificação da saída dos renderizadores recusa `foreignObject` por segurança. No editor o diagrama continua desenhado.

### Demo do editor

`pnpm dev:demo` abre a demo em <http://localhost:5173>. Atalhos: `Mod-B` alterna negrito (`**…**`), `Mod-I` alterna itálico (`*…*`) e `Mod-K` insere um link (`[texto](url)`, com `url` selecionado). `Mod` é Cmd no macOS e Ctrl no Windows/Linux. Parâmetros de URL:

- `?doc=fixture` abre o documento de exemplo do live preview (`packages/core/test/fixtures/live-preview.md`);
- `?doc=large` gera um documento de 10.000 linhas para medir desempenho;
- `&theme=simplemd-dark` abre a demo no tema escuro (o seletor "Tema" troca na hora).

O CI (`.github/workflows/ci.yml`) roda lint, typecheck e `check:security` no Ubuntu, os testes no Ubuntu, Windows e macOS (os testes do vault usam pastas temporárias reais em cada sistema), compila o app Tauri no macOS e no Windows e, no job `export-pdf-windows`, imprime o HTML exportado de `export-fixture.md` em PDF A4 pelo Edge (o motor do WebView2), confere o texto do PDF e guarda o PDF com o sha256 como artefato. Os jobs `secrets` (gitleaks e trufflehog `--only-verified` no histórico inteiro; falsos positivos revisados em `.gitleaksignore`), `audit` (`pnpm audit --prod --audit-level high`, `cargo audit` e osv-scanner nos dois lockfiles; exceções em `apps/desktop/src-tauri/.cargo/audit.toml` e `osv-scanner.toml`) e `semgrep` (regras de `semgrep/semgrep-rules` fixadas num commit, com o sha256 do tarball conferido e a lista em `.github/semgrep-rules.txt`; exceções só com `nosemgrep` justificado na linha) reprovam qualquer achado. As regras ao vivo do registro do Semgrep rodam toda semana no workflow `semgrep-latest.yml`, que não é obrigatório. Toda ação é fixada pelo SHA do commit (o repositório também exige isso e só permite as ações usadas), nenhum checkout guarda a credencial do git e o `check:security` confere essas regras (`scripts/check-ci-supply-chain.mjs`).

Cada perna do `desktop-build` publica como artefato (30 dias) o binário, `dist-digest.txt` e `SHA256SUMS`, para conferir a proveniência com `shasum -a 256 -c SHA256SUMS`; no Windows ela também roda o teste do keychain real (`roundtrip_real_keychain`, com `--include-ignored`), que fica `ignored` no macOS. O workflow `perf.yml` roda a suíte inteira com `SIMPLEMD_PERF=1`, incluindo as asserções de tempo que os jobs `test` pulam; ele não é obrigatório.

A `main` só recebe mudanças por PR, com as 10 verificações obrigatórias verdes (`lint`, `test` nos três sistemas, `desktop-build` no macOS e no Windows, `export-pdf-windows`, `secrets`, `audit` e `semgrep`), o branch atualizado e histórico linear. Só o admin cria tags `v*`, e elas não mudam depois. O `release.yml` roda numa tag `v*` ou à mão; todo `tauri build` (também o do `desktop-build`) roda com `-- --locked`, então o cargo usa o `Cargo.lock` do repositório. À mão, é um dry-run que gera os pacotes sem assinatura de desenvolvedor (dmg, msi e nsis; o `.app` do macOS com assinatura ad-hoc, conferida por `codesign` antes do upload) como artefatos de 7 dias, sem segredos e sem Environment. O pré-lançamento sem assinatura sai do mesmo dry-run, disparado **na tag** com o input `unsigned_prerelease` (`gh workflow run release.yml --ref vX.Y.Z -f unsigned_prerelease=true`): antes do install, o passo `unsigned-prerelease-guard` exige que a ref seja uma tag `v*` de um commit da `main` com a versão do app; depois das duas pernas, o job `publish-unsigned` (Environment `release`, revisor obrigatório, sem checkout) confere a lista exata dos artefatos e publica só o `.dmg` e o `-setup.exe`, com `SHA256SUMS`, atestado de proveniência e as notas geradas no job, num release em **rascunho** marcado como pré-lançamento; o dono publica à mão. No push da tag roda o caminho assinado, no Environment `release` (revisor obrigatório), que exige os segredos de assinatura (hoje o Environment não tem nenhum, e a perna Windows falha até a assinatura do Windows existir); o build roda sem segredos, só o passo `tauri bundle` assina, e o resultado é um release em **rascunho** com `SHA256SUMS` e atestado de proveniência.

## Licença

[MIT](LICENSE) © 2026 Rafael Brauner
