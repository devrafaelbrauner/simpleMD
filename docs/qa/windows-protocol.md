# Protocolo de QA no Windows 11 (B-19)

Roteiro da sessão interativa no Windows que fecha B-03 (QA interativa) e B-04 (impressão para PDF no WebView2), mais as partes do Windows de B-06 (WebRTC) e B-14 (IME, teclas mortas, NVDA). Ele espelha as regras de segurança da GUI usadas no macOS e define o formato da evidência.

- **Status:** BLOQUEADO até o usuário fornecer uma VM ou um PC com Windows 11 (AC-B19.3). Até a sessão rodar, os registros continuam com "Windows interativo: NÃO TESTADO" e "critério 4 no WebView2: NÃO TESTADO".
- **Quem roda:** só o agente autorizado a dirigir a GUI do Windows, nessa máquina e com estas regras.
- **Critérios de aceite:** os IDs AC-Bxx.y vêm do escopo do run r3 (`.nexus/runs/r3-backlog-b01-b19/scope.md`, B-03, B-04, B-06, B-14, B-19). Os critérios 1–7 são os do `PLANO.md` §5.
- **Evidência:** fica fora do repositório, na pasta do run que executar a sessão (por exemplo `.nexus/runs/<run>/qa/win-<AAAA-MM-DD>/`). Ver a seção 6.

## 1. Ambiente (AC-B19.1 a)

- **Sistema:** Windows 11 23H2 ou mais novo. O CI só gera o binário x64 (`desktop-windows`; o `simplemd.exe` é PE32+ x86-64). Registre a versão e o build (`[Environment]::OSVersion`, `winver`), a arquitetura (`$env:PROCESSOR_ARCHITECTURE`) e se é VM (qual hipervisor) ou PC. Prefira x64. Uma VM num Mac com Apple Silicon roda o Windows 11 **ARM64**: lá o `simplemd.exe` x64 roda emulado [inferência: emulação x64 do Windows on ARM; confirme na sessão que o app abre], e os tempos (critério 6, NFR-32) valem só para "x64 emulado em ARM64"; registre isso em cada linha de tempo do `report.md`. Nesse caso use o artefato do CI, não um build local (ele sairia ARM64 e não seria o binário do CI).
- **Snapshot:** tire um snapshot da VM ou um ponto de restauração **antes** da sessão. A limpeza preferida é voltar a ele (seção 7).
- **Conta:** uma conta local de teste, isolada, sem conta Microsoft pessoal. As ferramentas são instaladas antes do snapshot, por uma conta de administrador separada; a sessão roda na conta de teste como usuário padrão. Nenhum token do GitHub, chave SSH ou credencial do Mac entra na VM: os artefatos chegam por uma pasta de transferência (seção 3).
- **Sem chaves reais.** Nenhuma chave de API real entra na máquina. O critério 7 com OpenAI ou Anthropic fica **BLOQUEADO**, a não ser que o próprio usuário digite a chave dele; o agente nunca digita uma chave real.
- **Sem contas pessoais na nuvem.** Para o AC-B03.5 use uma conta de teste do OneDrive separada, só com notas de teste.
- **WebView2 Evergreen:** o Windows 11 já traz o runtime; se faltar, instale o Evergreen Standalone da arquitetura da máquina antes do snapshot. Registre a versão no início **e no fim** da sessão (o Edge Update pode atualizar o runtime no meio; uma troca vira nota no `report.md`). Por exemplo: `(Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}').pv`. Se a chave HKLM não existir, use `HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` ou `Get-Process msedgewebview2 -FileVersionInfo | Select-Object -First 1 FileVersion` com o app aberto.
- **Atualizações:** antes do snapshot, pause o Windows Update (Configurações → Windows Update → Pausar atualizações), para nenhuma reinicialização cair no meio da sessão. Registre até quando ficou pausado.
- **Argumentos do WebView2 por fora do app:** a variável de ambiente `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` e a política de registro `AdditionalBrowserArguments` do WebView2 **sobrepõem** os argumentos que o app passa ([documentação da Microsoft](https://learn.microsoft.com/microsoft-edge/webview2/reference/win32/webview2-idl); [WebView2Feedback #5571](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5571)). Isso desligaria a flag de WebRTC do app. Antes da sessão, registre que as duas estão ausentes: `Get-ChildItem Env:WEBVIEW2*` vazio, e `reg query HKLM\SOFTWARE\Policies\Microsoft\Edge\WebView2 /s` e `reg query HKCU\SOFTWARE\Policies\Microsoft\Edge\WebView2 /s` sem a subchave `AdditionalBrowserArguments` (a política fica numa subchave, com um valor por executável; sem `/s` ela não aparece). Registre a saída inteira: outras políticas dessa chave, como `BrowserExecutableFolder` e `ReleaseChannelPreference`, também mudam o runtime usado. [Inferência: organização da política conforme a documentação de políticas do WebView2; confirme na VM.] A única exceção é o experimento do proxy morto (seção 5.8), que define a variável só no processo que abre o app.
- **Ferramentas** (instaladas antes do snapshot):
  - PowerShell e Git for Windows (o Git Bash traz `sha256sum`);
  - Python 3, para o `listener.py` da sonda de rede;
  - Ollama com um modelo pequeno já baixado (`ollama pull` antes do snapshot; registre `ollama list`, com nome e id do modelo), para o critério 7 local;
  - o NVDA como cópia portátil em `%TEMP%\smd-win-nvda` (a configuração de um NVDA instalado não muda), com o Visualizador de Fala (Speech Viewer);
  - Node 22.22.3 e pnpm 12.8.1, só para gerar o vault de 2.000 notas (`node scripts/gen-vault.mjs <pasta>`) ou para um build local. Para o build local também o Rust pelo `rustup` (ele lê `rust-toolchain.toml`: 1.98.1) e o Visual Studio Build Tools com a carga "Desenvolvimento para desktop com C++" e o SDK do Windows;
  - o leitor de PDF padrão e a impressora "Microsoft Print to PDF";
  - um cliente de UI Automation e os ajudantes de guarda, entrada e captura, prontos e com sha256 registrado antes do snapshot (por exemplo Python 3 + `pywinauto`/`comtypes` para a UIA e um script PowerShell/C# com `GetForegroundWindow`, `SendInput` por código de tecla e `PrintWindow`). Teste-os uma vez no Bloco de Notas **antes** da sessão; esse teste não entra na evidência;
  - o IME japonês da Microsoft e os layouts US-Internacional e Português (Brasil ABNT2) instalados antes do snapshot. Registre `Get-WinUserLanguageList` no momento do snapshot: essa lista é o "antes" da seção 7.
- **Rede** (para a sonda e o proxy morto): sem VPN e sem proxy do sistema. Registre `netsh winhttp show proxy` e `Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' | Select-Object ProxyEnable,ProxyServer,AutoConfigURL,AutoDetect`; esperado: sem proxy e sem PAC (sem `--proxy-server`, o WebView2 usa o proxy do sistema, o que mudaria o 5.6 e o 5.8). As portas de loopback ficam livres: `Get-NetTCPConnection -LocalPort 9,47901 -State Listen -ErrorAction SilentlyContinue` e `Get-NetUDPEndpoint -LocalPort 47902 -ErrorAction SilentlyContinue` vazios. A porta 9 tem de estar morta para o 5.8: com os "Serviços TCP/IP simples" do Windows ligados, o serviço discard escuta nela e o experimento não vale. A rede da VM (NAT) só precisa de internet para o OneDrive (5.5) e para a nuvem do critério 7; o resto é loopback. Se o Firewall do Windows pedir permissão para o `python.exe` do `listener.py`, vale a regra 6 da seção 2: não clique e chame o Main (o listener só usa loopback).

## 2. Segurança da GUI (AC-B19.1 b)

As mesmas regras do macOS, traduzidas para o Windows:

1. **Guarda de primeiro plano antes de cada tecla.** Antes de qualquer tecla ou clique sintético, confira que a janela em primeiro plano pertence ao processo `simplemd.exe` em teste. Se não pertencer, **não envie** e registre a recusa. Nunca digite num terminal, navegador ou outro app. Exemplo em PowerShell:

   ```powershell
   Add-Type @"
   using System; using System.Runtime.InteropServices;
   public static class Fg {
     [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
     [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
   }
   "@
   function Test-SimplemdFront([uint32]$AppPid) {
     [uint32]$p = 0
     [void][Fg]::GetWindowThreadProcessId([Fg]::GetForegroundWindow(), [ref]$p)
     return $p -eq $AppPid
   }
   ```

   O `"@` que fecha o here-string tem de ficar na coluna 0: copie do Markdown renderizado ou tire o recuo.

2. **UI Automation antes de entrada sintética.** Botões, abas, interruptores e campos são acionados por UI Automation (`InvokePattern`, `SelectionItemPattern`, `TogglePattern`, `ValuePattern`). Entrada sintética (`SendInput`) só quando a UI Automation não alcança, como digitar no editor CodeMirror, atalhos e o IME, e sempre depois da guarda. Para digitar no editor, mande teclas reais (`SendInput` com código de tecla virtual ou `KEYEVENTF_SCANCODE`) pelo layout ativo. Nunca use `KEYEVENTF_UNICODE` (VK_PACKET) em texto que testa teclas mortas, IME ou autocompletar: ele entrega o caractere pronto, pula a composição e dá um PASS falso (no macOS o mesmo cuidado levou ao `ktype`). Registre o estado do Caps Lock e do Num Lock no início e volte a ele no fim; no macOS um Caps Lock ligado trocou `nih` por `NIH`.
3. **Capturas só da janela do app.** Capture apenas a janela do `simplemd.exe` (`PrintWindow(hwnd, hdc, 2)`, isto é `PW_RENDERFULLCONTENT`, no HWND dela; sem essa flag o conteúdo do WebView2 pode sair preto, então confira a primeira captura. Alternativa: o retângulo da janela por `CopyFromScreen`, só depois da guarda e só se nenhuma outra janela o cobre). Exceções, como o painel de legendas do VoiceOver no macOS: a janela do Visualizador de Fala do NVDA e os diálogos nativos do próprio `simplemd.exe` (confirmação de chave, salvar arquivo, impressão). Nunca a área de trabalho inteira. Nunca capture um campo de chave preenchido, o Gerenciador de Credenciais nem diálogos do Windows Security ou do UAC.
4. **Só vaults de teste.** Vaults só em `%TEMP%\smd-win-*`; a única exceção é a pasta de teste dentro do OneDrive de teste (AC-B03.5). Nunca abra Documentos, a área de trabalho ou uma pasta real do usuário.
5. **Credenciais.** Só o serviço do app (`io.github.devrafaelbrauner.simplemd`) e só com o valor falso `valor-de-teste-winqa`. Nesta máquina não há chave real, então o agente **pode** confirmar os diálogos "Salvar chave" e "Remover chave" com esse valor falso; isso nunca vale numa máquina com chaves reais. Nunca abra, edite nem leia outras entradas do Gerenciador de Credenciais; para conferir, use só `cmdkey /list`, que mostra nomes e nunca senhas, filtrado por `simplemd`. O app não tem um serviço de teste separado (o `….simplemd.test-*` é só do teste do CI); por isso o 5.3 usa o serviço real do app com o valor falso, e só numa máquina sem chave real. Essa permissão de confirmar vale só se `cmdkey /list | Select-String simplemd` estiver vazio no início do 5.3. Se aparecer qualquer linha, pare: o agente não confirma mais nenhum diálogo de chave e chama o Main. O alvo esperado no `cmdkey` é `ai.openai.io.github.devrafaelbrauner.simplemd` (keyring 3.6.3: `<conta>.<serviço>`; confirme na sessão).
6. **Pare e chame o Main** se aparecer um pedido do UAC, do Windows Hello, do SmartScreen sobre outro arquivo que não o binário em teste, ou qualquer diálogo inesperado. Não clique nele.
7. **Configurações do sistema** que a sessão muda (idiomas de entrada, NVDA, OneDrive de teste) são registradas antes e depois e voltam ao estado de antes no fim (seção 7).
8. **Sessão interativa.** Tudo o que manda tecla, usa UI Automation ou captura a janela roda **dentro da sessão interativa da conta de teste** (console da VM, ou RDP aberto e **não minimizado**). Não rode esses passos direto por SSH, WinRM ou serviço: eles ficam fora da área de trabalho interativa, a entrada sintética não chega ao app e a captura sai preta. Se o agente entra por SSH, ele dispara os scripts na sessão interativa (por exemplo uma tarefa agendada com `/IT`, "só quando o usuário está conectado") e lê a saída em arquivo. Registre em `env.txt` como o agente chegou à sessão.
9. **Sem elevação.** O app e os scripts rodam sem elevação, no mesmo nível de integridade: a `SendInput` não alcança janelas elevadas (UIPI), e nenhum passo precisa de administrador.

## 3. Instalação (AC-B19.1 c)

- **Preferido:** o artefato `desktop-windows` de um run `push` verde do CI na `main`. Ele traz `simplemd.exe`, `dist-digest.txt`, `dist-files.sha256` e `SHA256SUMS`. O artefato vive 30 dias (`retention-days: 30`) e o `ci.yml` não tem `workflow_dispatch`; um run com mais de 30 dias também não pode ser reexecutado [inferência: limite de reexecução do GitHub Actions]. Por isso, na data da sessão, use o run `push` verde mais recente da `main` e registre a revisão dele. No Mac, dentro do clone e com o `gh` já autenticado (nenhum token entra na VM):
  1. `gh run view <id> --json headSha,headBranch,event,conclusion` → `main`, `push`, `success`;
  2. `gh api repos/devrafaelbrauner/simpleMD/actions/runs/<id>/artifacts --jq '.artifacts[]|select(.name=="desktop-windows")|[.id,.digest,.expires_at]'` e depois `gh api repos/devrafaelbrauner/simpleMD/actions/artifacts/<id do artefato>/zip > desktop-windows.zip`. O `shasum -a 256 desktop-windows.zip` tem de ser igual ao `digest` (sem o prefixo `sha256:`). Ensaio em 2026-10-08, run 37746715856 (`cc8a247`): zip `d6103464…6f508`, igual ao `digest`;
  3. copie o zip para a VM por uma pasta de transferência só para isso (nunca a pasta pessoal do Mac compartilhada), extraia em `%TEMP%\smd-win-bin` e confira no Git Bash com `sha256sum -c SHA256SUMS` (as três linhas `OK`).

  Registre o id do run, a revisão (`headSha`), o `digest` do zip e o sha256 do `simplemd.exe`.
- **Alternativa:** um build local na revisão registrada, numa máquina x64 (seção 1), com as ferramentas de build da seção 1. Os passos são os do job `desktop-build` do CI: `pnpm install --frozen-lockfile`, `pnpm tauri build --no-bundle`, `node scripts/assert-no-harness.mjs apps/desktop/dist` e `node scripts/assert-no-ai-recorder.mjs`. O binário fica em `apps/desktop/src-tauri/target/release/simplemd.exe`. Registre o sha256 dele e gere o `dist-files.sha256` como no CI (`cd apps/desktop/dist && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum`). Um build local não é o binário do CI: a evidência diz qual das duas foi usada.
- Os instaladores sem assinatura do dry-run do `release.yml` (`bundle-dry-run-windows`: msi e nsis) **não** fazem parte desta sessão: instalar e atualizar com assinatura é o AC-B01.11 (B-01). Esse artefato só sai de um `workflow_dispatch`, vive 7 dias e não traz `SHA256SUMS`; instalar escreve no registro e em Arquivos de Programas.
- O binário não tem assinatura e vem de fora da VM. Depois do `sha256sum -c` com `OK`, tire a marca da web só dele: `Unblock-File "$env:TEMP\smd-win-bin\simplemd.exe"`, com `Get-Item "$env:TEMP\smd-win-bin\simplemd.exe" -Stream Zone.Identifier -ErrorAction SilentlyContinue` registrado antes e depois. Se mesmo assim o SmartScreen avisar, é o usuário quem libera esse arquivo; registre o aviso.
- Para ver as marcas do app (`simplemd:ready`, `simplemd:export-print`, `simplemd:catalog-shown`…), abra o app pelo PowerShell com a saída redirecionada, por exemplo `Start-Process .\simplemd.exe -RedirectStandardOutput out.txt -RedirectStandardError err.txt -PassThru` (guarde o PID para a guarda da seção 2). [Inferência: o binário é de subsistema GUI; confirme na primeira execução que as linhas aparecem em `out.txt`.]

## 4. Preparação dos dados

- Vault pequeno: `%TEMP%\smd-win-basico` com algumas notas `.md` (LF e CRLF + BOM), mais `rich.md`, `calc-fixture.md` e `export-fixture.md` (de `packages/plugins-internal/test/fixtures/`).
- Vault grande: `%TEMP%\smd-win-2000`, gerado por `node scripts/gen-vault.mjs %TEMP%\smd-win-2000`.
- Plugin de exemplo: `plugins-examples/hello-world/` (`manifest.json` + `main.js`, id `com.exemplo.hello-world`).
- Sonda de rede (fora do repositório, nunca publicada): o `listener.py` da AppSec r2 (`.nexus/runs/r2-etapas-6-12/qa/AppSecR2/wk-csp-probe/listener.py`; TCP `127.0.0.1:47901`, UDP `127.0.0.1:47902`, só loopback) e o plugin de sonda do r3 (`.nexus/runs/r3-backlog-b01-b19/qa/EvidenceCollectorR5/fixtures/probe-r3/`). Copie os dois para a VM. Na cópia da sonda, acrescente um comando de teste "TURN sobre TCP" (`new RTCPeerConnection({ iceServers: [{ urls: 'turn:127.0.0.1:47901?transport=tcp', username: 'u', credential: 'p' }] })`, um `createDataChannel`, `createOffer` e `setLocalDescription`). Ele só mira o listener local. Na cópia do `listener.py`, faça o TCP registrar os 20 primeiros bytes em hex e marcar `TURN-allocate` quando `data[0:2] == b'\x00\x03'` e `data[4:8] == b'\x21\x12\xa4\x42'`, e use `time.gmtime` (UTC) no horário. O original do r2 grava só a primeira linha em latin1 e não identifica um Allocate. Registre o sha256 da cópia alterada.
- Registre o sha256 de cada arquivo copiado.

## 5. Roteiros da sessão (AC-B19.1 d)

Cada passo registra o esperado e o observado literal. As seções estão agrupadas por AC; a **ordem da sessão** é esta: 5.1 (critérios 1, 5, 6 e 7 só com o Ollama) → 5.4 → 5.2 → 5.3 → 5.6 → 5.7 → 5.8 → 5.9 (teclas mortas e IME, depois NVDA) → 5.5 (OneDrive) → critério 7 na nuvem, só se o usuário quiser digitar a própria chave (seção 2, item 5) → seção 7. O que muda o sistema (proxy morto, idiomas, NVDA, OneDrive, chave do usuário) vem depois do que não muda.

### 5.1 AC-B03.1 — critérios 1, 2, 5, 6 e 7

- **Critério 1 (abrir, editar, salvar; AC-2.22):** abra `%TEMP%\smd-win-basico` com "Abrir pasta…" (`Ctrl+O`), abra uma nota, digite, espere o autosave (1 s) e confira os bytes no disco (`Get-FileHash` antes e depois, `Format-Hex` no trecho; o CRLF + BOM da nota CRLF é preservado). Mude a nota fora do app com edições pendentes e confirme o diálogo de conflito com "Manter ambos" (cópia `<nome> (conflito …).md`) e "Recarregar do disco". Feche a aba (`Ctrl+W`) e a janela com uma edição pendente: a edição é gravada.
- **Critério 2 (plugin sem recompilar):** ver 5.4 (o mesmo roteiro).
- **Critério 5 (autocompletar; AC-8.7/8.8):** Configurações → "Autocompletar" desligado → feche e reabra a pasta → `[[` não abre popup → ligue → popup. `Ctrl+Espaço` abre as sugestões. Enter sem opção ativada pelas setas quebra a linha (R4-02). Persistência: com o autocompletar desligado, feche o app (`Get-Process simplemd` vazio), abra de novo e confira que o interruptor continua "Desligado" e que `.simplemd\config.json` do vault tem `"autocomplete"` com `"enabled": false` (bytes no disco, `Get-Content -Raw`). Religue no fim e registre de novo.
- **Critério 6 (catálogo; AC-9.10, NFR-26):** abra `%TEMP%\smd-win-2000`: catálogo com 2.000 notas, busca por título, `#tag`, Sumário e Propriedades da nota aberta. Registre 5 tempos de "Mostrar catálogo" pela marca `simplemd:catalog-shown` (cada um < 1.000 ms).
- **Critério 7 (IA):** Ollama local (AC-11.15): "IA: Resumir seleção" com o Ollama rodando → o cartão de resultado aparece e o texto só muda pelo clique. OpenAI/Anthropic: **BLOQUEADO** (sem chave real nesta máquina), a não ser que o usuário digite a própria chave **no fim da sessão, depois do 5.3 e do 5.9**. Nesse caso o próprio usuário remove a chave ("Remover chave") antes da seção 7; o agente não confirma esse diálogo e só registra `cmdkey /list | Select-String simplemd` vazio no fim.

### 5.2 AC-B03.2 — CR2-02 com o seletor de pasta não modal

1. Com `smd-win-basico` aberto e uma nota com edição não salva, abra "Abrir pasta…".
2. Com o seletor aberto, volte à janela do app (se ela aceitar foco) e digite `X-durante-o-seletor` na nota. Registre, com captura, se a janela do app aceita foco e teclas com o seletor aberto; a guarda de primeiro plano vale também aqui (o seletor é do `simplemd.exe`).
3. Escolha outra pasta de teste (`%TEMP%\smd-win-b`).
4. **Esperado:** o texto digitado com o seletor aberto está gravado na nota da pasta **anterior** (bytes no disco) antes de a pasta nova virar a ativa; nada é gravado na pasta nova.
5. Se o seletor for modal e o app não aceitar entrada enquanto ele está aberto, registre isso com a captura: o caso do AC-B03.2 não se aplica nesta máquina.

### 5.3 AC-B03.3 — Credential Manager pela interface

1. `cmdkey /list | Select-String simplemd` → nenhuma linha (estado inicial).
2. Configurações → IA → provedor OpenAI → campo da chave → `valor-de-teste-winqa` → "Salvar no keychain" → diálogo nativo "Salvar chave" (nomeia o provedor) → **Cancelar** → o status continua "Sem chave" e `cmdkey` continua sem linha.
3. Repita e confirme com "Salvar chave" → "Chave salva"; `cmdkey` mostra uma entrada com `simplemd` no nome. Feche e reabra as Configurações: "Chave salva", sem nenhum pedido.
4. "Remover chave" → diálogo → confirme → "Sem chave"; `cmdkey` sem linha.
5. Registre também se Esc fecha o diálogo (no macOS não fecha: MAC-K F-1) e qual é o botão padrão (Return).
6. **Esperado no fim:** nenhuma entrada do app no Gerenciador de Credenciais.
7. Registre o texto literal do título e dos botões dos dois diálogos (esperado: "Salvar a chave da OpenAI?" com "Salvar chave" e "Cancelar"; "Remover a chave da OpenAI?" com "Remover chave" e "Cancelar"). Se aparecer "OK" no lugar do rótulo, registre como achado.
8. Com a chave falsa salva (passo 3), procure o valor fora do Gerenciador de Credenciais: `Get-ChildItem -Recurse -File "$env:TEMP\smd-win-basico", "$env:APPDATA\io.github.devrafaelbrauner.simplemd", "$env:LOCALAPPDATA\io.github.devrafaelbrauner.simplemd" -ErrorAction SilentlyContinue | Select-String -SimpleMatch 'valor-de-teste-winqa' -List | Select-Object Path` → nenhuma linha (critério 7: nenhuma chave em texto plano; equivale ao scan do MAC-K). Registre a saída literal, também quando estiver vazia.

### 5.4 AC-B03.4 — fluxo de plugins (critério 2)

1. Copie `plugins-examples/hello-world/{manifest.json,main.js}` para `%TEMP%\smd-win-basico\.simplemd\plugins\com.exemplo.hello-world\`.
2. Configurações → "Plugins" → "Recarregar lista" → o plugin aparece → ativar → aviso "Ativar um plugin de terceiros?" → "Ativar mesmo assim".
3. Paleta (`Ctrl+Shift+P`) → "Dizer olá"; o atalho `Ctrl+Shift+H` faz o mesmo; digitar `hello` no editor mostra a decoração `cm-hello-world`. → aviso "Olá do plugin hello-world!"; a decoração é conferida pela captura (fundo `--color-hover` em cada `hello`).
4. Desative o plugin: o comando some e a decoração some, sem recriar o editor.

### 5.5 AC-B03.5 — marcadores do OneDrive "Arquivos sob demanda" (NB-R2)

1. O **usuário** entra na conta de teste do OneDrive, com "Arquivos sob demanda" ligado (o agente nunca digita senha). Na pasta de teste do OneDrive, crie pelo PowerShell 3 notas `.md` com conteúdo conhecido e uma subpasta com mais uma; registre o sha256 de cada uma. Espere sincronizar e libere o espaço: `attrib +U -P <nota>` (fica só online). Antes de abrir, registre `attrib <nota>` (com `U`) e `Get-Item <nota> | Select-Object Name,Attributes,Length`.
2. Abra essa pasta como vault. **Esperado:** as notas só online aparecem no explorador e não são descartadas como link. Sem abrir nenhuma nota, registre `attrib` de novo: anote se listar a pasta já baixou as notas (dado para o catálogo, não falha do AC).
3. Abra uma nota: ela é baixada e mostrada sem `INVALID_PATH`, `OUTSIDE_VAULT` nem recusa como link, e o sha256 do arquivo baixado é o registrado no passo 1.
4. Edite e salve: confira os bytes no disco, espere sincronizar (sem erro de sincronização no OneDrive), libere o espaço de novo (`attrib +U -P`), reabra a nota no app e confira que o texto editado volta da nuvem.
5. Registre os atributos depois de abrir e depois de salvar. Qualquer recusa é registrada com o código de erro literal.

### 5.6 AC-B03.6 — sonda WebRTC com a flag do r3 (B-06)

1. Confira a rede (seção 1, **Rede**) e rode `python listener.py 47901 47902 <log> 180` no próprio Windows.
2. **Controle positivo** (sem tecla nem clique fora do app): uma página local `stun-control.html`, que roda sozinha ao carregar o mesmo vetor de STUN para `stun:127.0.0.1:47902`, aberta por `Start-Process msedge -ArgumentList "--user-data-dir=$env:TEMP\smd-win-edge","--no-first-run","file:///$env:TEMP/smd-win-probe/stun-control.html"` (perfil temporário, nunca o perfil do usuário). O log tem de mostrar datagramas UDP. Feche o Edge por `Stop-Process` (sem clicar) e apague `%TEMP%\smd-win-edge` na limpeza. Sem o controle positivo, a sonda não vale (NOT TESTED).
3. No app, ative a cópia da sonda num vault de teste e rode, um por vez: STUN no realm principal, STUN num iframe `about:blank`, `<link rel=preconnect href=http://127.0.0.1:47901>` e TURN sobre TCP.
4. **Esperado:** 0 datagramas UDP no STUN, nos dois realms (AC-B03.6). `preconnect`: registre o resultado (no Chromium deu 0 TCP). TURN sobre TCP: registre se chega uma conexão TCP com bytes de TURN Allocate em 47901; no Chromium 153 chegou, apesar da flag (APPSEC-R3-02).
5. Registre a linha de comando do processo do navegador do WebView2 do app (o `msedgewebview2.exe` sem `--type=`): `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId,ParentProcessId,CommandLine | Format-List > webview2-cmdline-5.6.txt`. Esperado: `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` e `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`. Essa é a prova de que a flag do r3 chegou ao WebView2.

### 5.7 AC-B04.1–3 — impressão para PDF no WebView2

1. Abra `export-fixture.md` no tema claro → `Ctrl+P` → painel de impressão → "Microsoft Print to PDF" → salve em `%TEMP%\smd-win-pdf\claro.pdf`. Repita no tema escuro (`escuro.pdf`). O PDF do tema escuro também sai claro (a impressão aplica os tokens claros); faixas escuras nele são a regressão S6-1. Se o diálogo "Salvar saída de impressão como" não pertencer ao `simplemd.exe` (a guarda mostra outro PID), preencha o nome do arquivo por UI Automation (`ValuePattern`) e acione "Salvar" por `InvokePattern`, sem `SendInput`; registre o nome do processo dono do diálogo.
2. **AC-B04.1:** nos dois PDFs há o diagrama Mermaid, a fórmula KaTeX, a tabela, o `5` do calc e os marcadores e números das listas; não há faixas escuras nem fio na borda (S6-1, S6-2); a página é A4.
3. **AC-B04.2:** baixe o artefato `export-pdf-windows` do CI da **mesma revisão** (`export.pdf` + `export.pdf.sha256`) e compare lado a lado com `claro.pdf`: nenhum elemento falta. O PDF do CI prova só o motor (Edge); este prova a impressão dentro do app.
4. **AC-B04.3 (NFR-32):** 5 vezes. t0 = horário (ms desde a época, UTC) em que o `Ctrl+P` é enviado. A marca `simplemd:export-print` no `out.txt` registra o **pedido** do painel e prova que o comando do app foi usado. t1 = primeira vez que a UI Automation encontra o painel de impressão (pré-visualização do WebView2), sondando a cada 50 ms. Esperado: t1 − t0 ≤ 4.000 ms em cada uma; registre também marca − t0. Uma tentativa sem a marca significa que o `Ctrl+P` caiu na impressão padrão do WebView2 e não no comando do app: ela não vale e vira achado.

### 5.8 Experimento do proxy morto (D-1, APPSEC-R3-02)

Só depois de 5.6, numa nova abertura do app, com a variável definida **apenas** no PowerShell que abre o app (como ela sobrepõe os argumentos do app, a string repete os padrões do wry e a flag de WebRTC do r3):

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --force-webrtc-ip-handling-policy=disable_non_proxied_udp --proxy-server=http://127.0.0.1:9 --proxy-bypass-list=<-loopback>'
Start-Process .\simplemd.exe -RedirectStandardOutput out-proxy.txt -RedirectStandardError err-proxy.txt -PassThru
Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
```

0. Rode o 5.8 só se o 5.6 mostrou TURN sobre TCP chegando ao listener (`TURN-allocate`). Se não chegou, registre "D-1 não aplicável: resíduo não reproduzido no WebView2 <versão>" e pule para o 5.9.
0b. Feche o app e confirme que não sobrou nenhum `msedgewebview2.exe` dele (a consulta do 5.6, passo 5, sem linhas). Com o processo do navegador anterior vivo, o WebView2 o reaproveita e os argumentos novos não valem. Depois de abrir o app com a variável, grave `webview2-cmdline-5.8.txt` do mesmo jeito: `--proxy-server=http://127.0.0.1:9` e `--proxy-bypass-list=<-loopback>` têm de aparecer, senão o experimento não vale.

1. **O app carrega e o IPC funciona** (`tauri.localhost`/`ipc.localhost`): a janela não fica em branco, `simplemd:ready` aparece, abrir a pasta, ler, editar e salvar uma nota, exportar HTML, abrir o painel de impressão e uma resposta do Ollama funcionam. A resposta do Ollama prova só o IPC: o pedido de IA sai do Rust (`ai/transport.rs`), não do WebView2, e não passa pelo proxy.
2. **Os canais fecham:** repita os vetores de 5.6; esperado 0 UDP e 0 TCP, inclusive TURN sobre TCP.
3. **Decisão:** se 1 e 2 passarem, a AppSec avalia levar os dois argumentos do proxy para `WEBVIEW2_ARGS` (`apps/desktop/src-tauri/src/webview_net.rs`) num PR próprio, com o `check:security` atualizado. Se o passo 1 falhar, o resíduo continua **aceito com documentação** (`docs/plugins.md`, item 5).
4. Feche o app no fim do experimento e confirme que nenhum `msedgewebview2.exe` com `--proxy-server` na linha de comando continua vivo antes de qualquer outra abertura.

### 5.9 AC-B14.9 — IME, teclas mortas e NVDA no WebView2

- **IME japonês da Microsoft (Romaji)** com o autocompletar ligado: componha `にほんご`, converta com Espaço e confirme com Enter. Esperado: só o texto confirmado entra, o Enter da composição confirma o candidato e nunca aceita uma sugestão, e os bytes gravados são o UTF-8 esperado. Registre também se o Enter **seguinte** a um commit convertido com Espaço quebra a linha (no WKWebView não quebra: IME-ENTER-1) e se o popup abre sob a janela de candidatos (IME-POP-1). Registre se o IME japonês está na versão atual ou na anterior ("Usar a versão anterior do IME da Microsoft") e se a conversão ao vivo está ligada.
- **Teclas mortas** (autocompletar ligado, numa nota de teste, numa linha nova): o texto alvo é o mesmo do macOS, `parabéns café não você ç é ã ê` + Enter. No **US-Internacional**: `'`+`e` → é, `~` (Shift+`` ` ``) + `a` → ã, `^` (Shift+6) + `e` → ê, `'`+`c` → ç. No **ABNT2**: ´ (tecla à direita do P) + `e`, `~` (tecla à direita do Ç) + `a`, Shift+`~` (^) + `e`, e o `ç` tem tecla própria. Bytes esperados da linha no disco (`Format-Hex`): `70 61 72 61 62 c3 a9 6e 73 20 63 61 66 c3 a9 20 6e c3 a3 6f 20 76 6f 63 c3 aa 20 c3 a7 20 c3 a9 20 c3 a3 20 c3 aa 0a` (ou `0d 0a` no fim, se a nota for CRLF). ´ ˜ ˆ ¨ `'` `~` `^` soltos no arquivo: 0. Capture a janela depois de `parab`, com o ´ pendente e depois do `é`, e registre se o popup fecha com a tecla morta pendente e volta depois da letra composta (referência no macOS: RUN r3 `qa/cc1/report.md` §3). Nenhuma sugestão aceita.
- **NVDA** (com o Visualizador de Fala ligado, que é a evidência em texto):
  - digitar uma palavra que abre o popup → "N sugestões, ↓ para escolher" falado uma vez por abertura, e as setas não o repetem (A11Y-R5-01; registre se ele se repete a cada pausa com a mesma contagem, A11Y-R3-01);
  - com o foco no editor, só a aba ativa é anunciada como selecionada (EC3-A11Y-1);
  - a falha ao salvar no editor de temas é lida uma vez (QR-05);
  - como o NVDA lê o atalho das abas (`aria-keyshortcuts`; no macOS o VoiceOver diz "Meta+W", VO-KS-1).
  - Antes de digitar com o NVDA ligado, confirme no Visualizador de Fala que ele está no **modo de foco** no editor. No modo de navegação as letras viram navegação rápida e o texto não chega ao editor: é falha do método, não do produto, e a tentativa é refeita.
  - O texto falado é lido por UI Automation na janela do Visualizador de Fala (`ValuePattern`/`TextPattern`) ou no log do NVDA com o nível "entrada/saída", que grava as falas [inferência: confirme no primeiro teste]. Nunca mande teclas para o Visualizador.
  - EC3-A11Y-1 também pela UI Automation, como o `AXSelected` no macOS: com o foco no editor, leia `SelectionItemPattern.Current.IsSelected` de cada aba; esperado `True` só na aba ativa.
  - QR-05: para a falha ao salvar o tema, negue a criação de arquivos na pasta de temas do vault de teste: `icacls "$env:TEMP\smd-win-basico\.simplemd\themes" /deny "$($env:USERNAME):(WD)"`. Confirme que o app mostra "Não foi possível salvar o tema. Nenhum tema foi ativado." antes de avaliar a fala, e desfaça na limpeza com `icacls "…\themes" /remove:d $env:USERNAME`.
  - Registre a versão do NVDA e o sha256 do `nvda.ini` da cópia portátil antes e depois.
- Registre os idiomas de entrada antes e depois (`Get-WinUserLanguageList`).

## 6. Formato da evidência (AC-B19.1 e)

- Na VM, a evidência é gravada em `%USERPROFILE%\smd-evidencia-<AAAA-MM-DD>`, fora de `%TEMP%\smd-win-*` (que a limpeza apaga), e só sai da VM no passo 11 da seção 7.
- `env.txt`: versão, build e arquitetura do Windows, versão do WebView2 no início e no fim, VM ou PC (hipervisor), CPU e RAM, resolução e escala da tela (DPI), fuso horário, como o agente chegou à sessão interativa (seção 2, item 8), Windows Update pausado, Caps Lock e Num Lock no início, a saída da checagem de `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` e da política de registro, e a de proxy e portas (seção 1).
- `revision.txt`: revisão (`git rev-parse HEAD` da origem do binário), id do run do CI com a saída do `gh run view`, `digest` do zip do artefato e o sha256 dele, saída literal do `sha256sum -c SHA256SUMS`, sha256 do `simplemd.exe`.
- `report.md`: uma linha por AC — ID, passos, esperado, observado (saída literal), **PASS / FAIL / NOT TESTED / BLOQUEADO**, arquivo de evidência com sha256 e horário em UTC. Ferramenta ou ambiente indisponível = NOT TESTED, nunca PASS. Cada achado novo é classificado BLOCKING ou NON-BLOCKING, com dono.
- Capturas: só da janela do app (PNG), com sha256; nunca com um campo de chave preenchido.
- Logs: `out*.txt`/`err*.txt` do app, logs do `listener.py`, texto do Visualizador de Fala do NVDA, saídas do `cmdkey /list` filtradas (só nomes), atributos dos arquivos do OneDrive.
- `SHA256SUMS` de todos os arquivos da pasta de evidência, gerado no Git Bash (hex minúsculo, que o `shasum -c` do Mac lê): `find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS`.
- `revision.txt` também traz o fingerprint do PROJECT na revisão do binário (`snapshot.py fingerprint`, gravado pelo Main no Mac) e o `dist-files.sha256` dos artefatos `desktop-windows` e `desktop-macos` do mesmo run do CI. Compare os dois por arquivo, não pelo `dist-digest.txt`: o `sha256sum` do Git Bash marca cada linha com `*` (modo binário) e o `shasum` do macOS não, então os dois `dist-digest.txt` diferem mesmo com o front-end igual. Normalize antes, no Mac: `sed -E 's/^([0-9a-f]{64}) [ *]/\1  /' dist-files.sha256 | tr -d '\r' | LC_ALL=C sort -k2 | shasum -a 256`; os dois resultados iguais mostram o mesmo front-end do binário macOS testado. Ensaio em 2026-10-08, run 37746715856 (`cc8a247`): `dist-digest.txt` `e9331e33…79179` (Windows) e `c37928cc…08070` (macOS); os 178 arquivos têm o mesmo sha256, e os dois normalizados dão `c37928cc…08070`. Todos os horários em UTC (`[DateTime]::UtcNow.ToString('o')`), também os do `listener.py` (seção 4). Logs extras: `webview2-cmdline-*.txt`, recusas da guarda com horário. A pasta de evidência é copiada para o RUN no Mac e o `SHA256SUMS` é conferido lá (`shasum -a 256 -c SHA256SUMS`; seção 7, passo 11).
- Só depois da sessão as frases "Windows interativo: NÃO TESTADO" e "critério 4 no WebView2: NÃO TESTADO" mudam em `TAREFAS_PENDENTES.md` e `docs/seguranca/etapa-12.md`, e só para os itens que tiverem PASS com evidência.

## 7. Limpeza e restauração (AC-B19.1 f)

1. Feche o app pelo menu ou pelo botão de fechar (o flush roda); `Get-Process simplemd -ErrorAction SilentlyContinue` vazio.
2. Pare o `listener.py` e o Ollama.
3. `cmdkey /list | Select-String simplemd` → nenhuma linha.
4. Variáveis de ambiente: `Get-ChildItem Env:WEBVIEW2*` vazio.
5. Idiomas de entrada e layouts iguais aos de antes (`Get-WinUserLanguageList`, antes e depois); NVDA fechado.
6. `icacls` da pasta de temas desfeito (ou o vault apagado).
7. Caps Lock e Num Lock como no início.
8. `%TEMP%\smd-win-nvda` e `%TEMP%\smd-win-edge` apagados.
9. Nenhum `msedgewebview2.exe` vivo com `--proxy-server` na linha de comando.
10. OneDrive: o usuário apaga a pasta de teste também na nuvem (voltar ao snapshot não apaga nada na nuvem) e sai da conta de teste; registre.
11. Evidência: gere o `SHA256SUMS` (seção 6), copie a pasta de evidência para o Mac pela pasta de transferência e confira lá com `shasum -a 256 -c SHA256SUMS` (todas as linhas `OK`). Só então siga; depois esvazie a pasta de transferência.
12. Apague `%TEMP%\smd-win-*`.
13. Preferido: volte ao snapshot da VM (ou ao ponto de restauração) e registre que voltou. Sem snapshot, retome também o Windows Update.

## 8. Revisão do protocolo (AC-B19.2)

As duas revisões abaixo foram feitas antes de qualquer sessão, na mesa (não havia Windows disponível). As edições que elas pediram já estão neste arquivo.

### Revisão da QA (EvidenceCollector), 2026-10-08

Revisor: EvidenceCollectorR7 (run r3, ciclo de correção 1), dono da QA de GUI das sessões do macOS. Base: este arquivo em `cc8a247`, o `scope.md` do r3 (B-03, B-04, B-06, AC-B14.9, B-19) e as regras de GUI do macOS (`QA-CONTEXT.md` do r2 e do r3).

- **Cobertura:** todo AC de B-03 (AC-B03.1–6), B-04 (AC-B04.1–3), AC-B14.9 e a sonda do B-06 têm roteiro, e AC-B19.1 (a)–(f) estão presentes.
- **Edições obrigatórias aplicadas nesta revisão** (WR-01…WR-14, detalhe em RUN r3 `qa/cc1/windows-protocol-review.md`):
  - sessão interativa (sem SSH/WinRM direto);
  - captura com `PW_RENDERFULLCONTENT` e as exceções de janela;
  - ordem explícita da sessão;
  - só teclas reais (nunca `KEYEVENTF_UNICODE`), com Caps Lock e Num Lock registrados;
  - ferramentas prontas antes do snapshot;
  - a regra da chave falsa condicionada ao `cmdkey` vazio, e a chave do usuário só no fim;
  - rótulos literais do diálogo e o scan de texto plano;
  - NFR-32 medido até o painel visível;
  - PDF escuro também claro, e o dono do diálogo de impressão;
  - prova da linha de comando do WebView2, o `listener.py` com hex e UTC, e as condições do proxy morto;
  - controle positivo no Edge sem teclas;
  - persistência do critério 5;
  - bytes e mapa das teclas mortas;
  - arquivos só online determinísticos com ida e volta pela nuvem;
  - modo de foco do NVDA, a receita do QR-05, a leitura da fala por UIA e a checagem de aba por UIA.
- **Resultado:** APROVADO para a sessão, com essas edições. A sessão continua BLOQUEADA até o usuário fornecer o Windows 11 (AC-B19.3).

### Revisão do DevOps (DevOps Automator), 2026-10-08

Revisor: DevOpsR3 (run r3, ciclo de correção 1). Base: este arquivo em `cc8a247`, a revisão da QA acima, `.github/workflows/ci.yml` (job `desktop-build`, passo de proveniência), `.github/workflows/release.yml` (`bundle-dry-run`) e um ensaio da cadeia de download no Mac com o run 37746715856 (`cc8a247`). Detalhe em RUN r3 `impl-b19-review.md`.

- **Ensaio observado** (2026-10-08, no Mac, sem VM): o `digest` do artefato `desktop-windows` na API é igual ao sha256 do zip baixado (`d6103464…6f508`); `sha256sum -c SHA256SUMS` dá 3 × `OK`; o `simplemd.exe` é PE32+ x86-64 (GUI); o `dist-digest.txt` do Windows difere do do macOS só pelo marcador `*` do Git Bash, e os 178 arquivos são iguais.
- **Edições do DevOps aplicadas:**
  - DO-01 arquitetura: x64 preferido; num Windows ARM64 (VM no Apple Silicon) o binário x64 roda emulado, os tempos levam a ressalva e não se faz build local;
  - DO-02 cadeia do artefato: o run `push` verde mais recente da `main` (30 dias, sem `workflow_dispatch` no CI), o `digest` do zip pela API, uma pasta de transferência e nenhum token na VM;
  - DO-03 front-end comparado pelo `dist-files.sha256` normalizado, não pelo `dist-digest.txt` (corrige a frase do WR-17);
  - DO-04 `Unblock-File` só do binário conferido, em vez de o agente clicar no SmartScreen;
  - DO-05 WebView2 Evergreen conferido, versão no início e no fim, Windows Update pausado antes do snapshot;
  - DO-06 pré-requisitos e passos do build local iguais aos do job `desktop-build`;
  - DO-07 o `bundle-dry-run-windows` continua fora: só `workflow_dispatch`, 7 dias, sem `SHA256SUMS`;
  - DO-08 rede: sem VPN nem proxy do sistema, portas 9, 47901 e 47902 livres, porta 9 morta (sem "Serviços TCP/IP simples"), aviso do firewall tratado pela regra 6;
  - DO-09 limpeza: a evidência fica fora de `%TEMP%\smd-win-*`, sai da VM e é conferida no Mac antes da volta ao snapshot;
  - DO-10 a pasta de teste do OneDrive é apagada também na nuvem;
  - DO-11 o modelo do Ollama é baixado antes do snapshot e registrado.
- **Recomendadas da QA (WR-15…WR-22):** todas aplicadas. O WR-17 entrou com a correção do DO-03. Os itens do WR-18 entraram na seção 7 como passos 6–9, antes da exportação da evidência e da volta ao snapshot.
- **Resultado:** APROVADO para a sessão, com essas edições. A sessão continua BLOQUEADA até o usuário fornecer o Windows 11 (AC-B19.3).
