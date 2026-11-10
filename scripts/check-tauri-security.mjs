#!/usr/bin/env node
// Portão estático de segurança do Tauri (AC-2.18, R-2.11, NFR-15; inventário r2 AC-12.3). Falha
// (código 1) se:
// - alguma capability tiver escopo estático de fs, permissão recursiva, `fs:default`, permissão
//   em forma de objeto, qualquer permissão `fs:` ou `dialog:` (o webview não fala com esses
//   plugins: arquivos só pelo gateway do vault, AS-02) ou de shell/process/opener;
// - tauri.conf.json não tiver CSP, deixar o protocolo de assets ou o drag-and-drop ligados,
//   expuser o Tauri global ou não listar as capabilities explicitamente;
// - os comandos do app em `build.rs`, em `generate_handler!` (`lib.rs`) e as permissões
//   `allow-*` da capability não forem exatamente o inventário abaixo;
// - `lib.rs` registrar o plugin fs, qualquer `.plugin(` além do diálogo ou citar o opener;
// - (r7 R-X7.6, D-28) o crate `tauri-plugin-opener` não for exatamente `"2.x"` em `[dependencies]`,
//   `tauri_plugin_opener::` aparecer fora de `src/opener.rs` ou, nele, em outra forma que não a
//   função livre `open_url` (`open_path`, `reveal_item_in_dir`, `OpenerExt`, `init` reprovam);
// - Cargo.toml depender de shell/process/fs, ou QUALQUER package.json do workspace (raiz, `apps/*`,
//   `packages/*`) depender de `@tauri-apps/plugin-(shell|process|opener|fs|dialog)`;
// - (AC-11.5, R-11.4) algum comando tiver nome de leitura de segredo (`get_key`, `read_key`,
//   `secret`, `password`) ou os comandos de chave devolverem algo além de `()`/`bool`;
// - (AC-11.9, r7 R-X7.7) `csp` ou `devCsp` não forem EXATAMENTE as strings esperadas (só `img-src`
//   ganhou `blob:` no r7; `connect-src` igual: IA e LanguageTool falam HTTP no Rust);
// - (r7 R-I8.2, variante N) `src/languagetool/mod.rs` perder as constantes de loopback:8081, o
//   `.no_proxy()` ou o `Policy::none()`, ou o código (sem comentários nem `mod tests`) de
//   `src/languagetool/*.rs` tiver qualquer literal com `://` além de `"http://{addr}{}"`;
// - (APPSEC-R2-08) a capability pedir `core:default` ou qualquer `core:*` fora da lista mínima;
// - (APPSEC-R2-01, B-06, W-01) `webview_net.rs` perder os padrões do wry, a política de WebRTC ou
//   o proxy morto dos argumentos do WebView2, usar a `--force-webrtc-ip-handling-policy` (sem efeito
//   no WebView2), não escolher os argumentos de release fora do `tauri dev`, a preferência do WebKit
//   guardada por `respondsToSelector`, o `LinkPreconnect` ou a configuração aplicada, ou `lib.rs`
//   não passar a janela por `harden`; (AS-R4-01, IMP-W01-2) o código Rust de `src/` (sem
//   comentários, literais nem testes) citar `additional_browser_args` mais de 1 vez ou usar
//   `with_environment`, ou `webview_net::harden(builder)` não ir direto para `.build()?`;
// - (B-01) um overlay `tauri.*.conf.json` trouxer algo além de `bundle`/`version` (ou outro
//   `identifier`, ou `bundle.publisher`), o de release não ligar o hardened runtime com
//   `Entitlements.plist`, ou os entitlements tiverem uma chave proibida; o `has_key` do macOS ler
//   dados do segredo; (N16) o `bundle.publisher` do tauri.conf.json não for `"Rafael Brauner"`;
// - (r8, R-R8-1.6, D-R8-S03) o `bundle.resources` do overlay de release não for exatamente o mapa
//   `THIRD-PARTY-NOTICES.md` + `THIRD-PARTY-LICENSES.txt` na raiz de recursos, ou o tauri.conf.json
//   base declarar `bundle.resources` (quebraria `cargo test`/`tauri dev` num checkout limpo);
// - (r31 D-R31-06, `AI_SEND_GATE`; r41a) no código de `src/ai/mod.rs`, `ai_send` não tiver o portão
//   de sessão e a contagem, `lib.rs` não registrar o `SessionGate`, `Transport::prepare` (sem o
//   portão) ou um `Admit` que não seja o `SessionGate` não estiverem sob
//   `#[cfg(any(test, feature = "fixtures"))]`, a feature `fixtures` ligar no app (`default` do
//   Cargo.toml, `build.features` do tauri.conf.json) ou `aiTransport.ts` não escutar só o
//   `USAGE_EVENT` do Rust (o TS ausente, com o pacote do app presente, também);
// - (r36a, AC-R36-1, R21-RS-02) algum `#[tauri::command]` de `src/vault/**`, `src/spell/**` (r34)
//   ou `src/save_targets.rs` não chamar, no código (sem comentários, testes nem literais, lidos numa
//   passada só como o lexer do Rust, raw strings `r#"…"#` inclusive), `blocking(` ou `.with_root(`
//   seguidos de `.await`, passar a essas chamadas um job que não seja uma closure (`|…|` ou
//   `move |…|`; r37b, review r36a NB1: um bloco ou um helper chamado na hora roda na thread do
//   runtime), ou tiver `ops::`, `fs::`, `File::`, `OpenOptions::`, `dir::`/`Dir::`, `.root(` ou um
//   método de `Path` que vai ao disco (`.metadata(`, `.exists(`…; AppSec r37b item 3), também pelo
//   caminho (`Path::read_dir(p)`), com outro nome por um `use` (`use std::fs as f`,
//   `use std::fs::read_to_string`) ou dentro de um helper desses arquivos (r41a; AppSec r37b NB 1)
//   fora da closure — diálogo, E/S e resolução do token fora das threads do runtime —, um
//   `use` de `fs::*` (ou `ops::*`, `dir::*`) nesses arquivos, ou algum comando registrado como
//   `vault::*`/`spell::*`/`save_targets::*` não for achado nesses arquivos;
// - (r34, AC-R34-1; AppSec r34 N3, code review r34 NB-6) o código (sem comentários nem testes) de
//   `src/spell/**` citar `reqwest`, `TcpStream`, `TcpListener`, `UdpSocket`, `ToSocketAddrs`,
//   `tauri_plugin_http`, os módulos `std::net`, `tokio::net`, `crate::ai` ou `crate::languagetool`
//   (também por `super::` ou num `use` agrupado) ou tiver `://` (o corretor não fala com a rede).
// Raiz do repositório opcional em `argv[2]` (cópias alteradas nos testes).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
const root = pathToFileURL(join(repo, 'apps/desktop/'));
const tauriDir = new URL('src-tauri/', root);
const problems = [];
const fail = (message) => problems.push(message);
const readJson = (url) => JSON.parse(readFileSync(url, 'utf8'));

const FORBIDDEN_PLUGIN = /(^|[^a-z])(shell|process|opener)([^a-z]|$)/;
const WILDCARD = /\*\*|\$HOME|^\/$/;

/** Inventário de comandos do app (arch-backend r2 §1.8; r7 §1.5: 21 → 26; r32a: 26 → 28, a camada
 *  global de dicionários `dict_global_read`/`dict_global_write`; r33a: 28 → 30, importar uma lista
 *  de termos pelo diálogo do Rust `dict_import` e renomear/remover uma lista `dict_manage`; r37b:
 *  30 → 32, a busca no texto das notas `vault_search_text` e o cancelamento dela
 *  `vault_search_cancel`; r34: 32 → 35, o corretor offline
 *  `spell_check`/`spell_suggest`/`spell_reload`). Mudar esta lista é decisão de segurança. */
const APP_COMMANDS = [
  'ai_cancel',
  'ai_send',
  'app_mark',
  'delete_key',
  'dict_global_read',
  'dict_global_write',
  'dict_import',
  'dict_manage',
  'has_key',
  'lt_cancel',
  'lt_check',
  'lt_languages',
  'open_file_pick',
  'open_url',
  'pick_vault',
  'plugin_approval_clear',
  'plugin_approval_set',
  'plugin_approvals_get',
  'plugin_enabled_set',
  'save_target_pick',
  'save_target_write',
  'set_key',
  'spell_check',
  'spell_reload',
  'spell_suggest',
  'vault_lstat',
  'vault_mkdir',
  'vault_read_dir',
  'vault_read_file',
  'vault_read_image',
  'vault_search_cancel',
  'vault_search_text',
  'vault_unwatch',
  'vault_watch',
  'vault_write_file',
];
/** Nenhum comando pode ter cara de "ler a chave" (AC-11.5). */
const SECRET_READER = /get_?key|read_?key|secret|password/;
/** Tipos de retorno permitidos aos comandos de chave: nunca o valor (R-11.4). */
const KEY_COMMAND_RETURNS = {
  set_key: 'Result<(), AppError>',
  has_key: 'Result<bool, AppError>',
  delete_key: 'Result<(), AppError>',
};
/** `connect-src` de `66159f5` (AC-11.9). */
const CONNECT_SRC = 'ipc: http://ipc.localhost';
/** CSP inteira de R-X7.7 (variante N): a de `52de38b` com `img-src 'self' blob:`; nada mais muda. */
const EXPECTED_CSP =
  "default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; font-src 'self'; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";
const EXPECTED_DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; font-src 'self'; connect-src ipc: http://ipc.localhost ws://localhost:1420 http://localhost:1420; object-src 'none'; base-uri 'none'";
/** Transporte LanguageTool (r7 §1.4, D-R7-B04b): o que `src/languagetool/mod.rs` precisa conter. */
const LT_REQUIRED = [
  'const LT_PORT: u16 = 8081',
  'Ipv4Addr::LOCALHOST',
  'Ipv6Addr::LOCALHOST',
  '.no_proxy()',
  'Policy::none()',
];
/** Única URL textual aceita no código do LanguageTool: montada só de `ENDPOINTS` (SN-SEC-04). */
const LT_URL_FORMAT = '"http://{addr}{}"';
/** r31 (D-R31-06): o que o corpo de `ai_send` precisa conter, sem comentários — o portão de sessão
 *  (`prepare_admitted`: diálogo nativo no 1º pedido à nuvem de cada provedor) antes da vaga, da
 *  chave e do socket, e a contagem publicada pelo evento do contador. */
const AI_SEND_GATE = [
  "session: State<'_, Arc<SessionGate>>",
  'prepare_admitted(',
  // O tipo garante o resto (r41a; AppSec r41a NB1): `prepare_admitted` só aceita um `Admit`, que no
  // app é só o `SessionGate` (conferido abaixo, junto do `Transport::prepare`).
  '.record(',
  '.emit_to(',
  'USAGE_EVENT',
];
/** Núcleo do Tauri que o app usa de fato (APPSEC-R2-08): `onCloseRequested`, `destroy`, `print`. */
const CORE_PERMISSIONS = [
  'core:event:allow-listen',
  'core:event:allow-unlisten',
  'core:window:allow-destroy',
  'core:webview:allow-print',
];
/** Padrões do wry que somem quando o app define os argumentos + a política de WebRTC (B-06, W-01). */
const WEBVIEW2_WRY_DEFAULTS = ['msWebOOUI', 'msPdfOOUI', 'msSmartScreenProtection'];
const WEBVIEW2_POLICY = '--webrtc-ip-handling-policy=disable_non_proxied_udp';
/** Proxy morto: todo TCP do webview (TURN, preconnect, dns-prefetch) para em 127.0.0.1:9 (W-01). */
const WEBVIEW2_PROXY = ['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>'];
/** Valores exatos (SG-1): um switch repetido no fim valeria no lugar do anterior. */
const WEBVIEW2_WRY = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection';
const WEBVIEW2_RELEASE = [WEBVIEW2_WRY, WEBVIEW2_POLICY, ...WEBVIEW2_PROXY].join(' ');
const WEBVIEW2_DEV = [WEBVIEW2_WRY, WEBVIEW2_POLICY].join(' ');
/** Chaves de nível superior aceitas num overlay de build (B-01, AC-B01.4). */
const OVERLAY_KEYS = ['bundle', 'version', 'identifier'];
/** Atribuição de terceiros que o pacote de release leva na raiz de recursos (r8, R-R8-1.6). */
const RELEASE_RESOURCES = {
  '../../../THIRD-PARTY-NOTICES.md': 'THIRD-PARTY-NOTICES.md',
  '../../../build/third-party/THIRD-PARTY-LICENSES.txt': 'THIRD-PARTY-LICENSES.txt',
};
/** Entitlements que desmontam o hardened runtime (AC-B01.5). */
const FORBIDDEN_ENTITLEMENTS = [
  'com.apple.security.get-task-allow',
  'com.apple.security.cs.disable-library-validation',
  'com.apple.security.cs.allow-dyld-environment-variables',
  'com.apple.security.cs.disable-executable-page-protection',
];
/** Mesmos comandos, sem repetição, independentemente da ordem. */
const sameSet = (a, b) =>
  a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));

// ---- tauri.conf.json ----
const conf = readJson(new URL('tauri.conf.json', tauriDir));
const security = conf.app?.security ?? {};
if (typeof security.csp !== 'string' || security.csp.trim() === '')
  fail('tauri.conf.json: CSP ausente ou nula');
if (
  typeof security.csp === 'string' &&
  /'unsafe-eval'|script-src[^;]*'unsafe-inline'/.test(security.csp)
) {
  fail("tauri.conf.json: CSP de produção não pode ter 'unsafe-eval' nem script inline");
}
// R-6.24/AC-6.26: código de plugin entra por `blob:` — exatamente uma fonte nova em `script-src`.
if (typeof security.csp === 'string') {
  const scriptSrc = /(?:^|;)\s*script-src([^;]*)/.exec(security.csp)?.[1]?.trim();
  if (scriptSrc !== "'self' blob:")
    fail(
      `tauri.conf.json: script-src da CSP deve ser exatamente "'self' blob:" (achado: ${scriptSrc})`,
    );
}
// AC-11.9: a IA fala HTTP no Rust; o `connect-src` do webview continua o de `66159f5`.
if (typeof security.csp === 'string') {
  const connectSrc = /(?:^|;)\s*connect-src([^;]*)/.exec(security.csp)?.[1]?.trim();
  if (connectSrc !== CONNECT_SRC)
    fail(
      `tauri.conf.json: connect-src da CSP mudou (achado: ${connectSrc}; esperado: ${CONNECT_SRC})`,
    );
}
// R-X7.7: as duas CSPs por igualdade da string inteira (qualquer fonte nova reprova).
if (security.csp !== EXPECTED_CSP)
  fail(
    `tauri.conf.json: csp difere da esperada (R-X7.7)\n    achado:   ${security.csp}\n    esperado: ${EXPECTED_CSP}`,
  );
if (security.devCsp !== EXPECTED_DEV_CSP)
  fail(
    `tauri.conf.json: devCsp difere da esperada (R-X7.7)\n    achado:   ${security.devCsp}\n    esperado: ${EXPECTED_DEV_CSP}`,
  );
if (security.assetProtocol?.enable !== false)
  fail('tauri.conf.json: assetProtocol.enable deve ser false');
if (conf.app?.withGlobalTauri !== false) fail('tauri.conf.json: withGlobalTauri deve ser false');
for (const window of conf.app?.windows ?? []) {
  if (window.dragDropEnabled !== false)
    fail(`tauri.conf.json: janela "${window.label}" com dragDropEnabled ligado`);
}
const listed = security.capabilities;
if (!Array.isArray(listed) || listed.length === 0 || listed.some((c) => typeof c !== 'string')) {
  fail('tauri.conf.json: app.security.capabilities deve listar as capabilities por identificador');
}
for (const plugin of Object.keys(conf.plugins ?? {})) {
  if (FORBIDDEN_PLUGIN.test(plugin))
    fail(`tauri.conf.json: plugin proibido configurado: ${plugin}`);
}

// ---- capabilities/*.json ----
const capDir = new URL('capabilities/', tauriDir);
const identifiers = [];
for (const file of readdirSync(capDir)) {
  if (!file.endsWith('.json')) {
    fail(`capabilities/${file}: só arquivos .json são aceitos`);
    continue;
  }
  const cap = readJson(new URL(file, capDir));
  identifiers.push(cap.identifier);
  for (const permission of cap.permissions ?? []) {
    if (typeof permission !== 'string') {
      fail(
        `capabilities/${file}: permissão em forma de objeto (escopo estático): ${JSON.stringify(permission)}`,
      );
      continue;
    }
    if (permission === 'fs:default')
      fail(`capabilities/${file}: fs:default traz escopos estáticos`);
    if (/^fs:scope/.test(permission))
      fail(`capabilities/${file}: escopo estático de fs: ${permission}`);
    if (/^(fs|dialog):/.test(permission))
      fail(`capabilities/${file}: permissão de plugin fs/diálogo no webview: ${permission}`);
    if (/recursive/.test(permission))
      fail(`capabilities/${file}: permissão recursiva: ${permission}`);
    if (WILDCARD.test(permission))
      fail(`capabilities/${file}: curinga em permissão: ${permission}`);
    if (FORBIDDEN_PLUGIN.test(permission.split(':')[0] ?? ''))
      fail(`capabilities/${file}: plugin proibido: ${permission}`);
    if (permission.startsWith('core:') && !CORE_PERMISSIONS.includes(permission))
      fail(`capabilities/${file}: permissão do núcleo fora da lista mínima: ${permission}`);
  }
  const appPermissions = (cap.permissions ?? [])
    .filter((p) => typeof p === 'string' && !p.includes(':'))
    .map((p) => p.replace(/^allow-/, '').replace(/-/g, '_'));
  if (!sameSet(appPermissions, APP_COMMANDS)) {
    fail(
      `capabilities/${file}: comandos do app concedidos (${appPermissions.join(', ')}) ≠ inventário`,
    );
  }
}
if (Array.isArray(listed)) {
  for (const id of identifiers) {
    if (!listed.includes(id))
      fail(`capability "${id}" existe mas não está listada em tauri.conf.json`);
  }
}

// ---- dependências ----
const cargo = readFileSync(new URL('Cargo.toml', tauriDir), 'utf8');
for (const plugin of ['tauri-plugin-shell', 'tauri-plugin-process', 'tauri-plugin-fs']) {
  if (cargo.includes(plugin)) fail(`Cargo.toml: dependência proibida ${plugin}`);
}
// r7 D-28/D-R7-B05: o opener só como crate Rust, exatamente `tauri-plugin-opener = "2.x"` na
// seção `[dependencies]` (sem features, sem outra seção); a função livre é usada só em opener.rs.
let cargoSection = '';
const openerDeps = [];
for (const raw of cargo.split('\n')) {
  const line = raw.trim();
  if (line.startsWith('#')) continue;
  const section = /^\[([^\]]+)\]/.exec(line);
  if (section) cargoSection = section[1];
  if (line.includes('tauri-plugin-opener')) openerDeps.push({ section: cargoSection, line });
}
for (const { section, line } of openerDeps) {
  if (section !== 'dependencies' || !/^tauri-plugin-opener = "2(\.\d+){0,2}"\s*(#.*)?$/.test(line))
    fail(
      `Cargo.toml: tauri-plugin-opener só como \`tauri-plugin-opener = "2.x"\` em [dependencies] (achado em [${section}]: ${line})`,
    );
}
if (openerDeps.length > 1) fail('Cargo.toml: tauri-plugin-opener declarado mais de uma vez');
// Nenhum package.json do workspace (raiz, apps/*, packages/*) traz plugin JS de shell/process/
// opener/fs/diálogo: o webview não fala com esses plugins.
const workspaceManifests = ['package.json'];
for (const group of ['apps', 'packages']) {
  const dir = join(repo, group);
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Sempre com `/` (mensagens iguais em todo SO; o `join` abaixo aceita `/` no Windows).
    const manifest = `${group}/${entry.name}/package.json`;
    if (entry.isDirectory() && existsSync(join(repo, manifest))) workspaceManifests.push(manifest);
  }
}
for (const manifest of workspaceManifests) {
  const pkg = JSON.parse(readFileSync(join(repo, manifest), 'utf8'));
  const names = Object.keys({
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.optionalDependencies,
    ...pkg.peerDependencies,
  });
  for (const name of names) {
    if (/^@tauri-apps\/plugin-(shell|process|opener|fs|dialog)$/.test(name))
      fail(`${manifest}: dependência proibida ${name}`);
  }
}

// ---- comandos do app: build.rs, lib.rs e capability batem com o inventário ----
const buildRs = readFileSync(new URL('build.rs', tauriDir), 'utf8');
const declared = [
  ...(/\.commands\(&\[([^\]]*)\]/.exec(buildRs)?.[1] ?? '').matchAll(/"([a-z_]+)"/g),
].map((m) => m[1]);
if (!sameSet(declared, APP_COMMANDS))
  fail(`build.rs: comandos declarados (${declared.join(', ')}) ≠ inventário`);
const libRs = readFileSync(new URL('src/lib.rs', tauriDir), 'utf8');
const handler = /generate_handler!\[([^\]]*)\]/.exec(libRs)?.[1] ?? '';
const registered = handler
  .split(',')
  .map((s) => s.trim().split('::').pop())
  .filter(Boolean);
if (!sameSet(registered, APP_COMMANDS))
  fail(`lib.rs: comandos registrados (${registered.join(', ')}) ≠ inventário`);
if (/tauri_plugin_fs/.test(libRs)) fail('lib.rs: o plugin fs não pode ser usado nem registrado');
// r7 D-R7-B05: o opener nunca é registrado nem citado em lib.rs (0 comandos `plugin:opener|*`), e o
// único `.plugin(` é o do diálogo (só para a API Rust).
if (/tauri_plugin_opener|OpenerExt/.test(libRs))
  fail(
    'lib.rs: o plugin opener não pode ser registrado nem usado (só a função livre em opener.rs)',
  );
for (const [call] of libRs.matchAll(/\.plugin\([^\n]*/g)) {
  if (!call.startsWith('.plugin(tauri_plugin_dialog::init())'))
    fail(`lib.rs: plugin registrado fora da lista (só o diálogo): ${call}`);
}
// R-6.25: a janela principal nasce com navegação, janelas novas e downloads bloqueados.
for (const guard of [
  '.on_navigation(',
  '.on_new_window(',
  'NewWindowResponse::Deny',
  '.on_download(',
]) {
  if (!libRs.includes(guard)) fail(`lib.rs: guarda de navegação ausente (${guard})`);
}

// ---- APPSEC-R2-01 (B-06): WebRTC/preconnect desligados no motor do webview ----
const webviewNet = readFileSync(new URL('src/webview_net.rs', tauriDir), 'utf8');
// Só o código: sem comentários (o `http://` dos argumentos fica) e sem o `mod tests` (corte ancorado
// na linha). Comentários e testes podem citar o que o portão exige ou proíbe (CR4-W01-1/2, SG-2).
const webviewNetCode = webviewNet
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')
  .split(/^#\[cfg\(test\)\]\s*\nmod tests\b/m)[0];
// O rustfmt pode quebrar a linha depois do `=` nas duas (IMP-W01-2).
const webview2Args = (
  /const WEBVIEW2_ARGS: &str =\s*"((?:[^"\\]|\\[\s\S])*)"/.exec(webviewNetCode)?.[1] ?? ''
).replace(/\\\n\s*/g, '');
const webview2DevArgs = (
  /const WEBVIEW2_DEV_ARGS: &str =\s*"((?:[^"\\]|\\[\s\S])*)"/.exec(webviewNetCode)?.[1] ?? ''
).replace(/\\\n\s*/g, '');
const tokens = webview2Args.split(/\s+/);
const devTokens = webview2DevArgs.split(/\s+/);
for (const arg of WEBVIEW2_WRY_DEFAULTS) {
  if (!webview2Args.includes(arg)) fail(`webview_net.rs: WEBVIEW2_ARGS sem ${arg}`);
  if (!webview2DevArgs.includes(arg)) fail(`webview_net.rs: WEBVIEW2_DEV_ARGS sem ${arg}`);
}
for (const arg of [WEBVIEW2_POLICY, ...WEBVIEW2_PROXY]) {
  if (!tokens.includes(arg)) fail(`webview_net.rs: WEBVIEW2_ARGS sem ${arg}`);
}
if (!devTokens.includes(WEBVIEW2_POLICY))
  fail(`webview_net.rs: WEBVIEW2_DEV_ARGS sem ${WEBVIEW2_POLICY}`);
if (tokens.join(' ') !== WEBVIEW2_RELEASE)
  fail(`webview_net.rs: WEBVIEW2_ARGS deve ser exatamente ${WEBVIEW2_RELEASE}`);
if (devTokens.join(' ') !== WEBVIEW2_DEV)
  fail(`webview_net.rs: WEBVIEW2_DEV_ARGS deve ser exatamente ${WEBVIEW2_DEV}`);
// F-WIN-01: o switch do r3 só vale no content_shell/headless.
if (webviewNetCode.includes('--force-webrtc-ip-handling-policy'))
  fail(
    'webview_net.rs: --force-webrtc-ip-handling-policy não tem efeito no WebView2 (F-WIN-01); use --webrtc-ip-handling-policy',
  );
if (!webviewNetCode.includes('additional_browser_args(webview2_args(tauri::is_dev()))'))
  fail('webview_net.rs: WebView2 sem additional_browser_args(webview2_args(tauri::is_dev()))');
if (
  !webviewNetCode
    .replace(/\s+/g, ' ')
    .includes('if dev { WEBVIEW2_DEV_ARGS } else { WEBVIEW2_ARGS }')
)
  fail(
    'webview_net.rs: webview2_args deve ser if dev { WEBVIEW2_DEV_ARGS } else { WEBVIEW2_ARGS }',
  );
const peerGuard = webviewNet.indexOf('respondsToSelector(sel!(_setPeerConnectionEnabled:))');
const peerCall = webviewNet.search(/msg_send!\[[^\]]*_setPeerConnectionEnabled:/);
if (peerCall < 0 || peerGuard < 0 || peerGuard > peerCall)
  fail(
    'webview_net.rs: _setPeerConnectionEnabled: ausente ou sem a guarda respondsToSelector antes',
  );
if (!webviewNet.includes('"LinkPreconnect"'))
  fail('webview_net.rs: preconnect (LinkPreconnect) não é desligado');
if (!webviewNet.includes('with_webview_configuration('))
  fail('webview_net.rs: a configuração do WKWebView não é aplicada (with_webview_configuration)');
if (!libRs.includes('webview_net::harden('))
  fail('lib.rs: a janela principal não passa por webview_net::harden(');

// ---- B-01: overlays de build (inertes sem --config) e entitlements ----
const overlays = readdirSync(tauriDir).filter(
  (file) => /^tauri\..+\.conf\.json$/.test(file) && file !== 'tauri.conf.json',
);
for (const file of overlays) {
  const overlay = readJson(new URL(file, tauriDir));
  for (const key of Object.keys(overlay)) {
    if (!OVERLAY_KEYS.includes(key))
      fail(`${file}: overlay só pode ter bundle/version (achado: ${key})`);
  }
  if ('identifier' in overlay && overlay.identifier !== conf.identifier)
    fail(`${file}: identifier diferente do base (${overlay.identifier})`);
  if (typeof overlay.bundle === 'object' && Object.hasOwn(overlay.bundle ?? {}, 'publisher'))
    fail(`${file}: bundle.publisher só no tauri.conf.json (N16)`);
  if (file === 'tauri.release.conf.json') {
    if (overlay.bundle?.macOS?.hardenedRuntime !== true)
      fail(`${file}: bundle.macOS.hardenedRuntime deve ser true`);
    if (overlay.bundle?.macOS?.entitlements !== 'Entitlements.plist')
      fail(`${file}: bundle.macOS.entitlements deve ser "Entitlements.plist"`);
    if (!existsSync(new URL('Entitlements.plist', tauriDir)))
      fail(`${file}: Entitlements.plist ausente`);
    for (const [source, destination] of Object.entries(RELEASE_RESOURCES))
      if (overlay.bundle?.resources?.[source] !== destination)
        fail(`${file}: bundle.resources deve levar ${source} como ${destination}`);
    const extra = Object.keys(overlay.bundle?.resources ?? {}).filter(
      (source) => !Object.hasOwn(RELEASE_RESOURCES, source),
    );
    if (extra.length > 0)
      fail(`${file}: bundle.resources só pode ter a atribuição (achado: ${extra.join(', ')})`);
  }
}
if (conf.bundle?.resources !== undefined)
  fail('tauri.conf.json: bundle.resources só no overlay tauri.release.conf.json (D-R8-S03)');
if (conf.bundle?.publisher !== 'Rafael Brauner')
  fail('tauri.conf.json: bundle.publisher deve ser "Rafael Brauner" (N16)');
if (existsSync(new URL('Entitlements.plist', tauriDir))) {
  const plist = readFileSync(new URL('Entitlements.plist', tauriDir), 'utf8').replace(
    /<!--[\s\S]*?-->/g,
    '',
  );
  for (const [, key] of plist.matchAll(/<key>\s*([^<]*?)\s*<\/key>/g)) {
    if (FORBIDDEN_ENTITLEMENTS.includes(key)) fail(`Entitlements.plist: chave proibida ${key}`);
  }
}

// ---- B-01: `has_key` no macOS pede só atributos, nunca os dados do segredo ----
const keysRs = readFileSync(new URL('src/ai/keys.rs', tauriDir), 'utf8');
if (!keysRs.includes('.load_attributes(true)') || keysRs.includes('load_data('))
  fail(
    'keys.rs: has_key do macOS deve pedir só atributos (load_attributes(true), nunca load_data)',
  );

// ---- AC-11.5: nenhum comando devolve material de chave ----
const rustFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? rustFiles(new URL(`${entry.name}/`, dir))
      : entry.name.endsWith('.rs')
        ? [new URL(entry.name, dir)]
        : [],
  );
const commandSignatures = new Map();
for (const file of rustFiles(new URL('src/', tauriDir))) {
  const text = readFileSync(file, 'utf8');
  const signature =
    /#\[tauri::command\]\s*pub(?:\([a-z]+\))?\s+(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*([^{]+?))?\s*\{/g;
  for (const match of text.matchAll(signature))
    commandSignatures.set(match[1], (match[3] ?? '()').replace(/\s+/g, ' ').trim());
  for (const match of text.matchAll(/#\[tauri::command\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g))
    if (!commandSignatures.has(match[1])) commandSignatures.set(match[1], '?');
}

// ---- O Rust como o lexer o lê: base do AI_SEND_GATE, da guarda do vault e da do corretor ----
/** Raw string a partir de `lastIndex`: `r"…"`, `r#"…"#` (qualquer número de `#`), `br`, `cr`. */
const RAW_STRING = /(?:b|c)?r(#*)"/y;
/** Caractere a partir de `lastIndex` (`'a'`, `'\''`, `'\u{…}'`); um tempo de vida (`'a`) não casa. */
const CHAR_LITERAL = /'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|[^\n])|[^'\\\n])'/uy;
const WORD_CHAR = /\w/;
/** Fim (exclusivo) do literal que começa em `i` — string, raw string ou caractere —; senão -1. */
const literalEnd = (text, i) => {
  if (text[i] === '"') {
    let end = i + 1;
    while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
    return Math.min(end + 1, text.length);
  }
  if (text[i] === "'") {
    CHAR_LITERAL.lastIndex = i;
    return CHAR_LITERAL.test(text) ? CHAR_LITERAL.lastIndex : -1;
  }
  // O prefixo abre a palavra: o `r` no fim de um identificador não abre raw string.
  if (!'rbc'.includes(text[i]) || WORD_CHAR.test(text[i - 1] ?? '')) return -1;
  RAW_STRING.lastIndex = i;
  const raw = RAW_STRING.exec(text);
  if (raw === null) return -1;
  const end = text.indexOf(`"${raw[1]}`, RAW_STRING.lastIndex);
  return end < 0 ? text.length : end + 1 + raw[1].length;
};
/** O mesmo tamanho e as mesmas linhas, só com espaços no lugar do resto. */
const blank = (text) => text.replace(/[^\n]/g, ' ');
/**
 * O Rust como o lexer o lê, numa passada só (AppSec r37b item 3): comentários (`//…` e
 * `/* … *\/`, aninhados) e o conteúdo dos literais (entre as aspas, que ficam) em branco, com o
 * mesmo tamanho e as mesmas linhas do texto. Um `//`, `/*` ou `"` dentro de um literal não abre
 * nada, e um literal dentro de um comentário não conta: nem `r#"x"y"#` nem `"/*"` escondem o
 * código que vem depois deles. Um índice do código vale no texto, de onde sai o conteúdo de um
 * literal quando a regra precisa dele (r41a).
 */
const rustTokens = (text) => {
  let out = '';
  let from = 0;
  let i = 0;
  while (i < text.length) {
    let end;
    let replacement = '';
    if (text.startsWith('//', i)) {
      end = text.indexOf('\n', i);
      if (end < 0) end = text.length;
      replacement = blank(text.slice(i, end));
    } else if (text.startsWith('/*', i)) {
      let depth = 0;
      end = i;
      do {
        if (text.startsWith('/*', end)) {
          depth++;
          end += 2;
        } else if (text.startsWith('*/', end)) {
          depth--;
          end += 2;
        } else end++;
      } while (depth > 0 && end < text.length);
      replacement = blank(text.slice(i, end));
    } else {
      end = literalEnd(text, i);
      if (end >= 0) {
        // Ficam o prefixo (`b`, `r#`…) e as aspas das pontas; o resto entre elas vira espaço.
        const quote = text[i] === "'" ? "'" : '"';
        const open = text.indexOf(quote, i);
        const close = text.lastIndexOf(quote, end - 1);
        replacement =
          close > open
            ? text.slice(i, open + 1) + blank(text.slice(open + 1, close)) + text.slice(close, end)
            : blank(text.slice(i, end));
      }
    }
    if (end < 0) {
      i++;
      continue;
    }
    out += text.slice(from, i) + replacement;
    i = end;
    from = end;
  }
  return out + text.slice(from);
};
/** Índice do `)`, `]` ou `}` que fecha o `(`, `[` ou `{` em `open`; sem par, o fim do código. */
const closing = (code, open) => {
  const close = { '(': ')', '[': ']', '{': '}' }[code[open]];
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === code[open]) depth++;
    else if (code[i] === close && --depth === 0) return i;
  }
  return code.length;
};
/** `#[cfg(test)]` (outros atributos podem vir depois) num `mod` com corpo ou em outro arquivo. */
const TEST_MODULE =
  /#\[cfg\(test\)\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*[{;]/g;
/**
 * O código com os módulos `#[cfg(test)]` em branco, do atributo ao `}` que fecha o corpo, contado
 * pelas chaves do código (r41a; code review r31 NB-R1-1, AppSec r31 R1-2: um `mod t {}` vazio ou
 * fechado fora da coluna 0 não engole mais o código que vem depois dele).
 */
const withoutTestModules = (code) => {
  let out = '';
  let from = 0;
  for (const module of code.matchAll(TEST_MODULE)) {
    if (module.index < from) continue; // dentro de um módulo de testes
    const last = module.index + module[0].length - 1;
    const end = code[last] === '{' ? closing(code, last) + 1 : last + 1;
    out += code.slice(from, module.index) + blank(code.slice(module.index, end));
    from = end;
  }
  return out + code.slice(from);
};
/** Um `.rs`: o texto e o código dele (sem comentários, literais nem testes, nos mesmos índices). */
const rustSource = (file) => {
  const text = readFileSync(file, 'utf8');
  return { text, code: withoutTestModules(rustTokens(text)) };
};
/**
 * `{` do corpo da função cujo nome termina em `at` (o primeiro depois dos parâmetros) e o `}` que
 * o fecha; `null` numa declaração sem corpo (`fn f();` de um `trait`).
 */
const fnBraces = (code, at) => {
  const params = code.indexOf('(', at);
  if (params < 0) return null;
  const after = closing(code, params);
  const open = code.indexOf('{', after);
  const semicolon = code.indexOf(';', after);
  if (open < 0 || (semicolon >= 0 && semicolon < open)) return null;
  return [open, closing(code, open)];
};

// ---- AS-R4-01 (SG-3): os argumentos do WebView2 são definidos num lugar só ----
// No código (`rustSource`): comentários, literais e testes não contam (um `#[cfg(test)] fn` solto,
// fora de `mod`, conta: falha fechado). Uma 2ª citação de `additional_browser_args` (chamada ou
// ponteiro) trocaria a lista inteira, um `with_environment` faz o wry ignorar os argumentos, e um
// método entre `harden` e `.build()?` poderia refazer a configuração do builder.
const rustCode = rustFiles(new URL('src/', tauriDir)).map((file) => rustSource(file).code);
const browserArgsCalls = rustCode.reduce(
  (count, code) => count + [...code.matchAll(/\badditional_browser_args\b/g)].length,
  0,
);
if (browserArgsCalls !== 1)
  fail(
    `src/: additional_browser_args deve aparecer 1 vez no código (achado: ${browserArgsCalls}; AS-R4-01)`,
  );
if (rustCode.some((code) => /\bwith_environment\b/.test(code)))
  fail('src/: with_environment no código faz o WebView2 ignorar os argumentos (AS-R4-01)');
if (
  !/webview_net::harden\(builder\)\s*\.build\(\)\?/.test(
    rustSource(new URL('src/lib.rs', tauriDir)).code,
  )
)
  fail('lib.rs: webview_net::harden(builder) deve ir direto para .build()? (AS-R4-01)');

// ---- r31 (D-R31-06) AI_SEND_GATE: `ai_send` passa pelo portão de sessão antes da vaga e da chave ----
// No código (`rustSource`; r41a, AppSec r31 R1-1, AppSec r37b NB 2): um comentário ou um literal
// não satisfaz nem esconde nada, e `ai_send` vai do nome ao `}` que fecha o corpo dele.
const aiMod = rustSource(new URL('src/ai/mod.rs', tauriDir));
const aiSendName = /\bpub async fn ai_send\b/.exec(aiMod.code);
const aiSendBraces = aiSendName && fnBraces(aiMod.code, aiSendName.index + aiSendName[0].length);
const aiSend = aiSendBraces ? aiMod.code.slice(aiSendName.index, aiSendBraces[1] + 1) : '';
for (const needle of AI_SEND_GATE) {
  if (!aiSend.includes(needle)) fail(`ai/mod.rs: ai_send sem ${needle} (AI_SEND_GATE, r31)`);
}
if (!withoutTestModules(rustTokens(libRs)).includes('SessionGate::new('))
  fail('lib.rs: o portão de sessão da IA (SessionGate) não é registrado (AI_SEND_GATE, r31)');
// `Transport::prepare` não tem o portão: existe só nos testes e com a feature `fixtures`, que só o
// gravador de fixtures pede (`required-features`). Sem ela o app nem compila uma chamada, nem por
// ponteiro de função (r41a; AppSec r31 R1-2, code review r31 NB-R1-2): o doctest `compile_fail` de
// `transport.rs` prova isso no `cargo test`; aqui ficam o atributo e a feature desligada no app.
const PREPARE_CFG = '#[cfg(any(test, feature = "fixtures"))]';
/** O `PREPARE_CFG` no código (literal em branco), outros atributos e o `fn prepare`. */
const GATED_PREPARE =
  /#\[cfg\(any\(test, feature = "\s*"\)\)\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?fn\s+prepare\s*[<(]/g;
const transportRs = rustSource(new URL('src/ai/transport.rs', tauriDir));
const prepares = [...transportRs.code.matchAll(/\bfn\s+prepare\s*[<(]/g)].length;
const gatedPrepares = [...transportRs.code.matchAll(GATED_PREPARE)].filter(({ index }) =>
  transportRs.text.startsWith(PREPARE_CFG, index),
).length;
if (prepares === 0 || gatedPrepares !== prepares)
  fail(
    `ai/transport.rs: Transport::prepare (sem o portão de sessão) fora de ${PREPARE_CFG} (r41a)`,
  );
// O portão que `prepare_admitted` recebe é um `Admit`, trait selado de `transport.rs` (r41a; AppSec
// r41a NB1): só esse arquivo o implementa, uma closure não é um, e o doctest `compile_fail` prova
// isso no `cargo test`. Aqui: fora dos testes, o `Admit`/`Sealed` só para o `SessionGate`; outra
// implementação (o `NoGate`, uma genérica para closures) só sob o `PREPARE_CFG`.
const ADMIT_IMPL = /\bimpl\b[^{;]*?\b(Admit|Sealed)\s+for\s+([^\s{]+)/g;
for (const impl of transportRs.code.matchAll(ADMIT_IMPL)) {
  if (impl[2] === 'SessionGate') continue;
  if (!transportRs.text.slice(0, impl.index).trimEnd().endsWith(PREPARE_CFG))
    fail(
      `ai/transport.rs: impl ${impl[1]} for ${impl[2]} (portão de sessão que não pergunta) fora de ${PREPARE_CFG} (r41a)`,
    );
}
// As features que o `default` liga, também por outra (listas numa linha ou em várias).
const cargoFeatures = new Map(
  [
    ...(/^\[features\][^\n]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(cargo)?.[1] ?? '').matchAll(
      /^([\w-]+)\s*=\s*\[([^\]]*)\]/gm,
    ),
  ].map(([, name, list]) => [name, [...list.matchAll(/"([^"]+)"/g)].map(([, feature]) => feature)]),
);
const defaultFeatures = new Set();
for (const pending = ['default']; pending.length > 0;) {
  const feature = pending.pop();
  if (defaultFeatures.has(feature)) continue;
  defaultFeatures.add(feature);
  pending.push(...(cargoFeatures.get(feature) ?? []));
}
if (defaultFeatures.has('fixtures'))
  fail(
    'Cargo.toml: a feature fixtures (Transport::prepare sem o portão) ligada pelo default (r41a)',
  );
if ((conf.build?.features ?? []).includes('fixtures'))
  fail('tauri.conf.json: build.features liga fixtures (Transport::prepare sem o portão; r41a)');
// O nome do evento do contador: o que o Rust emite é o que o webview escuta (code review r31 NB-1).
// A declaração é achada no código e o nome sai do literal dela, no texto (r41a).
const sessionRs = rustSource(new URL('src/ai/session.rs', tauriDir));
const usageDeclarations = [...sessionRs.code.matchAll(/\bpub const USAGE_EVENT: &str = "\s*";/g)];
const USAGE_EVENT_NAME = /pub const USAGE_EVENT: &str = "([^"\\\n]+)";/y;
USAGE_EVENT_NAME.lastIndex = usageDeclarations[0]?.index ?? 0;
const usageEvent =
  usageDeclarations.length === 1 ? USAGE_EVENT_NAME.exec(sessionRs.text)?.[1] : undefined;
if (!usageEvent) fail('ai/session.rs: sem `pub const USAGE_EVENT` (AI_SEND_GATE, r31)');
// Numa cópia só com o Rust o TS não existe. Com o pacote do app, o TS ausente (movido) reprova em vez
// de pular a conferência calado (r41a; code review r31 NB-R1-3, AppSec r31 R1-2).
const aiTransportTs = new URL('src/platform/tauri/aiTransport.ts', root);
if (existsSync(aiTransportTs)) {
  const tsCode = readFileSync(aiTransportTs, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const heard = [...tsCode.matchAll(/\blisten<[^>]*>\(\s*'([^']*)'/g)].map((m) => m[1]);
  if (heard.length !== 1 || heard[0] !== usageEvent)
    fail(
      `aiTransport.ts escuta ${heard.join(', ') || 'nenhum evento'}; o Rust emite ${usageEvent} (AI_SEND_GATE, r31)`,
    );
} else if (existsSync(new URL('package.json', root)))
  fail(
    'apps/desktop/src/platform/tauri/aiTransport.ts ausente: o evento do contador não foi conferido (AI_SEND_GATE, r31)',
  );
for (const name of [...commandSignatures.keys(), ...registered]) {
  if (SECRET_READER.test(name)) fail(`comando com nome de leitura de segredo: ${name} (AC-11.5)`);
}
for (const [name, expected] of Object.entries(KEY_COMMAND_RETURNS)) {
  const actual = commandSignatures.get(name);
  if (actual !== expected)
    fail(`comando ${name}: retorno ${actual ?? 'ausente'} ≠ ${expected} (nunca a chave, R-11.4)`);
}

// ---- r7 R-X7.6 / D-R7-B05: o opener só pela função livre `open_url`, só em src/opener.rs ----
const srcDir = new URL('src/', tauriDir);
for (const file of rustFiles(srcDir)) {
  const rel = file.href.slice(srcDir.href.length);
  const text = readFileSync(file, 'utf8');
  if (text.includes('OpenerExt'))
    fail(`src/${rel}: OpenerExt é proibido (o plugin não é registrado)`);
  const uses = [...text.matchAll(/tauri_plugin_opener(?:::(\w+))?/g)];
  if (rel !== 'opener.rs') {
    if (uses.length > 0) fail(`src/${rel}: tauri_plugin_opener só pode aparecer em src/opener.rs`);
    continue;
  }
  if (uses.length === 0) fail('src/opener.rs: sem tauri_plugin_opener::open_url');
  for (const use of uses) {
    if (use[1] !== 'open_url')
      fail(`src/opener.rs: só tauri_plugin_opener::open_url é permitido (achado: ${use[0]})`);
  }
  for (const banned of ['open_path', 'reveal_item_in_dir'])
    if (text.includes(banned))
      fail(`src/opener.rs: ${banned} é proibido (só URLs, nunca caminhos)`);
}

// ---- r7 R-I8.2 (variante N): LanguageTool só em loopback:8081, sem proxy, sem redirecionamento ----
const ltDir = new URL('src/languagetool/', tauriDir);
const ltMod = existsSync(new URL('mod.rs', ltDir))
  ? readFileSync(new URL('mod.rs', ltDir), 'utf8')
  : '';
for (const needle of LT_REQUIRED) {
  if (!ltMod.includes(needle)) fail(`src/languagetool/mod.rs: sem ${needle} (R-I8.2)`);
}
if (existsSync(ltDir)) {
  for (const file of rustFiles(ltDir)) {
    // Só o código: sem comentários (o `://` dentro de literais fica) e sem o `mod tests`, que sobe
    // servidores em portas efêmeras. Qualquer literal com `://` que não seja o formato montado das
    // constantes reprova (host textual, IP fora do loopback, outra porta; SN-SEC-04).
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .split(/^#\[cfg\(test\)\]\s*\nmod tests\b/m)[0];
    for (const [literal] of code.matchAll(/"[^"\n]*:\/\/[^"\n]*"/g)) {
      if (literal !== LT_URL_FORMAT)
        fail(
          `src/languagetool/${file.href.slice(ltDir.href.length)}: URL textual proibida (${literal}); só ${LT_URL_FORMAT}`,
        );
    }
  }
}

// ---- r36a (AC-R36-1, R21-RS-02, D-R36-2): comandos do vault fora das threads do runtime ----
// Todo `#[tauri::command]` de `src/vault/**`, de `src/spell/**` (r34: o corretor calcula e lê as
// camadas, e o `spell_reload` resolve o token) e de `src/save_targets.rs` faz o diálogo, a E/S, o
// cálculo e a resolução do token (o 1º uso de uma pendente derruba a pasta anterior e para o
// observador dela com `join`) numa thread de bloqueio. No corpo — até o `}` que fecha o dele, sem
// comentários, testes nem literais de string, raw string ou caractere (um `"blocking("` não conta),
// lido numa passada só como o lexer do Rust (`rustSource`; AppSec r37b item 3) —: ao menos uma
// chamada `blocking(` (o `vault::blocking`; `spawn_blocking(` direto não conta) ou `.with_root(`;
// toda chamada dessas seguida de `.await` (sem ele o job nem roda); o job delas (o argumento de
// `blocking(`, o 2º de `.with_root(`) é uma closure, `|…|` ou `move |…|` (r37b, review r36a NB1: um
// bloco `{ …; move |_| … }` ou um helper chamado na hora rodam na thread do runtime antes de
// devolver o job); e a E/S e o `.root(` (`RUNTIME_IO`) só dentro dessa closure (code review r36a
// NB-2, AppSec N6: a E/S inline ao lado de um `.with_root(`, ou no argumento do token, reprova),
// também com outro nome por um `use` ou dentro de um helper desses arquivos (r41a, AppSec r37b
// NB 1). Todo comando registrado como `vault::*`, `spell::*` ou `save_targets::*` precisa ser
// achado e conferido aqui: um formato que a expressão não reconhece reprova em vez de passar calado.
const COMMAND =
  /#\[tauri::command(?:\([^)]*\))?\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/g;
/** Chamada que leva o job a uma thread de bloqueio: `blocking(` livre ou com caminho, `.with_root(`. */
const OFF_RUNTIME_CALL = /(?<![\w.])blocking\(|\.with_root\(/g;
/** O job de uma `OFF_RUNTIME_CALL`: uma closure, nada antes dela. */
const CLOSURE_JOB = /^\s*(?:move\s+)?\|/;
/**
 * O que só pode aparecer dentro do job de uma `OFF_RUNTIME_CALL`: a resolução do token (`.root(`)
 * e a E/S — `ops::`, `fs::` (`std::fs::*` também), `File::`, `OpenOptions::`, o `dir::`/`Dir::`
 * da busca e os métodos de `Path`/`PathBuf` que vão ao disco, chamados no valor
 * (`Path::new(…).metadata()`; AppSec r37b item 3) ou pelo caminho (`Path::read_dir(p)`,
 * `.map(Path::exists)`; r41a) —, com espaço entre as partes ou não (`std::fs ::metadata`).
 */
const RUNTIME_IO =
  /\b(?:ops|fs|File|OpenOptions|dir|Dir)\s*::|\.\s*root\s*\(|\.\s*(?:metadata|symlink_metadata|canonicalize|read_dir|read_link|try_exists|exists|is_file|is_dir|is_symlink)\s*\(|(?:\b\w+\s*)?::\s*(?:metadata|symlink_metadata|canonicalize|read_dir|read_link|try_exists|exists|is_file|is_dir|is_symlink)\b/g;
/** Módulos de E/S num `use`: o `fs` (de `std`, `tokio`, `std::os::*`), o `ops` do vault e o `dir` da busca. */
const IO_MODULES = new Set(['fs', 'ops', 'dir']);
/** Tipos desses módulos que abrem arquivo ou pasta. */
const IO_TYPES = new Set(['File', 'OpenOptions', 'DirBuilder', 'Dir']);
/** Um `use` no código, até o `;`. */
const USE = /\buse\s+([^;]*);/g;
/** Identificador, o que vem antes dele (`.` ou `::`) e se vem `::` depois (sem consumir). */
const IDENTIFIER = /(\.|::)?\s*\b([A-Za-z_]\w*)(?=(\s*::)?)/g;
/** Chamada pelo nome, livre, por um caminho ou de método: `nome(`. */
const CALL = /\b([A-Za-z_]\w*)\s*\(/g;
/** Começo de um `impl` ou de um `trait` (atributos, `pub`, `unsafe`). */
const ITEM_HEAD = /^(?:\s|#\[[^\]]*\])*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?(impl|trait)\b/;
/** No cabeçalho de um `impl`: `<`, `>` (a seta `->` à parte), `for` e `where`. */
const HEAD_TOKEN = /->|[<>]|\b(?:for|where)\b/g;
/**
 * Bloco de um `impl Trait for Tipo` ou de um `trait`: os métodos dele são chamados pelo trait. O
 * `for` do `impl Trait for` vem fora de `<…>`, antes do `where` e sem `<` logo depois: o `for<'a>`
 * de um bound (`impl<F> X<F> where F: for<'a> Fn(&'a str)`) é de um `impl` próprio (code review
 * r41a NB1).
 */
const traitBlock = (block) => {
  const head = ITEM_HEAD.exec(block);
  if (!head) return false;
  if (head[1] === 'trait') return true;
  let depth = 0;
  HEAD_TOKEN.lastIndex = head.index + head[0].length;
  for (let token = HEAD_TOKEN.exec(block); token; token = HEAD_TOKEN.exec(block)) {
    if (token[0] === '<') depth++;
    else if (token[0] === '>') depth--;
    else if (token[0] === '->' || depth > 0) continue;
    else if (token[0] === 'where') return false;
    else if (!/^\s*</.test(block.slice(HEAD_TOKEN.lastIndex))) return true;
  }
  return false;
};
const FN_NAME = /fn\s+(\w+)/y;
/** Índice da 1ª vírgula fora de `()`, `[]` e `{}` em `[from, to)`; sem ela, `to`. */
const topLevelComma = (code, from, to) => {
  let depth = 0;
  for (let i = from; i < to; i++) {
    if ('([{'.includes(code[i])) depth++;
    else if (')]}'.includes(code[i])) depth--;
    else if (code[i] === ',' && depth === 0) return i;
  }
  return to;
};
/**
 * O que de `body` roda na thread de quem chama: sem o job de cada `OFF_RUNTIME_CALL` (o argumento
 * de `blocking(`; em `.with_root(`, o que vem depois do token, que conta como código da thread do
 * runtime). Com cada chamada: se o job é uma closure e se há `.await` depois dela.
 */
const runtimeCode = (body) => {
  let code = '';
  let from = 0;
  const calls = [];
  for (const call of body.matchAll(OFF_RUNTIME_CALL)) {
    if (call.index < from) continue; // dentro do job de outra chamada
    const open = call.index + call[0].length - 1;
    const close = closing(body, open);
    const job = call[0] === '.with_root(' ? topLevelComma(body, open + 1, close) + 1 : open + 1;
    calls.push({
      call: call[0],
      closure: CLOSURE_JOB.test(body.slice(job, close)),
      awaited: /^\s*\.await\b/.test(body.slice(close + 1)),
    });
    code += body.slice(from, job);
    from = close;
  }
  return { code: code + body.slice(from), calls };
};
/** Os itens de uma árvore de `use` (`a::{b as c, d::{self, *}}`): `[caminho, nome local]`. */
const useItems = (tree) => {
  const tokens = tree.match(/::|[{},*]|\w+/g) ?? [];
  const items = [];
  let at = 0;
  const walk = (prefix) => {
    const path = [...prefix];
    while (at < tokens.length) {
      const token = tokens[at++];
      if (token === '::') continue;
      if (token === '{') {
        do walk(path);
        while (tokens[at++] === ',');
        return;
      }
      if (token === ',' || token === '}') {
        at--;
        return;
      }
      if (token === '*') return void items.push([path, '*']);
      path.push(token);
      if (tokens[at] === 'as') {
        items.push([path, tokens[at + 1]]);
        at += 2;
        return;
      }
      if (tokens[at] !== '::')
        return void items.push([path, token === 'self' ? path.at(-2) : token]);
    }
  };
  walk([]);
  return items;
};
/**
 * O que os `use` de um arquivo trazem de E/S com outro nome (r41a; AppSec r37b NB 1): `paths`, os
 * módulos e tipos de E/S renomeados (`use std::fs as f` → `f::`, `File as Fh` → `Fh::`); `fns`, as
 * funções desses módulos trazidas pelo nome (`use std::fs::read_to_string`, `ops::{read_capped}`);
 * `glob`, um `*` de um deles (não dá para saber o que entra).
 */
const ioImports = (code) => {
  const paths = new Set();
  const fns = new Set();
  let glob = false;
  for (const [, tree] of code.matchAll(USE))
    for (const [path, local] of useItems(tree)) {
      const segments = path.filter((segment) => segment !== 'self');
      const [item, parent] = [segments.at(-1), segments.at(-2)];
      if (local === '*') glob ||= IO_MODULES.has(item);
      else if (IO_MODULES.has(item) || (IO_MODULES.has(parent) && IO_TYPES.has(item))) {
        if (local !== item) paths.add(local);
      } else if (IO_MODULES.has(parent) && /^[a-z_]/.test(item)) fns.add(local);
    }
  return { paths, fns, glob };
};
/** A E/S em `code` (o que roda numa thread) de um arquivo com os `imports` dele. */
const ioIn = (code, imports) => {
  const found = new Set([...code.matchAll(RUNTIME_IO)].map(([io]) => io.replace(/\s+/g, '')));
  for (const [, before, name, after] of code.matchAll(IDENTIFIER)) {
    if (after && before !== '.' && imports.paths.has(name)) found.add(`${name}::`);
    else if (!before && imports.fns.has(name)) found.add(name);
  }
  return found;
};
/** Cada `fn` com corpo de `code`: o nome, o corpo `{…}` e o cabeçalho do bloco em volta. */
const fnItems = (code) => {
  const items = [];
  const blocks = [];
  let start = 0; // depois do último `;`, `{` ou `}`
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '{') {
      blocks.push(code.slice(start, i));
      start = i + 1;
    } else if (code[i] === '}') {
      blocks.pop();
      start = i + 1;
    } else if (code[i] === ';') start = i + 1;
    else if (code[i] === 'f' && !WORD_CHAR.test(code[i - 1] ?? '')) {
      FN_NAME.lastIndex = i;
      const fn = FN_NAME.exec(code);
      const braces = fn && fnBraces(code, FN_NAME.lastIndex);
      if (braces)
        items.push({
          name: fn[1],
          block: blocks.at(-1) ?? '',
          body: code.slice(braces[0], braces[1] + 1),
        });
    }
  }
  return items;
};
const guarded = rustFiles(srcDir)
  .map((file) => ({ rel: file.href.slice(srcDir.href.length), file }))
  .filter(
    ({ rel }) => rel.startsWith('vault/') || rel.startsWith('spell/') || rel === 'save_targets.rs',
  )
  .map(({ rel, file }) => {
    const { code } = rustSource(file);
    return { rel, code, imports: ioImports(code) };
  });
// Helpers com E/S (r41a; AppSec r37b NB 1): as funções e os métodos próprios desses arquivos (não os
// de um `impl Trait for` nem os de um `trait`, que o trait chama) com E/S no que roda na thread de
// quem os chama, direto ou chamando pelo nome outro helper que faz. Nome → onde.
const helpers = guarded.flatMap(({ rel, code, imports }) =>
  fnItems(code)
    .filter(({ block }) => !traitBlock(block))
    .map(({ name, body }) => ({ name, rel, code: runtimeCode(body).code, imports })),
);
const ioHelpers = new Map();
for (const { name, rel, code, imports } of helpers)
  if (!ioHelpers.has(name) && ioIn(code, imports).size > 0) ioHelpers.set(name, `src/${rel}`);
for (let grew = true; grew;) {
  grew = false;
  for (const { name, rel, code } of helpers) {
    if (ioHelpers.has(name)) continue;
    const callee = [...code.matchAll(CALL)].find(([, called]) => ioHelpers.has(called));
    if (callee === undefined) continue;
    ioHelpers.set(name, `src/${rel}, por ${callee[1]}`);
    grew = true;
  }
}
const offRuntime = [];
for (const { rel, code, imports } of guarded) {
  if (imports.glob)
    fail(
      `src/${rel}: use com * de fs, ops ou dir: a guarda não sabe o que ele traz (AC-R36-1; r41a)`,
    );
  for (const command of code.matchAll(COMMAND)) {
    const name = command[1];
    offRuntime.push(name);
    const braces = fnBraces(code, command.index + command[0].length);
    const { code: outside, calls } = runtimeCode(
      braces ? code.slice(braces[0], braces[1] + 1) : '',
    );
    for (const { call, closure, awaited } of calls) {
      if (!closure)
        fail(
          `src/${rel}: comando ${name} com ${call} cujo job não é uma closure (|…| ou move |…|): o que vem antes dela roda na thread do runtime (AC-R36-1)`,
        );
      if (!awaited)
        fail(`src/${rel}: comando ${name} com ${call} sem .await (o job não roda; AC-R36-1)`);
    }
    if (!calls.some(({ awaited }) => awaited))
      fail(
        `src/${rel}: comando ${name} sem blocking( nem .with_root( (E/S na thread do runtime; AC-R36-1)`,
      );
    const leaked = [...ioIn(outside, imports)];
    if (leaked.length > 0)
      fail(
        `src/${rel}: comando ${name} com ${leaked.join(' ')} fora da closure de blocking( ou .with_root( (E/S ou token na thread do runtime; AC-R36-1)`,
      );
    const called = new Set(
      [...outside.matchAll(CALL)].map(([, helper]) => helper).filter((h) => ioHelpers.has(h)),
    );
    for (const helper of called)
      fail(
        `src/${rel}: comando ${name} chama ${helper}( fora da closure de blocking( ou .with_root(, e ${helper} faz E/S (${ioHelpers.get(helper)}; AC-R36-1, r41a)`,
      );
  }
}
for (const entry of handler.split(',').map((s) => s.trim())) {
  const name = /^(?:vault|spell|save_targets)::(?:\w+::)*(\w+)$/.exec(entry)?.[1];
  if (name !== undefined && !offRuntime.includes(name))
    fail(
      `lib.rs: ${entry} não foi achado como comando em src/vault/**, src/spell/** nem em src/save_targets.rs (AC-R36-1)`,
    );
}

// ---- r34 (AC-R34-1; AppSec r34 N3, code review r34 NB-6): o corretor não fala com a rede ----
// No código de `src/spell/**` (sem comentários nem os `mod` de teste, lido como o lexer do Rust:
// um `"/*"` num literal não esconde nada; r41a), e no conteúdo dos literais dele, nenhuma menção a
// cliente ou socket (`reqwest`, `TcpStream`, `TcpListener`, `UdpSocket`, `ToSocketAddrs`,
// `tauri_plugin_http`), aos módulos de rede (`std::net`, `tokio::net`) nem aos do app que falam com
// a rede (`crate::ai`, `crate::languagetool`, também por `super::`), inclusive dentro de um `use`
// agrupado (`std::{io, net}`), e nenhum `://`: o motor só calcula e lê as camadas pelo
// `vault::dictionaries`; o dicionário base vem embutido no binário.
// Cada módulo é `<raiz>::<nome>`, também num `use` agrupado (`<raiz>::{…, <nome>…}`, até o `;`),
// escrito como literal (CI semgrep: `detect-non-literal-regexp`).
const SPELL_NETWORK = [
  ['reqwest', /reqwest/],
  ['TcpStream', /TcpStream/],
  ['TcpListener', /TcpListener/],
  ['UdpSocket', /UdpSocket/],
  ['ToSocketAddrs', /ToSocketAddrs/],
  ['tauri_plugin_http', /tauri_plugin_http/],
  ['std::net', /\bstd::(?:\{[^;]*?\b)?net\b/],
  ['tokio::net', /\btokio::(?:\{[^;]*?\b)?net\b/],
  ['crate::ai', /\b(?:crate|super)::(?:\{[^;]*?\b)?ai\b/],
  ['crate::languagetool', /\b(?:crate|super)::(?:\{[^;]*?\b)?languagetool\b/],
  ['://', /:\/\//],
];
/** Uma string no código (o conteúdo em branco entre as aspas); o texto dela sai do original. */
const STRING_LITERAL = /"\s*"/g;
const spellDir = new URL('src/spell/', tauriDir);
for (const file of existsSync(spellDir) ? rustFiles(spellDir) : []) {
  const rel = file.href.slice(srcDir.href.length);
  const { text, code } = rustSource(file);
  const literals = [...code.matchAll(STRING_LITERAL)].map(({ 0: blanked, index }) =>
    text.slice(index, index + blanked.length),
  );
  const scanned = [code, ...literals].join('\n');
  for (const [needle, pattern] of SPELL_NETWORK)
    if (pattern.test(scanned))
      fail(`src/${rel}: ${needle} no corretor (nada sai pela rede; AC-R34-1)`);
}

if (problems.length > 0) {
  console.error(`check:security — ${problems.length} problema(s):`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log(
  `check:security — OK: CSP definida, ${identifiers.length} capability(ies) sem escopo estático de fs, ` +
    'sem plugin fs nem permissões fs/diálogo no webview, sem shell/process (opener só pela função ' +
    "Rust open_url), script-src 'self' blob:, navegação/janelas novas bloqueadas, " +
    `connect-src ${CONNECT_SRC} (inalterado), assetProtocol e drag-and-drop desligados.`,
);
console.log(`  comandos do app (${APP_COMMANDS.length}): ${APP_COMMANDS.join(', ')}`);
console.log(`  csp: ${EXPECTED_CSP}`);
console.log(`  devCsp: ${EXPECTED_DEV_CSP}`);
console.log(
  '  LanguageTool (variante N): só 127.0.0.1:8081 → [::1]:8081 pelo Rust, sem proxy nem redirecionamento',
);
console.log(
  `  comandos de chave (AC-11.5, nenhum devolve a chave): ${Object.keys(KEY_COMMAND_RETURNS)
    .map((name) => `${name} → ${commandSignatures.get(name)}`)
    .join('; ')}`,
);
console.log(
  `  ai_send (AI_SEND_GATE, r31): ${AI_SEND_GATE.join(' + ')} no código; Transport::prepare e o ` +
    `Admit sem portão só sob ${PREPARE_CFG} (fixtures fora do default); evento do contador ${usageEvent}`,
);
console.log(
  `  E/S fora do runtime (AC-R36-1): ${offRuntime.length} comandos de src/vault/**, src/spell/** e ` +
    'save_targets.rs com blocking( ou .with_root( + .await, job sempre uma closure (|…| ou ' +
    'move |…|); ops::, fs::, File::, OpenOptions::, dir::, .root( e a E/S de Path só dentro dela, ' +
    'também com outro nome por use ou num helper com E/S (sem comentários nem literais, raw ' +
    'strings inclusive)',
);
console.log(
  `  corretor (r34): src/spell/** sem ${SPELL_NETWORK.map(([needle]) => needle).join(', ')} no código (nada sai pela rede)`,
);
console.log(
  `  core:* = event listen/unlisten, window destroy, webview print; ` +
    'WebRTC: WebView2 args + guarded WKPreferences; ' +
    `overlays: ${overlays.join(', ') || 'nenhum'} (bundle only)`,
);
console.log(
  `  capabilities: ${identifiers.join(', ')} (${join('apps', 'desktop', 'src-tauri', 'capabilities')})`,
);
