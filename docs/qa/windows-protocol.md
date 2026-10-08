# Protocolo de QA no Windows 11 (B-19)

Roteiro da sessão interativa no Windows que fecha B-03 (QA interativa) e B-04 (impressão para PDF no WebView2), mais as partes do Windows de B-06 (WebRTC) e B-14 (IME, teclas mortas, NVDA). Ele espelha as regras de segurança da GUI usadas no macOS e define o formato da evidência.

- **Status:** BLOQUEADO até o usuário fornecer uma VM ou um PC com Windows 11 (AC-B19.3). Até a sessão rodar, os registros continuam com "Windows interativo: NÃO TESTADO" e "critério 4 no WebView2: NÃO TESTADO".
- **Quem roda:** só o agente autorizado a dirigir a GUI do Windows, nessa máquina e com estas regras.
- **Critérios de aceite:** os IDs AC-Bxx.y vêm do escopo do run r3 (`.nexus/runs/r3-backlog-b01-b19/scope.md`, B-03, B-04, B-06, B-14, B-19). Os critérios 1–7 são os do `PLANO.md` §5.
- **Evidência:** fica fora do repositório, na pasta do run que executar a sessão (por exemplo `.nexus/runs/<run>/qa/win-<AAAA-MM-DD>/`). Ver a seção 6.

## 1. Ambiente (AC-B19.1 a)

- **Sistema:** Windows 11 23H2 ou mais novo, x64. O CI só gera o binário x64 (`desktop-windows`). Registre a versão e o build (`[Environment]::OSVersion`, `winver`) e se é VM (qual hipervisor) ou PC.
- **Snapshot:** tire um snapshot da VM ou um ponto de restauração **antes** da sessão. A limpeza preferida é voltar a ele (seção 7).
- **Conta:** uma conta local de teste, isolada, sem conta Microsoft pessoal. As ferramentas são instaladas antes do snapshot; a sessão roda como usuário padrão.
- **Sem chaves reais.** Nenhuma chave de API real entra na máquina. O critério 7 com OpenAI ou Anthropic fica **BLOQUEADO**, a não ser que o próprio usuário digite a chave dele; o agente nunca digita uma chave real.
- **Sem contas pessoais na nuvem.** Para o AC-B03.5 use uma conta de teste do OneDrive separada, só com notas de teste.
- **WebView2 Evergreen:** registre a versão. Por exemplo: `(Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}').pv`.
- **Argumentos do WebView2 por fora do app:** a variável de ambiente `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` e a política de registro `AdditionalBrowserArguments` do WebView2 **sobrepõem** os argumentos que o app passa ([documentação da Microsoft](https://learn.microsoft.com/microsoft-edge/webview2/reference/win32/webview2-idl); [WebView2Feedback #5571](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5571)). Isso desligaria a flag de WebRTC do app. Antes da sessão, registre que as duas estão ausentes: `Get-ChildItem Env:WEBVIEW2*` vazio, e `reg query HKLM\SOFTWARE\Policies\Microsoft\Edge\WebView2` e `reg query HKCU\SOFTWARE\Policies\Microsoft\Edge\WebView2` sem `AdditionalBrowserArguments`. A única exceção é o experimento do proxy morto (seção 5.8), que define a variável só no processo que abre o app.
- **Ferramentas** (instaladas antes do snapshot):
  - PowerShell e Git for Windows (o Git Bash traz `sha256sum`);
  - Python 3, para o `listener.py` da sonda de rede;
  - Ollama com um modelo pequeno, para o critério 7 local;
  - NVDA, com o Visualizador de Fala (Speech Viewer);
  - Node 22.22.3 e pnpm 12.8.1, só para gerar o vault de 2.000 notas (`node scripts/gen-vault.mjs <pasta>`) ou para um build local;
  - o leitor de PDF padrão e a impressora "Microsoft Print to PDF".

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

2. **UI Automation antes de entrada sintética.** Botões, abas, interruptores e campos são acionados por UI Automation (`InvokePattern`, `SelectionItemPattern`, `TogglePattern`, `ValuePattern`). Entrada sintética (`SendInput`) só quando a UI Automation não alcança, como digitar no editor CodeMirror, atalhos e o IME, e sempre depois da guarda.
3. **Capturas só da janela do app.** Capture apenas a janela do `simplemd.exe` (por exemplo `PrintWindow` no HWND dela, ou o retângulo dela depois da guarda). Nunca a área de trabalho inteira. Nunca capture um campo de chave preenchido, o Gerenciador de Credenciais nem diálogos do Windows Security ou do UAC.
4. **Só vaults de teste.** Vaults só em `%TEMP%\smd-win-*`; a única exceção é a pasta de teste dentro do OneDrive de teste (AC-B03.5). Nunca abra Documentos, a área de trabalho ou uma pasta real do usuário.
5. **Credenciais.** Só o serviço do app (`io.github.devrafaelbrauner.simplemd`) e só com o valor falso `valor-de-teste-winqa`. Nesta máquina não há chave real, então o agente **pode** confirmar os diálogos "Salvar chave" e "Remover chave" com esse valor falso; isso nunca vale numa máquina com chaves reais. Nunca abra, edite nem leia outras entradas do Gerenciador de Credenciais; para conferir, use só `cmdkey /list`, que mostra nomes e nunca senhas, filtrado por `simplemd`.
6. **Pare e chame o Main** se aparecer um pedido do UAC, do Windows Hello, do SmartScreen sobre outro arquivo que não o binário em teste, ou qualquer diálogo inesperado. Não clique nele.
7. **Configurações do sistema** que a sessão muda (idiomas de entrada, NVDA, OneDrive de teste) são registradas antes e depois e voltam ao estado de antes no fim (seção 7).

## 3. Instalação (AC-B19.1 c)

- **Preferido:** o artefato `desktop-windows` do CI da revisão em teste (30 dias). Ele traz `simplemd.exe`, `dist-digest.txt`, `dist-files.sha256` e `SHA256SUMS`. Baixe com `gh run download <id do run> -n desktop-windows` (numa máquina com o `gh`, depois copie para a VM) e confira no Git Bash com `sha256sum -c SHA256SUMS` (todas as linhas `OK`). Registre o id do run, a revisão (`headSha`) e o sha256 do `simplemd.exe`.
- **Alternativa:** um build local na revisão registrada (`pnpm install --frozen-lockfile`, `pnpm tauri build --no-bundle`), com o sha256 do binário registrado. A evidência diz qual das duas foi usada.
- Os instaladores sem assinatura do dry-run do `release.yml` (`bundle-dry-run-windows`: msi e nsis) **não** fazem parte desta sessão: instalar e atualizar com assinatura é o AC-B01.11 (B-01).
- O binário não tem assinatura: o SmartScreen pode avisar na primeira execução. Registre o aviso e libere só esse arquivo.
- Para ver as marcas do app (`simplemd:ready`, `simplemd:export-print`, `simplemd:catalog-shown`…), abra o app pelo PowerShell com a saída redirecionada, por exemplo `Start-Process .\simplemd.exe -RedirectStandardOutput out.txt -RedirectStandardError err.txt -PassThru` (guarde o PID para a guarda da seção 2). [Inferência: o binário é de subsistema GUI; confirme na primeira execução que as linhas aparecem em `out.txt`.]

## 4. Preparação dos dados

- Vault pequeno: `%TEMP%\smd-win-basico` com algumas notas `.md` (LF e CRLF + BOM), mais `rich.md`, `calc-fixture.md` e `export-fixture.md` (de `packages/plugins-internal/test/fixtures/`).
- Vault grande: `%TEMP%\smd-win-2000`, gerado por `node scripts/gen-vault.mjs %TEMP%\smd-win-2000`.
- Plugin de exemplo: `plugins-examples/hello-world/` (`manifest.json` + `main.js`, id `com.exemplo.hello-world`).
- Sonda de rede (fora do repositório, nunca publicada): o `listener.py` da AppSec r2 (`.nexus/runs/r2-etapas-6-12/qa/AppSecR2/wk-csp-probe/listener.py`; TCP `127.0.0.1:47901`, UDP `127.0.0.1:47902`, só loopback) e o plugin de sonda do r3 (`.nexus/runs/r3-backlog-b01-b19/qa/EvidenceCollectorR5/fixtures/probe-r3/`). Copie os dois para a VM. Na cópia da sonda, acrescente um comando de teste "TURN sobre TCP" (`new RTCPeerConnection({ iceServers: [{ urls: 'turn:127.0.0.1:47901?transport=tcp', username: 'u', credential: 'p' }] })`, um `createDataChannel`, `createOffer` e `setLocalDescription`). Ele só mira o listener local.
- Registre o sha256 de cada arquivo copiado.

## 5. Roteiros da sessão (AC-B19.1 d)

Cada passo registra o esperado e o observado literal. Rode as linhas na ordem abaixo: as que mudam o sistema (IME, OneDrive, proxy morto) ficam para o fim.

### 5.1 AC-B03.1 — critérios 1, 2, 5, 6 e 7

- **Critério 1 (abrir, editar, salvar; AC-2.22):** abra `%TEMP%\smd-win-basico` com "Abrir pasta…" (`Ctrl+O`), abra uma nota, digite, espere o autosave (1 s) e confira os bytes no disco (`Get-FileHash` antes e depois, `Format-Hex` no trecho; o CRLF + BOM da nota CRLF é preservado). Mude a nota fora do app com edições pendentes e confirme o diálogo de conflito com "Manter ambos" (cópia `<nome> (conflito …).md`) e "Recarregar do disco". Feche a aba (`Ctrl+W`) e a janela com uma edição pendente: a edição é gravada.
- **Critério 2 (plugin sem recompilar):** ver 5.4 (o mesmo roteiro).
- **Critério 5 (autocompletar; AC-8.7/8.8):** Configurações → "Autocompletar" desligado → feche e reabra a pasta → `[[` não abre popup → ligue → popup. `Ctrl+Espaço` abre as sugestões. Enter sem opção ativada pelas setas quebra a linha (R4-02).
- **Critério 6 (catálogo; AC-9.10, NFR-26):** abra `%TEMP%\smd-win-2000`: catálogo com 2.000 notas, busca por título, `#tag`, Sumário e Propriedades da nota aberta. Registre 5 tempos de "Mostrar catálogo" pela marca `simplemd:catalog-shown` (cada um < 1.000 ms).
- **Critério 7 (IA):** Ollama local (AC-11.15): "IA: Resumir seleção" com o Ollama rodando → o cartão de resultado aparece e o texto só muda pelo clique. OpenAI/Anthropic: **BLOQUEADO** (sem chave real nesta máquina), a não ser que o usuário digite a própria chave.

### 5.2 AC-B03.2 — CR2-02 com o seletor de pasta não modal

1. Com `smd-win-basico` aberto e uma nota com edição não salva, abra "Abrir pasta…".
2. Com o seletor aberto, volte à janela do app (se ela aceitar foco) e digite `X-durante-o-seletor` na nota.
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

### 5.4 AC-B03.4 — fluxo de plugins (critério 2)

1. Copie `plugins-examples/hello-world/{manifest.json,main.js}` para `%TEMP%\smd-win-basico\.simplemd\plugins\com.exemplo.hello-world\`.
2. Configurações → "Plugins" → "Recarregar lista" → o plugin aparece → ativar → aviso "Ativar um plugin de terceiros?" → "Ativar mesmo assim".
3. Paleta (`Ctrl+Shift+P`) → "Dizer olá"; o atalho `Ctrl+Shift+H` faz o mesmo; digitar `hello` no editor mostra a decoração `cm-hello-world`.
4. Desative o plugin: o comando some e a decoração some, sem recriar o editor.

### 5.5 AC-B03.5 — marcadores do OneDrive "Arquivos sob demanda" (NB-R2)

1. Entre na conta de teste do OneDrive com "Arquivos sob demanda" ligado. Crie uma pasta de teste com notas enviadas por outro dispositivo ou pela web, para que fiquem **só online** (ícone de nuvem). Confira com `Get-Item <nota> | Select-Object Attributes` (registre os atributos) antes de abrir.
2. Abra essa pasta como vault. **Esperado:** as notas só online aparecem no explorador (não são descartadas como link).
3. Abra uma: ela é baixada e mostrada, sem `INVALID_PATH`, `OUTSIDE_VAULT` nem recusa como link.
4. Edite e salve: o arquivo continua sincronizando no OneDrive (sem erro de sincronização) e continua sendo um arquivo comum para o app.
5. Registre os atributos de novo depois de abrir e de salvar. Qualquer recusa é registrada com o código de erro literal.

### 5.6 AC-B03.6 — sonda WebRTC com a flag do r3 (B-06)

1. Rode `python listener.py 47901 47902 <log> 180` no próprio Windows.
2. **Controle positivo:** abra uma página local no Edge (navegador, sem flags) que rode o mesmo vetor de STUN para `stun:127.0.0.1:47902`; o log tem de mostrar datagramas UDP. Sem isso, a sonda não vale (NOT TESTED).
3. No app, ative a cópia da sonda num vault de teste e rode, um por vez: STUN no realm principal, STUN num iframe `about:blank`, `<link rel=preconnect href=http://127.0.0.1:47901>` e TURN sobre TCP.
4. **Esperado:** 0 datagramas UDP no STUN, nos dois realms (AC-B03.6). `preconnect`: registre o resultado (no Chromium deu 0 TCP). TURN sobre TCP: registre se chega uma conexão TCP com bytes de TURN Allocate em 47901; no Chromium 153 chegou, apesar da flag (APPSEC-R3-02).

### 5.7 AC-B04.1–3 — impressão para PDF no WebView2

1. Abra `export-fixture.md` no tema claro → `Ctrl+P` → painel de impressão → "Microsoft Print to PDF" → salve em `%TEMP%\smd-win-pdf\claro.pdf`. Repita no tema escuro (`escuro.pdf`).
2. **AC-B04.1:** nos dois PDFs há o diagrama Mermaid, a fórmula KaTeX, a tabela, o `5` do calc e os marcadores e números das listas; não há faixas escuras nem fio na borda (S6-1, S6-2); a página é A4.
3. **AC-B04.2:** baixe o artefato `export-pdf-windows` do CI da **mesma revisão** (`export.pdf` + `export.pdf.sha256`) e compare lado a lado com `claro.pdf`: nenhum elemento falta. O PDF do CI prova só o motor (Edge); este prova a impressão dentro do app.
4. **AC-B04.3 (NFR-32):** 5 vezes, do comando ao painel de impressão, pela marca `simplemd:export-print`; cada uma ≤ 4.000 ms.

### 5.8 Experimento do proxy morto (D-1, APPSEC-R3-02)

Só depois de 5.6, numa nova abertura do app, com a variável definida **apenas** no PowerShell que abre o app (como ela sobrepõe os argumentos do app, a string repete os padrões do wry e a flag de WebRTC do r3):

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --force-webrtc-ip-handling-policy=disable_non_proxied_udp --proxy-server=http://127.0.0.1:9 --proxy-bypass-list=<-loopback>'
Start-Process .\simplemd.exe -RedirectStandardOutput out-proxy.txt -RedirectStandardError err-proxy.txt -PassThru
Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
```

1. **O app carrega e o IPC funciona** (`tauri.localhost`/`ipc.localhost`): a janela não fica em branco, `simplemd:ready` aparece, abrir a pasta, ler, editar e salvar uma nota, exportar HTML, abrir o painel de impressão e uma resposta do Ollama funcionam.
2. **Os canais fecham:** repita os vetores de 5.6; esperado 0 UDP e 0 TCP, inclusive TURN sobre TCP.
3. **Decisão:** se 1 e 2 passarem, a AppSec avalia levar os dois argumentos do proxy para `WEBVIEW2_ARGS` (`apps/desktop/src-tauri/src/webview_net.rs`) num PR próprio, com o `check:security` atualizado. Se o passo 1 falhar, o resíduo continua **aceito com documentação** (`docs/plugins.md`, item 5).

### 5.9 AC-B14.9 — IME, teclas mortas e NVDA no WebView2

- **IME japonês da Microsoft (Romaji)** com o autocompletar ligado: componha `にほんご`, converta com Espaço e confirme com Enter. Esperado: só o texto confirmado entra, o Enter da composição confirma o candidato e nunca aceita uma sugestão, e os bytes gravados são o UTF-8 esperado. Registre também se o Enter **seguinte** a um commit convertido com Espaço quebra a linha (no WKWebView não quebra: IME-ENTER-1) e se o popup abre sob a janela de candidatos (IME-POP-1).
- **Teclas mortas:** com o layout US-Internacional, `'` + `e` → `é`, `~` + `a` → `ã`, `^` + `e` → `ê`; com ABNT2, as teclas físicas ´ ~ ^. Em prosa, com o autocompletar ligado: caracteres exatos, nenhuma sugestão aceita, bytes gravados corretos.
- **NVDA** (com o Visualizador de Fala ligado, que é a evidência em texto):
  - digitar uma palavra que abre o popup → "N sugestões, ↓ para escolher" falado uma vez por abertura, e as setas não o repetem (A11Y-R5-01; registre se ele se repete a cada pausa com a mesma contagem, A11Y-R3-01);
  - com o foco no editor, só a aba ativa é anunciada como selecionada (EC3-A11Y-1);
  - a falha ao salvar no editor de temas é lida uma vez (QR-05);
  - como o NVDA lê o atalho das abas (`aria-keyshortcuts`; no macOS o VoiceOver diz "Meta+W", VO-KS-1).
- Registre os idiomas de entrada antes e depois (`Get-WinUserLanguageList`).

## 6. Formato da evidência (AC-B19.1 e)

- `env.txt`: versão e build do Windows, versão do WebView2, VM ou PC (hipervisor), CPU e RAM, fuso horário, a saída da checagem de `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` e da política de registro (seção 1).
- `revision.txt`: revisão (`git rev-parse HEAD` da origem do binário), id do run do CI, saída literal do `sha256sum -c SHA256SUMS`, sha256 do `simplemd.exe`.
- `report.md`: uma linha por AC — ID, passos, esperado, observado (saída literal), **PASS / FAIL / NOT TESTED / BLOQUEADO**, arquivo de evidência com sha256 e horário em UTC. Ferramenta ou ambiente indisponível = NOT TESTED, nunca PASS. Cada achado novo é classificado BLOCKING ou NON-BLOCKING, com dono.
- Capturas: só da janela do app (PNG), com sha256; nunca com um campo de chave preenchido.
- Logs: `out*.txt`/`err*.txt` do app, logs do `listener.py`, texto do Visualizador de Fala do NVDA, saídas do `cmdkey /list` filtradas (só nomes), atributos dos arquivos do OneDrive.
- `SHA256SUMS` de todos os arquivos da pasta de evidência.
- Só depois da sessão as frases "Windows interativo: NÃO TESTADO" e "critério 4 no WebView2: NÃO TESTADO" mudam em `TAREFAS_PENDENTES.md` e `docs/seguranca/etapa-12.md`, e só para os itens que tiverem PASS com evidência.

## 7. Limpeza e restauração (AC-B19.1 f)

1. Feche o app pelo menu ou pelo botão de fechar (o flush roda); `Get-Process simplemd -ErrorAction SilentlyContinue` vazio.
2. Pare o `listener.py` e o Ollama.
3. `cmdkey /list | Select-String simplemd` → nenhuma linha.
4. Variáveis de ambiente: `Get-ChildItem Env:WEBVIEW2*` vazio.
5. Idiomas de entrada e layouts iguais aos de antes (`Get-WinUserLanguageList`, antes e depois); NVDA fechado.
6. Saia da conta de teste do OneDrive; apague `%TEMP%\smd-win-*`.
7. Preferido: volte ao snapshot da VM (ou ao ponto de restauração) e registre que voltou.

## 8. Revisão do protocolo (AC-B19.2)

Pendente. A QA (EvidenceCollector) e o DevOps revisam este protocolo antes da sessão e acrescentam aqui as notas de revisão, com data.
