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
//   não passar a janela por `harden`;
// - (B-01) um overlay `tauri.*.conf.json` trouxer algo além de `bundle`/`version` (ou outro
//   `identifier`), o de release não ligar o hardened runtime com `Entitlements.plist`, ou os
//   entitlements tiverem uma chave proibida; o `has_key` do macOS ler dados do segredo.
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

/** Inventário de comandos do app (arch-backend r2 §1.8; r7 §1.5: 21 → 26). Mudar esta lista é
 *  decisão de segurança. */
const APP_COMMANDS = [
  'ai_cancel',
  'ai_send',
  'app_mark',
  'delete_key',
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
  'vault_lstat',
  'vault_mkdir',
  'vault_read_dir',
  'vault_read_file',
  'vault_read_image',
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
const webview2Args = (
  /const WEBVIEW2_ARGS: &str = "((?:[^"\\]|\\[\s\S])*)"/.exec(webviewNetCode)?.[1] ?? ''
).replace(/\\\n\s*/g, '');
// O rustfmt quebra a linha depois do `=` nesta (mais longa).
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
  if (file === 'tauri.release.conf.json') {
    if (overlay.bundle?.macOS?.hardenedRuntime !== true)
      fail(`${file}: bundle.macOS.hardenedRuntime deve ser true`);
    if (overlay.bundle?.macOS?.entitlements !== 'Entitlements.plist')
      fail(`${file}: bundle.macOS.entitlements deve ser "Entitlements.plist"`);
    if (!existsSync(new URL('Entitlements.plist', tauriDir)))
      fail(`${file}: Entitlements.plist ausente`);
  }
}
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
  `  core:* = event listen/unlisten, window destroy, webview print; ` +
    'WebRTC: WebView2 args + guarded WKPreferences; ' +
    `overlays: ${overlays.join(', ') || 'nenhum'} (bundle only)`,
);
console.log(
  `  capabilities: ${identifiers.join(', ')} (${join('apps', 'desktop', 'src-tauri', 'capabilities')})`,
);
