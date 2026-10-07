# Etapa 12 — `/seguranca`: relatório de segurança (Fase A, etapas 6–11)

Este relatório resume e cita as revisões de segurança da rodada r2. Ele não traz evidência nova
própria. As evidências brutas ficam nos artefatos do NEXUS, fora do repositório (`.nexus/` está no
`.gitignore`), sob `.nexus/runs/r2-etapas-6-12/`, abreviado `RUN/`. Cada artefato citado traz o
sha256.

**Veredito:** ver S9. Ele está **pendente de confirmação pela AppSec (rodada 2)**.

## S1 Escopo

| Campo                  | Valor                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Revisão das varreduras | `842e3e41097129e7ead2976bd349a0b63e62397c`, fingerprint `67e5f9a525a721e9cc8e797a540885626f21246682055b2c451ce3c8abd116bd` (438 arquivos, igual no início e no fim). Data: 2026-10-07, 13:37–13:51 UTC (AppSecR2, SecretsR2)                                                                                                                                                                                                                            |
| Revisões posteriores   | `24da325` (fixtures reais da Anthropic), `ef1fd79` e `55a81f6` (correções de testes e de UI da QA r2) e `e9cf808` (documentação). Nenhuma mexe em CSP, capability, comando IPC, Rust ou dependência. Elas foram cobertas pelo gitleaks local (`no leaks found`) e pela execução do CI [37652183409](https://github.com/devrafaelbrauner/simpleMD/actions/runs/37652183409) em `e9cf808`: 10/10 jobs `success`, inclusive `secrets`, `audit` e `semgrep` |
| Binários de release    | `e441e1ad7cc1fc9d68f3184f5e01f85ede0d7d9a20f138282a6891884a59761d` (testado pela QA). Reconstruído em `e9cf808`: `34ba2a6c475787c039aff7cf4436c307e2b1bb84564abc24d9ea87fa33d47374` (`assert-no-harness` e `assert-no-ai-recorder` OK)                                                                                                                                                                                                                  |
| Ferramentas            | semgrep 1.179.0; gitleaks 8.30.1; cargo-audit 0.22.2 (1293 avisos, base de 2026-10-07); pnpm 12.8.1; node v22.22.3; WebKit do sistema (macOS 27.2); Chromium 153 (Playwright). **trufflehog e osv-scanner: ausentes → NÃO TESTADO**                                                                                                                                                                                                                     |
| Etapas cobertas        | 6 (plugins), 7 (Mermaid/KaTeX/calc), 8 (autocompletar), 9 (front matter/catálogo), 10 (exportação) e 11 (IA). A linha de base é o r1 (`66159f5`)                                                                                                                                                                                                                                                                                                        |
| Relatórios de origem   | `RUN/appsec-report.md`, `RUN/secrets-report.md`, `RUN/evidence-report.md`, `RUN/qa/k0-mac/report.md`, `RUN/impl-s5.md`, `RUN/impl-s7.md`, `RUN/impl-fix-qa2.md`                                                                                                                                                                                                                                                                                         |

## S2 Superfície Tauri

Diferença contra `66159f5`: `RUN/qa/AppSecR2/surface-diff-66159f5.txt` (sha256
`2f3e5c92d70a2ba7e61caefc2a2f0bf02591fd8d10533dff4480a3ff042ac5ab`).

| Mudança                                                                          | Justificativa                                                                                                                                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CSP `script-src 'self'` → `script-src 'self' blob:` (`csp` e `devCsp`)           | Carregar o `main.js` de plugins (AC-6.26). Só uma fonte nova; todas as outras diretivas são idênticas; `connect-src ipc: http://ipc.localhost` não mudou           |
| Saíram `tauri-plugin-fs`, todo `fs:*`, `dialog:allow-open` e `dialog:allow-save` | AS-01/AS-02: o acesso a arquivos passa a ser feito pelo gateway do vault em Rust                                                                                   |
| Entrou `core:webview:allow-print`                                                | PDF pela impressão do WebView (R-10.5)                                                                                                                             |
| Entraram 21 comandos do app (`allow-<comando>`)                                  | Inventário no `appsec-report.md` §4: gateway do vault (7), destinos de salvar e abrir (3), aprovações de plugins (4), chaves (3), IA (2), `pick_vault`, `app_mark` |
| Janela criada no Rust (`create: false`)                                          | Prende os guardas `on_navigation`, `on_new_window` e `on_download`                                                                                                 |

- `node scripts/check-tauri-security.mjs`, saída literal: `check:security — OK: CSP definida, 1 capability(ies) sem escopo estático de fs, sem plugin fs nem permissões fs/diálogo no webview, sem shell/process/opener, script-src 'self' blob:, navegação/janelas novas bloqueadas, connect-src ipc: http://ipc.localhost (inalterado), assetProtocol e drag-and-drop desligados.` (`RUN/qa/AppSecR2/static-scripts.txt`, sha256 `6abe17760e0d6db0057723441f6ac0eb164021db4dbca4eae7bb1f5f3cd6e5c7`).
- Escopos de fs estáticos com curinga: **0**. Plugins de shell/process: **0**. CSP ≠ null (AC-12.3).
- **Navegação e janelas novas:**
  - `nav::is_app_url` só aceita `tauri://localhost`, `http(s)://tauri.localhost` e o `devUrl` em dev. A tabela de teste está em `nav.rs:36-54`.
  - `on_new_window → Deny`; `on_download → false`.
  - No app real, a sonda AC-6.27 (d) fez `location.href='https://example.com'` e o AXURL continuou `tauri://localhost`; (e) `window.open → null`, 1 janela (`RUN/evidence-report.md` §1.2).
- **AS-01, AS-02 e AS-03:** corrigidos (`bc9879b`; AS-02 também em `61b0e28`, com a troca de pasta em duas fases; AS-03 também em `fd133c6`). A metade MAC do AS-02 foi feita pela sonda AC-6.27 (f) com o token vivo (S3).

## S3 Plugins como código de terceiros

**Modelo de ameaça (§4.1):** está em `docs/plugins.md` §Segurança, corrigido nesta etapa (`e9cf808`).

- **PODE:**
  - rodar no realm do app e ver as teclas digitadas, inclusive uma chave de API durante a digitação;
  - chamar o IPC: notas e `.simplemd/`, mas código e manifesto de plugins são só leitura;
  - abrir diálogos;
  - usar a IA com a chave e a cota do usuário;
  - **trocar a chave salva sem aviso**;
  - usar o canal de loopback do Ollama;
  - alterar notas;
  - travar o app;
  - **abrir conexões de rede que a CSP não cobre (WebRTC/STUN e `preconnect`)**.
- **NÃO PODE:**
  - receber os globais do Tauri;
  - ler uma chave salva;
  - fazer pedidos HTTP pelo webview;
  - ler ou gravar fora da pasta sem uma escolha num diálogo do sistema;
  - rodar sem consentimento ou depois que o `main.js` mudou.

**CSP e `blob:`:**

- Uma URL `blob:` só é criada por script que já roda na origem. A CSP não tem `'unsafe-inline'` nem `'unsafe-eval'` em `script-src`, e o bundle de produção tem 0 `eval(`/`new Function(`.
- O conteúdo do documento passa por texto escapado, KaTeX `trust:false` e Mermaid `securityLevel:'strict'`. Nada disso cria blob.
- Logo, `blob:` não abre vetor de injeção de fora.
- Para código que já roda (um plugin), `blob:` transforma texto em módulo. Por isso o hash não cobre código carregado em tempo de execução (APPSEC-R2-03, documentado).

**Sonda AC-6.27 no app real** (release `e441e1ad…`, `RUN/evidence-report.md` §1.2; fixture `mac/fixtures/probe-ec`):

| Item                      | Resultado literal                                                                                                                                                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) globais do Tauri      | `window.__TAURI__ = undefined` (`__TAURI_INTERNALS__` existe e está documentado)                                                                                                                                                                                                                   |
| (b) `fetch` externo       | `bloqueado (TypeError: Load failed)`. Que a causa seja a CSP é [INFERÊNCIA]: o console não estava visível                                                                                                                                                                                          |
| (c) imagem externa        | `bloqueado (onerror)`                                                                                                                                                                                                                                                                              |
| (d) navegação             | AXURL = `tauri://localhost` antes e depois                                                                                                                                                                                                                                                         |
| (e) janela nova           | `window.open → null`, 1 janela                                                                                                                                                                                                                                                                     |
| (f) leitura fora da pasta | Pasta A, token 1: `../` e caminho absoluto → `OUTSIDE_VAULT`; tokens 0 e 2..40 → `VAULT_CLOSED`. Depois de trocar para B (token vivo 2): o token 1 de A → `VAULT_CLOSED`; `../` e absoluto com o token 2 → `OUTSIDE_VAULT`; **0 leituras dos bytes de A** (sha e mtime de A iguais antes e depois) |
| (g) obter chave           | `get_key`/`read_key`/`key_get`/`plugin:keyring\|get` → `not allowed by ACL`; `plugin:fs\|read_text_file` → `not allowed by ACL`                                                                                                                                                                    |

**Canais de rede fora da CSP (APPSEC-R2-01):**

- Sonda de motor com a CSP de produção (`RUN/qa/AppSecR2/wk-csp-probe/`): `listener-webkit.log` sha256 `147d9d2cf72159cc69975864b98614cac5118b4793a12d267482c487c6273d52`; `listener-preconnect-only.log` sha256 `96345c27c44a0e5f952779620620b217a37e3c774878b2ed57d0d5fd34725895`.
- Confirmado no app real: `RUN/qa/EvidenceCollectorR2/mac/logs/net-listener.log`, sha256 `86c02534699c164d60e5c3520adce2661ba06f070cbfca9522a677296b8d75f5`. Um plugin abriu 5 pedidos STUN e uma conexão TCP de `preconnect` para `127.0.0.1`.
- `fetch`, `sendBeacon`, WebSocket, EventSource, `img`, CSS `url()`, `iframe`, `import()` remoto, `prefetch` e `form-action` ficam bloqueados nos dois motores.

**Aviso (AC-6.7) e reconsentimento (AC-6.8):**

- Os textos M1–M8 estão em `packages/ui/src/plugins/warning-text.ts`, e a lista de palavras proibidas é verificada por teste (AC-6.7).
- **Nenhum texto do aviso diz que não há rede.**
- Observação: o M7 ("Se o código do plugin mudar…") vale para o `main.js`. O limite (APPSEC-R2-03) está dito em `docs/plugins.md`. O texto é vinculante e não foi alterado.
- AC-6.8 no app real: **PASS (MAC)**. Código mudado → `Alterado`; nova aprovação com o hash novo; 0 registros de aprovação na pasta; dispositivo novo → `Desativado` (`RUN/evidence-report.md` §0).
- Aprovações ficam em `app_data_dir()/plugin-approvals.json`, fora da pasta, por raiz canônica do Rust. `plugin_enabled_set` nunca aprova; arquivo ilegível falha fechado.

**Risco do PLANO §7, "plugin lê o vault inteiro": verdadeiro por desenho.** Qualquer código no realm que tenha o token chama `vault_read_file`. Os tokens são `u32` sequenciais.

## S4 Chaves (regra 7)

- **Implementação:** `keyring` 3.6.3 (`apple-native`, `windows-native`); serviço `io.github.devrafaelbrauner.simplemd`; contas `ai.openai` e `ai.anthropic`.
- **Inventário sem leitura (AC-11.5): PASS.** Literal: `comandos de chave (AC-11.5, nenhum devolve a chave): set_key → Result<(), AppError>; has_key → Result<bool, AppError>; delete_key → Result<(), AppError>`. O transporte lê a chave por pedido num `Zeroizing<String>` e marca o cabeçalho com `set_sensitive(true)`. O log não tem cabeçalhos nem corpos.
- **Canária (AC-11.6): PASS em debug e release** (`RUN/qa/k0-mac/report.md`).
  - Canárias sintéticas `sk-test-CANARY-` + 32 hex. Hashes em `logs/canary-hashes.txt`, sha256 `22511133825531a14dc42258199a629a50481bc92c45538fdb46ad7aeed95a60`.
  - O campo ficou vazio depois de salvar; o item foi criado no keychain (só atributos lidos).
  - 0 ocorrências da canária em todo lugar alcançável pelo webview varrido (UTF-8 e UTF-16).
- **Redação (AC-11.7): PASS.** Testes Rust `canary_never_leaves_native` e `ten_requests_log_zero_headers`, mais os testes TS (`RUN/impl-s5.md`). Resíduo baixo: um 401 da OpenAI mostra os 4 últimos caracteres mascarados pelo próprio provedor (Secrets S2-05).
- **Varredura das fixtures (AC-11.4): PASS.**
  - O teste do pacote `ai` confere todo arquivo: `pnpm exec vitest run --project ai` → `Tests 103 passed (103)` em `24da325`, com as fixtures reais da OpenAI e da Anthropic.
  - Varredura regex da AppSec: `RUN/qa/AppSecR2/fixture-regex-scan.txt`, sha256 `c127c70052efff221a21fd191c780d351bde1c166beb479ec09ae74d992aab58`. Teve 1 casamento: o texto de erro `"invalid x-api-key"`, sem valor.
  - Antes de copiar as fixtures da Anthropic: `gitleaks detect --no-git` → `no leaks found`; grep de padrões de chave → 0 linhas.
- **Varredura com chave real (AC-11.16):**
  - OpenAI: **PASS (MAC-K)**. Depois da execução, gitleaks e a varredura `sk-`/Bearer deram 0 resultados (`RUN/evidence-report.md` §1.7).
  - Anthropic: as fixtures foram gravadas com a chave do usuário, mas a verificação no app está **pendente (MAC-K)**.
- **Teste F-6:** `apps/desktop/test/ai.test.ts` (keychain falso). A canária nunca chega ao `config.json`.
- **Gravador fora do release:** `assert-no-ai-recorder — OK: apps/desktop/src-tauri/target/release/simplemd (9174256 bytes), 0 ocorrências de SIMPLEMD_AI_RECORD_DIR, SIMPLEMD_AI_RECORD_INVALID_KEY, invalid-key-for-401-fixture.`

## S5 Rede

- **Lista de hosts do transporte nativo** (`ai/policy.rs`):
  - OpenAI usa só `https://api.openai.com` e Anthropic só `https://api.anthropic.com`; `baseUrl` → `HOST_NOT_ALLOWED`.
  - Ollama aceita só `http://` com `127.0.0.1`, `localhost` ou `[::1]` e porta opcional. Recusa userinfo, caminho, query, fragmento, `\` e espaços.
  - Pares (método, caminho) exatos por provedor. Cabeçalhos permitidos: `content-type`, `accept`, `anthropic-version`. O webview nunca fornece autenticação.
- **Redirecionamento:** `Policy::none()` mais `REDIRECT_NOT_FOLLOWED`. O teste `redirect_is_not_followed` aponta o `Location` para `https://evil.example/steal`.
- **Transporte:** sem proxy; HTTP/1.1; TLS do sistema; conexão em 10 s; resposta até 8 MB; até 4 pedidos simultâneos.
- **Nenhum tráfego sem ação explícita (AC-11.14):**
  - `apps/desktop/test/ai.test.ts` abre a pasta, digita 200 caracteres e abre plugins e Configurações → 0 chamadas.
  - No app, a seção IA só consulta `has_key` (0 pedidos).
- **Do webview:** a CSP bloqueia HTTP, mas **não bloqueia WebRTC nem `preconnect`** (APPSEC-R2-01, S3). Documentado em `docs/plugins.md`. A mitigação nativa está em `MELHORIAS.md`, com alvo na etapa 13.

## S6 Dependências

- **`pnpm audit --prod`:** `RUN/qa/AppSecR2/pnpm-audit-prod.txt`, sha256 `249c519f3e059ef138942fb72d337796fc2af8ad0c7bbcf755914356f9cb2484`. **0 alta, 0 crítica.** 1 baixa: `katex >=0.11.0 <0.18.2` (GHSA-238p-pmpm-9mq7), caminho `packages__plugins-internal>mermaid>katex`. É a cópia 0.16.47 que o mermaid traz; o katex direto é 0.19.0, já corrigido. O gate do CI (`--audit-level high`) passa.
- **`cargo audit`:** `RUN/qa/AppSecR2/cargo-audit.txt`, sha256 `c738d6e91a42cbb0d88bd8fe48cc9d3122db8e5c35e4217ca3143c7ee3f4a5aa`. Saída: `Loaded 1293 security advisories` / `Scanning Cargo.lock for vulnerabilities (452 crate dependencies)`. **0 vulnerabilidades.** Sem a configuração do projeto (`cargo-audit-noconfig.json`, sha256 `1364ac662bb242e6dc3da44de3fb29af8301c41d4f3bc6bce91447b9f5a43f43`), só aparecem RUSTSEC-2024-0370 e RUSTSEC-2024-0429. São avisos Linux/GTK, aceitos (AS-07).
- **Dependências novas** (versão e licença conferidas nos manifestos locais), todas compatíveis com MIT:

  | Dependência | Versão | Licença           |
  | ----------- | ------ | ----------------- |
  | `mermaid`   | 12.1.0 | MIT               |
  | `katex`     | 0.19.0 | MIT               |
  | `yaml`      | 2.9.1  | ISC               |
  | `keyring`   | 3.6.3  | MIT OR Apache-2.0 |
  | `reqwest`   | 0.13.5 | MIT OR Apache-2.0 |
  | `zeroize`   | 1.8.2  | Apache-2.0 OR MIT |
  | `getrandom` | 0.3.3  | MIT OR Apache-2.0 |
  | `notify`    | 8.2.0  | CC0-1.0           |

- **osv-scanner e trufflehog: NÃO TESTADO** (ferramentas ausentes). Registrado como Secrets F-7, com alvo na etapa 13.

## S7 SAST e segredos

| Verificação                                                                                               | Resultado                                                                                                                                                   | Artefato (sha256)                                                                                                  |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `semgrep scan --config auto`                                                                              | 267 regras × 300 arquivos, **0 achados** (1 erro de parse esperado na fixture de JSON inválido)                                                             | `semgrep-auto.json` `d5a929cfd2e28ffa9a45027b79fd46347aab50472f47036fbd09529f27de0805`                             |
| `semgrep --config p/typescript p/react p/rust p/secrets`                                                  | 122 regras × 300 arquivos, **0 achados**                                                                                                                    | `semgrep-packs.json` `b509432733dbf252704953e08679ce741f475b21cc43baacec14ab27232ba174`                            |
| `nosemgrep` no código rastreado                                                                           | 4, cada um justificado na própria linha                                                                                                                     | `appsec-report.md` §2                                                                                              |
| gitleaks no histórico (`gitleaks git --redact`)                                                           | 35 commits, **no leaks found**                                                                                                                              | `gitleaks-history.json` `37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570`                         |
| gitleaks na árvore inteira (inclui ignorados)                                                             | 28 resultados, todos falsos positivos: 3 entradas do `.gitleaksignore` (strings de teste sintéticas), 22 em `.nexus/` (digests), 3 num `.rmeta` de terceiro | `gitleaks-worktree.json` `4484de41ee3ef280f940f938c948518da03e3964a25fd0e47363671dfa37ef68`                        |
| gitleaks em `dist`, binário de release, fixtures do harness e da IA                                       | 0 / 0 / 0 / 0                                                                                                                                               | `appsec-report.md` §2 linha 10                                                                                     |
| SecretsR2: histórico de todas as refs, objetos inalcançáveis, clone limpo, 23 logs do CI, binário, `dist` | **0 credenciais reais**                                                                                                                                     | `RUN/qa/SecretsR2/SHA256SUMS.txt` `0a643bf840f88b8c4d527102436f1928a55d529046cb416b4a2406599070a99c` (85 entradas) |
| gitleaks local depois das correções (`e9cf808`)                                                           | `no leaks found`                                                                                                                                            | `RUN/impl-fix-qa2.md` §7                                                                                           |
| Exportação adversarial                                                                                    | 5/5; 0 construções vivas                                                                                                                                    | `export-adversarial/run.txt` `611579351cb734b5ffaed7669f3d81dd67ead07dbc1641ab77af7c2cb6e4c4bc`                    |
| Diferenciais de parser na pós-checagem da exportação                                                      | 2 cargas passam pelo leitor de texto (APPSEC-R2-12, baixa)                                                                                                  | `parser-differential-run.txt` `283b53a3f0e06e0f434c5971d128a97f0cb362d66782adba574a8f7938b3c481`                   |

## S8 Pendências herdadas (R-12.3) e cadeia de suprimentos do CI (R-12.4)

| Item                                               | Status final                                                                                                                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AS-01, AS-02, AS-03, AS-08                         | **Corrigido** (`bc9879b`; AS-02 também `61b0e28`; AS-03/AS-08 também `fd133c6`)                                                                                                     |
| AS-04 `style-src 'unsafe-inline'`                  | **Aceito**: não há script inline nem `eval`; a exfiltração por CSS `url()` é barrada por `img-src`/`font-src 'self'`; o CodeMirror precisa de estilos inline (`MELHORIAS.md` AS-04) |
| AS-05, AS-06                                       | **Corrigido** (`e8291a6`/`27d0195`). AS-06: subir `minimumReleaseAge` para 10080 a partir de 2026-10-13, etapa 13                                                                   |
| AS-07                                              | **Aceito** (`apps/desktop/src-tauri/.cargo/audit.toml`)                                                                                                                             |
| AS-09 `.md` sem teto                               | **Aceito**: um plugin já pode travar o app (r1 OQ-2); um teto com mensagem pode vir na etapa 13                                                                                     |
| Secrets F-1, F-2, F-3                              | **Corrigido** na etapa 12a                                                                                                                                                          |
| Secrets F-4 proteção de branch                     | Ação do dono do repositório, **antes da etapa 13** (`TAREFAS_PENDENTES.md`, `MELHORIAS.md`)                                                                                         |
| Secrets F-5                                        | **Aceito** (não há workspace Cargo na raiz)                                                                                                                                         |
| Secrets F-6                                        | **Corrigido** (`apps/desktop/test/ai.test.ts`)                                                                                                                                      |
| Secrets F-7                                        | **NÃO TESTADO** (ferramentas ausentes) — etapa 13                                                                                                                                   |
| DO-1, DO-4                                         | **Corrigido** na etapa 12a                                                                                                                                                          |
| DO-2 (artefatos e `SHA256SUMS`), DO-3 (Dependabot) | **Registrado**, etapa 13 (`MELHORIAS.md` DevOps)                                                                                                                                    |

**Cadeia de suprimentos (AC-12.8):**

- `node scripts/check-ci-supply-chain.mjs` → `check:ci — OK: 19 ação(ões) fixada(s) por SHA, 7 checkout(s) com persist-credentials: false, sem permissão de escrita, imagens por digest, Node 22.22.3 (.node-version), Rust 1.98.1 (rust-toolchain.toml), pnpm minimumReleaseAge 1440 + trustPolicy no-downgrade + blockExoticSubdeps.`
- Jobs `secrets` (gitleaks 8.30.1 com sha256 conferido, histórico inteiro), `audit` (`pnpm audit --prod --audit-level high` e cargo-audit 0.22.2) e `semgrep` (imagem por digest, `--error`).
- CI verde no commit desta etapa e no anterior: [37652183409](https://github.com/devrafaelbrauner/simpleMD/actions/runs/37652183409) (`e9cf808`) e 37628878838 (`842e3e4`), 10/10 jobs.

## S9 Achados e veredito

| ID                  | Severidade      | Descrição                                                                                                                                                                                                                               | Evidência                                   | Dono                      | BLOQUEANTE?                                 | Status                                                                                       |
| ------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| APPSEC-R2-01        | Média           | O webview tem canais de saída que a CSP não cobre: WebRTC STUN/TURN (+ DNS) e `preconnect` TCP (WebKit). Com a leitura do vault, um plugin malicioso pode exfiltrar notas                                                               | S3; app real (`net-listener.log`)           | backend / AppSec          | Não (a CSP é a que a especificação permite) | Documentado (`docs/plugins.md`, `e9cf808`); mitigação nativa em `MELHORIAS.md`, **etapa 13** |
| APPSEC-R2-02        | Baixa           | `set_key`/`delete_key` sem confirmação: um plugin troca a chave salva                                                                                                                                                                   | `keys.rs:162-182`                           | backend                   | Não                                         | Documentado; confirmação nativa em `MELHORIAS.md`, etapa 13                                  |
| APPSEC-R2-03        | Baixa           | O consentimento cobre só o `main.js`; código carregado em tempo de execução não                                                                                                                                                         | `loader.ts`, `evaluator.ts`                 | AppSec docs               | Não                                         | Documentado (`docs/plugins.md`)                                                              |
| APPSEC-R2-04        | Baixa           | A sonda (f) do harness usava `token: 0`                                                                                                                                                                                                 | `harness/fixtures/plugins/probe/main.js:26` | QA                        | Não                                         | Resolvido na QA: sonda MAC com o token vivo, PASS (S3)                                       |
| APPSEC-R2-05        | Baixa           | Pasta pendente abandonada alcançável pelo próximo token sequencial                                                                                                                                                                      | `vault/mod.rs:86-90`                        | backend                   | Não                                         | `MELHORIAS.md`, etapa 13                                                                     |
| APPSEC-R2-06        | Baixa           | `katex@0.16.47` dentro do mermaid (GHSA-238p-pmpm-9mq7)                                                                                                                                                                                 | S6                                          | frontend                  | Não                                         | `MELHORIAS.md`, etapa 13                                                                     |
| APPSEC-R2-07        | Info            | E/S fora da pasta por diálogo do sistema escolhido pelo usuário                                                                                                                                                                         | `save_targets.rs`                           | AppSec docs               | Não                                         | Documentado                                                                                  |
| APPSEC-R2-08        | Info            | `core:default` concede menu, path e event                                                                                                                                                                                               | acl-manifests                               | backend                   | Não                                         | `MELHORIAS.md`, etapa 13                                                                     |
| APPSEC-R2-09        | Info            | HTML exportado sem CSP `<meta>`                                                                                                                                                                                                         | `html.ts:491-513`                           | frontend                  | Não                                         | Junto do R2-12 em `MELHORIAS.md`, etapa 13                                                   |
| APPSEC-R2-10        | Info            | Links físicos e a corrida num componente intermediário                                                                                                                                                                                  | `ops.rs:95-116`                             | backend                   | Não                                         | Registrado (CR2-04)                                                                          |
| APPSEC-R2-11        | Info            | A documentação dizia que plugins gravam código de outros plugins (o gateway só deixa ler)                                                                                                                                               | `policy.rs:96-98`                           | AppSec docs               | Não                                         | Documentação corrigida                                                                       |
| APPSEC-R2-12        | Baixa           | Diferenciais de parser na pós-checagem da exportação; CSS `url()` não checado                                                                                                                                                           | S7                                          | frontend                  | Não                                         | `MELHORIAS.md`, etapa 13                                                                     |
| Secrets S2-01…S2-08 | Não bloqueantes | Governança (sem proteção de branch, sem pre-commit, `.gitleaksignore` editável no mesmo push), teste de keychain do macOS no CI pulado em silêncio, final mascarado de 4 caracteres num 401, IDs de pedido nas fixtures, F-6 já coberto | `RUN/secrets-report.md` §3                  | dono do repositório / dev | Não                                         | F-4 antes da etapa 13; o resto opcional ou registrado                                        |

**Avaliação da regra de aprovação (§4.5):**

1. 0 achados Crítica/Alta abertos: **atende** (0 Crítica, 0 Alta).
2. 0 achados BLOQUEANTES: **atende**. Não houve exposição de chave nem caminho de leitura fora da pasta (AC-6.27 f com o token vivo). CSP e capability estão dentro da especificação. Não há dependência alta ou crítica nem segredo no repositório, nas fixtures ou nos artefatos.
3. Toda Média corrigida ou registrada com dono e etapa ≤ 13: **atende**. O APPSEC-R2-01 está documentado e registrado em `MELHORIAS.md` (backend/AppSec, etapa 13).
4. Ferramentas obrigatórias com saída literal: **atende** (semgrep, gitleaks, `pnpm audit --prod`, `cargo audit`).
5. Verificações obrigatórias com saída literal: **atende**. Sonda AC-6.27 no app real; canária AC-11.6 em debug e release; inventário AC-11.5; diff da CSP AC-6.26.
6. 0 itens herdados sem status: **atende** (S8).

**NÃO TESTADO nesta etapa:**

- Windows interativo: impressão no WebView2, Credential Manager pela interface, fluxo de plugins e canais WebRTC/`preconnect` no WebView2. Só o build, o `cargo test` do keychain e a lógica rodam no CI.
- trufflehog e osv-scanner (ausentes).
- Verificação da Anthropic no app (MAC-K pendente).
- Leitor de tela real.

**Veredito: APROVADO pela regra da §4.5 sobre a evidência acima — pendente de confirmação pela AppSec (rodada 2).**
