# Protocolo de QA no Windows 11 (B-19)

Roteiro da sessão interativa no Windows que fecha B-03 (QA interativa) e B-04 (impressão para PDF no WebView2), mais as partes do Windows de B-06 (WebRTC) e B-14 (IME, teclas mortas, NVDA), e do reteste das correções do r4 (W-01 WebRTC, W-02/W-04 PDF, W-03 tecla alternativa das sugestões). Ele espelha as regras de segurança da GUI usadas no macOS e define o formato da evidência.

- **Status (P-03):** duas sessões já rodaram, as duas em 2026-10-08 no PC do usuário (`desktoprafael`), com **Windows 10 IoT Enterprise LTSC 21H2 (19044, x64), não Windows 11** (desvio D1): a do r3 (`569ef72`) e o reteste do r4 (`d4fe923`). Resultados e desvios na seção 9. Só os itens com PASS e evidência deixaram de ser "NÃO TESTADO" nos registros (seção 6). Uma sessão nova segue este roteiro na máquina que o usuário fornecer.
- **Quem roda:** só o agente autorizado a dirigir a GUI do Windows, nessa máquina e com estas regras.
- **Critérios de aceite:** os IDs AC-Bxx.y vêm do escopo do run r3 (`.nexus/runs/r3-backlog-b01-b19/scope.md`, B-03, B-04, B-06, B-14, B-19); os AC-Wxx.y, do escopo do run r4 (`.nexus/runs/r4-windows-fixes/scope.md`, W-01…W-05). Os critérios 1–7 são os do `PLANO.md` §5.
- **Evidência:** fica fora do repositório, na pasta do run que executar a sessão (por exemplo `.nexus/runs/<run>/qa/win-<AAAA-MM-DD>/`). Ver a seção 6.

## 1. Ambiente (AC-B19.1 a)

- **Sistema:** Windows 11 23H2 ou mais novo. O CI só gera o binário x64 (`desktop-windows`; o `simplemd.exe` é PE32+ x86-64). Registre a versão e o build (`[Environment]::OSVersion`, `winver`), a arquitetura (`$env:PROCESSOR_ARCHITECTURE`) e se é VM (qual hipervisor) ou PC. Prefira x64. Uma VM num Mac com Apple Silicon roda o Windows 11 **ARM64**: lá o `simplemd.exe` x64 roda emulado [inferência: emulação x64 do Windows on ARM; confirme na sessão que o app abre], e os tempos (critério 6, NFR-32) valem só para "x64 emulado em ARM64"; registre isso em cada linha de tempo do `report.md`. Nesse caso use o artefato do CI, não um build local (ele sairia ARM64 e não seria o binário do CI).
- **Snapshot:** tire um snapshot da VM ou um ponto de restauração **antes** da sessão. A limpeza preferida é voltar a ele (seção 7). Num PC sem VM, o `Checkpoint-Computer` recusa um segundo ponto de restauração em menos de 24 h (frequência padrão de 1.440 min): registre a recusa e use o último ponto como referência; não mude `SystemRestorePointCreationFrequency` (r4, D13).
- **Conta:** uma conta local de teste, isolada, sem conta Microsoft pessoal. As ferramentas são instaladas antes do snapshot, por uma conta de administrador separada; a sessão roda na conta de teste como usuário padrão. Nenhum token do GitHub, chave SSH ou credencial do Mac entra na VM: os artefatos chegam por uma pasta de transferência (seção 3).
- **Sem chaves reais.** Nenhuma chave de API real entra na máquina. O critério 7 com OpenAI ou Anthropic fica **BLOQUEADO**, a não ser que o próprio usuário digite a chave dele; o agente nunca digita uma chave real.
- **Sem contas pessoais na nuvem.** Para o AC-B03.5 use uma conta de teste do OneDrive separada, só com notas de teste.
- **WebView2 Evergreen:** o Windows 11 já traz o runtime; se faltar, instale o Evergreen Standalone da arquitetura da máquina antes do snapshot. Registre a versão no início **e no fim** da sessão (o Edge Update pode atualizar o runtime no meio; uma troca vira nota no `report.md`). Por exemplo: `(Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}').pv`. Se a chave HKLM não existir, use `HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` ou `Get-Process msedgewebview2 -FileVersionInfo | Select-Object -First 1 FileVersion` com o app aberto.
- **Atualizações:** antes do snapshot, pause o Windows Update (Configurações → Windows Update → Pausar atualizações), para nenhuma reinicialização cair no meio da sessão. Registre até quando ficou pausado.
- **Argumentos do WebView2 por fora do app (P-01):** a variável de ambiente `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` e a política de registro `AdditionalBrowserArguments` do WebView2 mexem nos argumentos do app. A documentação ([Microsoft](https://learn.microsoft.com/microsoft-edge/webview2/reference/win32/webview2-idl); [WebView2Feedback #5571](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5571)) diz que elas sobrepõem; **o observado no WebView2 154.0.4258.62 / Windows 10 LTSC foi que a variável se soma** aos argumentos do app, que continuam na linha de comando (RUN r3 `qa/windows/webview2-cmdline-5.6-controle.txt`), e o último argumento repetido vale. Por isso ela não serve para tirar a flag do app (o controle "sem a flag" é o binário A/B do 5.6), e um `--webrtc-ip-handling-policy=default` ou outro `--proxy-server` vindo de fora reabriria os canais (resíduo R-2). Antes da sessão, registre que as duas estão ausentes: `Get-ChildItem Env:WEBVIEW2*` vazio, e `reg query HKLM\SOFTWARE\Policies\Microsoft\Edge\WebView2 /s` e `reg query HKCU\SOFTWARE\Policies\Microsoft\Edge\WebView2 /s` sem a subchave `AdditionalBrowserArguments` (a política fica numa subchave, com um valor por executável; sem `/s` ela não aparece). Registre a saída inteira: outras políticas dessa chave, como `BrowserExecutableFolder` e `ReleaseChannelPreference`, também mudam o runtime usado. [Inferência: organização da política conforme a documentação de políticas do WebView2; confirme na VM.] Nenhum passo deste roteiro define a variável.
- **Ferramentas** (instaladas antes do snapshot):
  - PowerShell e Git for Windows (o Git Bash traz `sha256sum`);
  - Python 3, para o `listener.py` da sonda de rede;
  - Ollama com um modelo pequeno já baixado (`ollama pull` antes do snapshot; registre `ollama list`, com nome e id do modelo), para o critério 7 local;
  - o NVDA como cópia portátil em `%TEMP%\smd-win-nvda` (a configuração de um NVDA instalado não muda), com o Visualizador de Fala (Speech Viewer);
  - Node 22.22.3 e pnpm 12.8.1, só para gerar o vault de 2.000 notas (`node scripts/gen-vault.mjs <pasta>`) ou para um build local. Para o build local também o Rust pelo `rustup` (ele lê `rust-toolchain.toml`: 1.98.1) e o Visual Studio Build Tools com a carga "Desenvolvimento para desktop com C++" e o SDK do Windows;
  - o leitor de PDF padrão e a impressora "Microsoft Print to PDF"; sem spooler (a máquina das sessões do r3/r4 tem o spooler desativado, D7), use o destino "Salvar como PDF" do painel do WebView2 (5.7). No Mac, `pdffonts` e `pdftotext` (poppler) para conferir os PDFs;
  - um cliente de UI Automation e os ajudantes de guarda, entrada e captura, prontos e com sha256 registrado antes do snapshot (por exemplo Python 3 + `pywinauto`/`comtypes` para a UIA e um script PowerShell/C# com `GetForegroundWindow`, `SendInput` por código de tecla e `PrintWindow`). Teste-os uma vez no Bloco de Notas **antes** da sessão; esse teste não entra na evidência;
  - o IME japonês da Microsoft e os layouts US-Internacional e Português (Brasil ABNT2) instalados antes do snapshot. Registre `Get-WinUserLanguageList` no momento do snapshot: essa lista é o "antes" da seção 7.
- **Rede** (para a sonda e o proxy morto do app): sem VPN e sem proxy do sistema. Registre `netsh winhttp show proxy` e `Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' | Select-Object ProxyEnable,ProxyServer,AutoConfigURL,AutoDetect`; esperado: sem proxy e sem PAC. As portas de loopback ficam livres: `Get-NetTCPConnection -LocalPort 9,47901 -State Listen -ErrorAction SilentlyContinue` e `Get-NetUDPEndpoint -LocalPort 47902 -ErrorAction SilentlyContinue` vazios. A porta 9 tem de estar morta: desde o r4 o app usa `--proxy-server=http://127.0.0.1:9` como proxy morto, e um programa escutando nela recebe (e pode repassar) os pedidos do webview (resíduo R-4); com os "Serviços TCP/IP simples" do Windows ligados, o serviço discard escuta nela e a sonda não vale. A rede da VM (NAT) só precisa de internet para o OneDrive (5.5) e para a nuvem do critério 7; o resto é loopback. Se o Firewall do Windows pedir permissão para o `python.exe` do `listener.py`, vale a regra 6 da seção 2: não clique e chame o Main (o listener só usa loopback).

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
8. **Sessão interativa.** Tudo o que manda tecla, usa UI Automation ou captura a janela roda **dentro da sessão interativa da conta de teste** (console da VM, ou RDP aberto e **não minimizado**). Não rode esses passos direto por SSH, WinRM ou serviço: eles ficam fora da área de trabalho interativa, a entrada sintética não chega ao app e a captura sai preta. Se o agente entra por SSH, ele dispara os scripts na sessão interativa (uma tarefa agendada criada com `Register-ScheduledTask`, principal da conta de teste com `-LogonType Interactive -RunLevel Limited`, como o `gui-runner\gui-task.ps1` do kit; o `schtasks /Create … /IT` disparado pela sessão SSH travou numa sessão anterior) e lê a saída em arquivo. Antes de cada tarefa, confira que a sessão interativa não está bloqueada (nenhum `LogonUI.exe` com a mesma `SessionId`); bloqueada, pare e peça ao usuário. Registre em `env.txt` como o agente chegou à sessão.
9. **Sem elevação.** O app e os scripts rodam sem elevação, no mesmo nível de integridade: a `SendInput` não alcança janelas elevadas (UIPI), e nenhum passo precisa de administrador.
10. **Controles dos diálogos do Windows (P-06; INC-01, INC-02 do r3).** Nos diálogos comuns (seletor de pasta, "Salvar como"), ache os controles por `GetDlgItem` no HWND do diálogo, nunca pela busca de UI Automation `AutomationId=1`, que no r3 casou com um item de lista e entrou numa subpasta de Documentos. No seletor de pasta use só dois controles: o campo "Pasta" (`Edit` de id 1152, `WM_SETTEXT` com o caminho) e o botão "Selecionar pasta" (id 1, `BM_CLICK`). Preencha o nome do arquivo com `WM_CHAR` no HWND do campo e confira por `WM_GETTEXT` antes de salvar: no r3 o `WM_SETTEXT` foi ignorado e o PDF foi parar em `Downloads`. Se algo cair fora das pastas de teste, não abra nem leia: mova para a pasta de teste, registre e conte só por nome filtrado (por exemplo `Downloads\simpleMD*.pdf`).
11. **Varreduras só nas pastas da sessão.** Buscas recursivas no Windows (valor de teste, material de chave) ficam em `%TEMP%\smd-win-*`, `%USERPROFILE%\smd-evidencia-*` e nas pastas de dados do app, com teto de tempo; nunca em todo o `%TEMP%` nem no perfil do usuário (INC-SEC-R4-1).

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
- **Critério 5 (autocompletar; AC-8.7/8.8; P-07):** Configurações → "Autocompletar" desligado → feche e reabra a pasta → `[[` não abre popup → ligue → popup. `Ctrl+Shift+Espaço` abre as sugestões, no modo "Ao digitar" e no "Só pelo atalho" (W-03). Registre também o `Ctrl+Espaço`: se ele não abrir, é observação (F-WIN-03), não falha, desde que o `Ctrl+Shift+Espaço` abra. Confira que o layout ativo da janela do app (ABNT/ABNT2) é o mesmo antes e depois do `Ctrl+Shift+Espaço`, que, com o autocompletar desligado, o `Ctrl+Shift+Espaço` não abre nada nem insere espaço (bytes da linha no disco), e que a dica em Configurações → "Autocompletar" diz "Para sugerir na hora: Ctrl+Espaço ou Ctrl+Shift+Espaço.". Enter sem opção ativada pelas setas quebra a linha (R4-02). Persistência: com o autocompletar desligado, feche o app (`Get-Process simplemd` vazio), abra de novo e confira que o interruptor continua "Desligado" e que `.simplemd\config.json` do vault tem `"autocomplete"` com `"enabled": false` (bytes no disco, `Get-Content -Raw`). Religue no fim e registre de novo. A leitura da dica pelo NVDA fica no 5.9.
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
4. Edite e salve: confira os bytes no disco e espere sincronizar (sem erro de sincronização no OneDrive). **Feche a aba da nota no app** (P-08: no r3, com a aba aberta, o `attrib +U -P` não liberou a nota em 150 s), libere o espaço de novo (`attrib +U -P`), confira o `U` no `attrib`, reabra a nota no app e confira que o texto editado volta da nuvem.
5. Registre os atributos depois de abrir e depois de salvar. Qualquer recusa é registrada com o código de erro literal.

### 5.6 AC-B03.6 / AC-W01.2–6 — sonda WebRTC e `preconnect` (B-06, W-01; P-04)

Desde o r4 (W-01, PR #16) o app de release passa ao WebView2 `--webrtc-ip-handling-policy=disable_non_proxied_udp` e o proxy morto `--proxy-server=http://127.0.0.1:9 --proxy-bypass-list=<-loopback>`. A sonda mede o app, e um **controle A/B** na mesma sessão prova que ela mede.

1. Confira a rede (seção 1, **Rede**: portas 9, 47901 e 47902 livres) e rode **um só** `python listener.py 47901 47902 <log> <segundos>` no próprio Windows para todo o bloco, cobrindo o app e o controle. O `listener.py` do kit sai com erro se a porta já estiver em uso (KIT-04); confira que ele está vivo antes de cada vetor.
2. **Harness do motor** (kit, `engine-w01`), antes do app: K0 sem argumentos tem de mostrar tráfego em todos os vetores; K-final, com os argumentos exatos do app, tem de dar 0 em todos e terminar com `VERDICT PASS`. Registre a versão do WebView2. Uma versão nova que falhe no K-final reabre o W-01 como P0 (resíduo R-1).
3. **App em teste:** feche qualquer `msedgewebview2.exe` do app (nenhum vivo: o WebView2 reaproveita o processo do navegador e os argumentos novos não valeriam), abra o app, ative a cópia da sonda num vault de teste e rode, um por vez: STUN no realm principal (5 vezes), STUN num `iframe` `about:blank` (5 vezes), STUN num `iframe` `srcdoc` (3 vezes), TURN por TCP no realm principal e num `iframe` (3 vezes cada) e `<link rel=preconnect href=http://127.0.0.1:47901>` (3 vezes).
4. **Esperado (AC-W01.2/4/5):** 0 datagramas UDP no STUN em todos os realms e 0 conexões TCP de TURN e de `preconnect`. O resultado de cada vetor mostra `ctor: function` (o `RTCPeerConnection` existe; a trava é no motor, não em JavaScript).
5. **Controle A/B (AC-W01.3; substitui o controle positivo no Edge quando a máquina não tem Edge, D8):** feche o app e confira que nenhum `msedgewebview2.exe` dele sobrou; abra o binário de controle, que não tem esses argumentos (no r4: o `desktop-windows` de `569ef72`, zip `3000ad3e…a800ea`, artefato que expira 30 dias depois de 2026-10-08; depois disso, um build local dessa revisão ou de outra anterior ao W-01), e rode os mesmos vetores no mesmo listener. Esperado: tráfego (no r4, 6 `STUN-binding-request` por rodada, um `TURN-allocate` e o TCP do `preconnect`). Sem tráfego no controle, a sonda não vale (NOT TESTED). Se o Edge existir, o controle positivo por uma página local no Edge com perfil temporário (`--user-data-dir=$env:TEMP\smd-win-edge`) também vale. A variável `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` **não** serve de controle: ela se soma aos argumentos do app (P-01).
6. **Linha de comando (AC-W01.6):** com cada binário aberto, registre a linha de comando do processo do navegador do WebView2 (o `msedgewebview2.exe` sem `--type=`, filho do `simplemd.exe`): `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId,ParentProcessId,CommandLine | Format-List > webview2-cmdline-<binário>.txt`. Esperado no app: `--webrtc-ip-handling-policy=disable_non_proxied_udp`, `--proxy-server=http://127.0.0.1:9`, `--proxy-bypass-list=<-loopback>` e `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`, e nenhuma `--force-webrtc-ip-handling-policy`, `--no-proxy-server` nem `direct://`.

### 5.7 AC-B04.1–3 / AC-W02 / AC-W04 — impressão para PDF no WebView2 (P-05)

1. **Destino:** "Microsoft Print to PDF" se existir; sem spooler (D7), o destino "Salvar como PDF" do painel do WebView2 → "Mais configurações" → "Salvar" → diálogo "Salvar como". O dono desse diálogo é um `msedgewebview2.exe --type=utility` filho do navegador do WebView2 do app: permita-o na guarda e registre o nome do processo. Preencha o nome do arquivo e acione "Salvar" como na seção 2, item 10 (`GetDlgItem`, `WM_CHAR` com leitura de volta), nunca por `WM_SETTEXT` (INC-02). Feche o balão de downloads e a aba (`Ctrl+W`) antes de fechar o app.
2. **Matriz de tempos (W-02):** cada célula usa um **app recém-aberto** (registre que nenhum `msedgewebview2.exe` do app estava vivo antes) e mede a primeira impressão do processo. t_open = Enter no item `export-fixture.md` do explorador; `Ctrl+P` em t_open + Δ, com Δ = 0, 500, 1.000, 2.600 e 10.000 ms, nos temas claro e escuro, mais uma célula com perfil frio (pasta `EBWebView` do app apagada antes, só se a sessão a criou). No r4 foram 14 PDFs (M-1a…M-10). No Δ = 0, se a nota ainda não estiver aberta (aviso "Abra uma nota para exportar." sem painel), registre e repita a célula com o `Ctrl+P` na primeira sondagem da UI Automation (≤ 50 ms) que vê o título da nota no editor; essa tentativa tem de gerar o PDF (no r4 o aviso não apareceu: o painel abriu nas 14 células).
3. **AC-B04.1 / AC-W02.2–4:** em cada PDF há o diagrama Mermaid, a fórmula KaTeX, a tabela, o `5` do calc e os marcadores e números das listas; a página é A4 (594,96 × 841,92 pt), com 2 páginas; o PDF do tema escuro também sai claro (sem faixas escuras nem fio na borda; S6-1, S6-2). No Mac: `pdffonts` mostra `KaTeX_Math-Italic`, `KaTeX_Main-Regular` e `KaTeX_Size1-Regular` embutidas (no r3 o PDF que falhou não tinha nenhuma); `pdftotext` comparado com o `export.pdf` do CI: nenhum token do KaTeX falta.
4. **AC-B04.2 / AC-W04.1–2:** baixe o artefato `export-pdf-windows` do CI da **mesma revisão** (`export.pdf` + `export.pdf.sha256`) e compare: só podem faltar os 2 tokens `,` e `n` da quebra de linha, e o único token a mais aceito é `n,`, a junção desses dois (DEV-W04-1; o conjunto de caracteres sem espaços tem de ser igual ao do CI). `pdftotext -layout`: 0 `tauri.localhost`, 0 data `dd/mm/aaaa, hh:mm` e 0 linha de contador `n/N` (sem cabeçalho nem rodapé do Chromium, W-04). Margens de tinta da página 1 ≥ 15 mm, e o painel com "Margens: Padrão"; a primeira palavra fica em x ≈ 56,7 pt (no CI, 69,0 pt, das margens do `printToPDF` do Edge). O PDF do CI prova só o motor (Edge); este prova a impressão dentro do app.
5. **AC-B04.3 / AC-W02.6 (NFR-32):** em cada célula, t0 = horário (ms desde a época, UTC) em que o `Ctrl+P` é enviado. A marca `simplemd:export-print` no `out.txt` registra o **pedido** do painel (desde o r4 ela sai depois da espera das fontes) e prova que o comando do app foi usado. t1 = primeira vez que a UI Automation encontra o painel de impressão ("Imprimir"), sondando a cada 50 ms. Esperado: t1 − t0 ≤ 4.000 ms em cada uma; registre também marca − t0. Uma tentativa sem a marca significa que o `Ctrl+P` caiu na impressão padrão do WebView2 e não no comando do app: ela não vale e vira achado.

### 5.8 Proxy morto nativo: o app funciona com ele (AC-W01.9; P-04)

O experimento do r3 (D-1, a variável `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` com o proxy morto) passou no passo 1 (o app funciona com o proxy) e mostrou que só o proxy não fecha o STUN/UDP. Desde o r4 o proxy morto e a política de WebRTC são argumentos nativos do app (Q1 do r4), e a variável não é mais usada (P-01). O 5.8 agora confere que o app de release funciona com eles:

1. Com o binário em teste (linha de comando do 5.6, passo 6), confira: a janela não fica em branco e `simplemd:ready` aparece; abrir a pasta, ler, editar e salvar uma nota (bytes no disco); exportar HTML (o arquivo tem o texto editado); abrir o painel de impressão (marca `simplemd:export-print`); ativar o `hello-world` e rodar "Dizer olá"; Mermaid, KaTeX e calc renderizados no editor; uma resposta do Ollama, se houver Ollama na máquina (ela prova só o IPC: o pedido de IA sai do Rust, `ai/transport.rs`, não do WebView2, e não passa pelo proxy).
2. Compare o `simplemd:ready` a frio do app com o do binário de controle na mesma sessão (5 aberturas de cada; no r4, mediana 431 ms contra 440 ms).
3. Se o passo 1 falhar, o W-01 volta a FAIL (P0) e a AppSec decide.
4. Feche o app no fim e confirme que nenhum `msedgewebview2.exe` do app continua vivo antes de qualquer outra abertura.

### 5.9 AC-B14.9 — IME, teclas mortas e NVDA no WebView2

- **IME japonês da Microsoft (Romaji)** com o autocompletar ligado: componha `にほんご`, converta com Espaço e confirme com Enter. Esperado: só o texto confirmado entra, o Enter da composição confirma o candidato e nunca aceita uma sugestão, e os bytes gravados são o UTF-8 esperado. Registre também se o Enter **seguinte** a um commit convertido com Espaço quebra a linha (no WKWebView não quebra: IME-ENTER-1) e se o popup abre sob a janela de candidatos (IME-POP-1). Registre se o IME japonês está na versão atual ou na anterior ("Usar a versão anterior do IME da Microsoft") e se a conversão ao vivo está ligada.
- **Teclas mortas** (autocompletar ligado, numa nota de teste, numa linha nova): o texto alvo é o mesmo do macOS, `parabéns café não você ç é ã ê` + Enter. No **US-Internacional**: `'`+`e` → é, `~` (Shift+`` ` ``) + `a` → ã, `^` (Shift+6) + `e` → ê, `'`+`c` → ç. No **ABNT2**: ´ (tecla à direita do P) + `e`, `~` (tecla à direita do Ç) + `a`, Shift+`~` (^) + `e`, e o `ç` tem tecla própria. Bytes esperados da linha no disco (`Format-Hex`): `70 61 72 61 62 c3 a9 6e 73 20 63 61 66 c3 a9 20 6e c3 a3 6f 20 76 6f 63 c3 aa 20 c3 a7 20 c3 a9 20 c3 a3 20 c3 aa 0a` (ou `0d 0a` no fim, se a nota for CRLF). ´ ˜ ˆ ¨ `'` `~` `^` soltos no arquivo: 0. Capture a janela depois de `parab`, com o ´ pendente e depois do `é`, e registre se o popup fecha com a tecla morta pendente e volta depois da letra composta (referência no macOS: RUN r3 `qa/cc1/report.md` §3). Nenhuma sugestão aceita. Para trocar o layout (ou ligar o IME japonês), mande `WM_INPUTLANGCHANGEREQUEST` (0x0050) para a janela com foco do WebView2 (`Chrome_WidgetWin_1`, achada por `GetGUIThreadInfo`), não para a janela do topo do app, e confira o HKL da thread do foco antes de digitar (no r3 a primeira tentativa do IME foi inválida por isso).
- **NVDA** (com o Visualizador de Fala ligado, que é a evidência em texto):
  - digitar uma palavra que abre o popup → "N sugestões, ↓ para escolher" falado uma vez por abertura, e as setas não o repetem (A11Y-R5-01; registre se ele se repete a cada pausa com a mesma contagem, A11Y-R3-01);
  - a dica de Configurações → "Autocompletar" (AC-W03.4): pela leitura contínua do NVDA (NVDA+↓) a partir da caixa "Notas ([[)", esperado um só enunciado "Para sugerir na hora: Ctrl+Espaço ou Ctrl+Shift+Espaço.". No r4 o NVDA+Espaço não trocou de modo nessa tela e a navegação por objetos lê a dica em quatro pedaços (OBS-A11Y-R4-1); com o NVDA no modo de foco, o `Esc` do roteiro pode ser consumido pelo NVDA: confira por UI Automation que o popup fechou antes de seguir (NOTE-HARNESS-1);
  - com o foco no editor, só a aba ativa é anunciada como selecionada (EC3-A11Y-1);
  - a falha ao salvar no editor de temas é lida uma vez (QR-05);
  - como o NVDA lê o atalho das abas (`aria-keyshortcuts`; no macOS o VoiceOver diz "Meta+W", VO-KS-1).
  - Antes de digitar com o NVDA ligado, confirme no Visualizador de Fala que ele está no **modo de foco** no editor. No modo de navegação as letras viram navegação rápida e o texto não chega ao editor: é falha do método, não do produto, e a tentativa é refeita.
  - O texto falado é lido por UI Automation na janela do Visualizador de Fala (`ValuePattern`/`TextPattern`) ou no log do NVDA com o nível "entrada/saída", que grava as falas [inferência: confirme no primeiro teste]. Nunca mande teclas para o Visualizador.
  - EC3-A11Y-1 também pela UI Automation, como o `AXSelected` no macOS: com o foco no editor, leia `SelectionItemPattern.Current.IsSelected` de cada aba; esperado `True` só na aba ativa.
  - QR-05 (P-02): para a falha ao salvar o tema, negue escrever arquivos **e** criar subpastas na pasta de temas do vault de teste: `icacls "$env:TEMP\smd-win-basico\.simplemd\themes" /deny "$($env:USERNAME):(WD,AD)"`. Só `(WD)` não basta: o app grava em `themes\<id>\theme.json` e cria a subpasta `<id>` (no r3, com `(WD)` o tema foi salvo). Confirme que o app mostra "Não foi possível salvar o tema. Nenhum tema foi ativado." antes de avaliar a fala, e desfaça na limpeza com `icacls "…\themes" /remove:d $env:USERNAME` (seção 7, item 6).
  - Registre a versão do NVDA e o sha256 do `nvda.ini` da cópia portátil antes e depois.
- Registre os idiomas de entrada antes e depois (`Get-WinUserLanguageList`) e exporte antes `HKCU\Keyboard Layout`, `HKCU\Software\Microsoft\CTF\SortOrder`, `HKCU\Control Panel\International\User Profile` e `HKCU\Software\Microsoft\IME\15.0`. O `Set-WinUserLanguageList` volta a lista, mas deixa o valor `CachedLanguageName` em `User Profile\pt-BR` e a chave `IME\15.0\IMEJP` (r3 e r4): apague os dois e confira que os `.reg` de depois são iguais aos de antes.

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
6. `icacls` da pasta de temas desfeito: `icacls "$env:TEMP\smd-win-basico\.simplemd\themes" /remove:d $env:USERNAME` tira a negação `(WD,AD)` do 5.9 (ou o vault apagado).
7. Caps Lock e Num Lock como no início.
8. `%TEMP%\smd-win-nvda` e `%TEMP%\smd-win-edge` apagados.
9. Nenhum `msedgewebview2.exe` do app vivo (o app de release passa `--proxy-server` ao WebView2; o processo do usuário em outros apps não é tocado).
10. OneDrive: o usuário apaga a pasta de teste também na nuvem (voltar ao snapshot não apaga nada na nuvem) e sai da conta de teste; registre.
11. Evidência: gere o `SHA256SUMS` (seção 6), copie a pasta de evidência para o Mac pela pasta de transferência e confira lá com `shasum -a 256 -c SHA256SUMS` (todas as linhas `OK`). Só então siga; depois esvazie a pasta de transferência.
12. Apague `%TEMP%\smd-win-*`. Apague `%APPDATA%` e `%LOCALAPPDATA%\io.github.devrafaelbrauner.simplemd` **só se o preflight registrou que não existiam** antes da sessão (`appdata-before.json`); se já existiam, mantenha e registre. Confira no log da limpeza a contagem e os caminhos das pastas que já existiam e o resultado de cada uma (`PENDENTE` = mantida, `OK` = apagada por ter sido criada na sessão). No reteste do r4 a leitura desse arquivo no PowerShell 5.1 estava errada e apagaria uma pasta que já existia (KIT-07); o kit foi corrigido depois (`Read-JsonArray`/`Remove-SessionAppData`, com ensaio no PC usando pastas de teste), mas o `99-cleanup -Phase Final` inteiro ainda não rodou numa sessão real: na próxima sessão, confira esse log antes de dar a limpeza por boa.
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

### Revisão r4 (edições depois das sessões), 2026-10-08

Autor: WS-DOCS do run r4, a partir dos relatórios das duas sessões no Windows (EvidenceCollectorWin no r3, EvidenceCollectorWinR4 no r4; RUN r3 `qa/windows/report.md`, RUN r4 `qa/windows-r4/report.md`) e das decisões do Main no `scope.md` do r4 (Q6). Conferência pelo dono da QA no Windows (EvidenceCollectorWinR4, 2026-10-08): APROVADO. P-01…P-08 e o critério 5 conferidos contra os relatórios das sessões do r3 e do r4, com as edições E1–E7 (snapshot em 24 h, `Register-ScheduledTask`, ids do seletor, critério 5 desligado, alvo da troca de layout, NVDA e restos de idioma, regra do Δ = 0); RUN r4 `qa/windows-r4/protocol-signoff.md`. Edições:

- **P-01** (§1, §5.6, §5.8): `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` se soma aos argumentos do app no WebView2 154.0.4258.62 / Windows 10 LTSC (`webview2-cmdline-5.6-controle.txt` do r3), então não serve de controle; o controle é o binário A/B.
- **P-02** (§5.9, §7 item 6): receita do QR-05 com `(WD,AD)`, com o motivo, e o desfazer correspondente.
- **P-03** (cabeçalho): status com as duas sessões, o desvio D1 (Windows 10 LTSC) e a seção 9.
- **P-04** (§5.6, §5.8): vetores do W-01 (STUN em 3 realms, TURN por TCP em 2, `preconnect`), harness do motor, controle A/B, linha de comando esperada com os argumentos do r4; o 5.8 virou a conferência do app com o proxy morto nativo (AC-W01.9).
- **P-05** (§1 ferramentas, §5.7): destino "Salvar como PDF" sem spooler (D7), matriz de tempos do W-02 com app recém-aberto, `pdffonts`/`pdftotext` contra o PDF do CI, ausência de cabeçalho/rodapé (W-04) e a regra do token `n,` (DEV-W04-1).
- **P-06** (§2 itens 10 e 11, §5.7): `GetDlgItem` nos diálogos, `WM_CHAR` com leitura de volta (INC-01, INC-02) e varreduras só nas pastas da sessão (INC-SEC-R4-1).
- **P-07** (§5.1, critério 5): `Ctrl+Shift+Espaço` (W-03), `Ctrl+Espaço` engolido como observação do ambiente (F-WIN-03), layout igual antes e depois, texto da dica.
- **P-08** (§5.5 passo 4): fechar a aba da nota antes do `attrib +U -P`.
- §1 Rede: a porta 9 morta agora é exigência do app (R-4). §7 itens 9 e 12: processos do app e pastas de dados do app (KIT-06/KIT-07).

O título ainda diz "Windows 11" porque é o alvo; as duas sessões rodaram no Windows 10 LTSC (D1), e cada linha de resultado leva esse desvio.

## 9. Registro das sessões

### Sessão do r3 — 2026-10-08, 11:26Z–12:46Z

- **Máquina e desvios:** PC do usuário `desktoprafael`, Windows 10 IoT Enterprise LTSC 21H2 (19044.7725) x64 (D1); conta Microsoft do usuário, com o app e os scripts em token _Limited_ (D2); sem snapshot, ponto de restauração nº 19 (D3); Windows Update não pausado (D4); Tailscale ativo (D5); OneDrive pessoal só na pasta `smd-winqa-teste` (D6); spooler desativado, destino "Salvar como PDF" (D7); sem Edge (D8); sem Ollama e sem `pywinauto`, com UI Automation do PowerShell 5.1 (D9); `%TEMP%` = `C:\DevTemp` (D10); acesso por SSH mais uma tarefa agendada na sessão interativa (D11); preflight corrigido à mão (D12, KIT-01).
- **Binário:** `main` `569ef72`, CI 37755966705, artefato `desktop-windows` `3000ad3e…a800ea`, `simplemd.exe` `90540474…068a`. WebView2 154.0.4258.62 no início e no fim.
- **Resultados:** PASS em critério 1, critério 2/plugins (AC-B03.4), critério 6, CR2-02 (AC-B03.2), Credential Manager (AC-B03.3), NFR-32 (AC-B04.3), teclas mortas, IME e NVDA (AC-B14.9) e AC-B19.3 com D1; OneDrive (AC-B03.5) PASS em abrir/ler/listar/salvar, volta pela nuvem NÃO TESTADO; critério 7: Ollama NOT TESTED, nuvem BLOQUEADO. **FAIL:** critério 5 só no `Ctrl+Espaço` (F-WIN-03), sonda WebRTC (F-WIN-01: a flag do r3 sem efeito; STUN mandou UDP em 7/7, TURN por TCP e `preconnect` chegaram) e PDF da primeira impressão sem o KaTeX (F-WIN-02); o 5.8 mostrou que o app funciona com o proxy morto. Achados F-WIN-01…05, P-01, P-02, KIT-01…06, INC-01, INC-02.
- **Evidência:** RUN r3 `qa/windows/report.md`; `SHA256SUMS` com 172 arquivos, 172 OK no Mac.

### Reteste do r4 — 2026-10-08, 15:39Z–16:29Z

- **Máquina e desvios:** a mesma, com D1–D11 iguais; D12 não se aplica mais (o preflight do kit sem alteração terminou, KIT-01); sem ponto de restauração novo (o Windows recusa um segundo em 24 h; o nº 19 continua a referência, D13); NVDA 2026.2 baixado no PC, com o sha256 igual ao do Mac e assinatura válida (D14); o app não reabre o último vault (D15); OneDrive não usado (Q5, D16); NVDA com leitura contínua para a dica (D17).
- **Binário:** `main` `d4fe923`, CI 37800199415, artefato `desktop-windows` `5fbcf4b3…ddde9`, `simplemd.exe` `c114d74e…39df`; controle A/B `569ef72`. WebView2 154.0.4258.62 no início e no fim.
- **Resultados:** **W-01 PASS** (linha de comando com os 4 argumentos e sem `--force-…`; 0 UDP em STUN no principal 5/5, `about:blank` 5/5 e `srcdoc` 3/3; 0 TCP em TURN por TCP 3/3 + 3/3 e em `preconnect` 3/3; o controle mandou 6 datagramas STUN por rodada, `TURN-allocate` e o TCP do `preconnect`; harness do motor `VERDICT PASS`; o app funciona com o proxy, `simplemd:ready` mediana 431 ms contra 440 ms do controle). **W-02/W-04 PASS** (14/14 PDFs completos, com as fontes do KaTeX, A4, 2 páginas, sem cabeçalho/rodapé, painel em 179–288 ms). **W-03 PASS** (`Ctrl+Shift+Espaço` abre as sugestões 3/3 nos dois modos, layout igual, desligado não faz nada, texto da dica exato, NVDA lê o anúncio uma vez e a dica numa fala só pela leitura contínua; `Ctrl+Espaço` continua engolido, fato do ambiente; R7 com o teclado físico NOT TESTED). Fumaça do r3 (critério 1, CR2-02, plugins) PASS. Kit: KIT-01…05 conferidos; KIT-06 apaga as pastas de dados criadas pela sessão, mas a proteção de uma pasta que já existia falhou (KIT-07, AC-W05.10 FAIL nessa cláusula; corrigido no kit depois da sessão, com ensaio no PC; o `99-cleanup -Phase Final` inteiro fica para a próxima sessão). Achados KIT-07, OBS-A11Y-R4-1/2, OBS-W03-R8, NOTE-HARNESS-1 e a decisão DEV-W04-1.
- **Evidência:** RUN r4 `qa/windows-r4/report.md`; `SHA256SUMS` com 195 arquivos, 195 OK no Mac.
- **Limpeza:** comprovada (sem processos do app, `cmdkey` sem `simplemd`, sem `WEBVIEW2*`, idiomas e registro iguais aos de antes). Ficaram de propósito, para o usuário remover: o `sshd` e a regra de firewall `smd-winqa-ssh` (`10-habilitar-ssh.ps1 -Remover`), o ponto de restauração nº 19 e o par de chaves `~/.ssh/smd-winqa*` no Mac (S-R4-01).
