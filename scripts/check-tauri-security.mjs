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
// - `lib.rs` registrar o plugin fs;
// - Cargo.toml ou package.json do desktop dependerem de shell/process/opener, de
//   `tauri-plugin-fs` (Cargo) ou de `@tauri-apps/plugin-fs`/`plugin-dialog` (JS);
// - (AC-11.5, R-11.4) algum comando tiver nome de leitura de segredo (`get_key`, `read_key`,
//   `secret`, `password`) ou os comandos de chave devolverem algo além de `()`/`bool`;
// - (AC-11.9) o `connect-src` da CSP mudar: o tráfego de IA nunca passa pelo webview.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../apps/desktop/', import.meta.url);
const tauriDir = new URL('src-tauri/', root);
const problems = [];
const fail = (message) => problems.push(message);
const readJson = (url) => JSON.parse(readFileSync(url, 'utf8'));

const FORBIDDEN_PLUGIN = /(^|[^a-z])(shell|process|opener)([^a-z]|$)/;
const WILDCARD = /\*\*|\$HOME|^\/$/;

/** Inventário de comandos do app (arch-backend r2 §1.8). Mudar esta lista é decisão de segurança. */
const APP_COMMANDS = [
  'ai_cancel',
  'ai_send',
  'app_mark',
  'delete_key',
  'has_key',
  'open_file_pick',
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
for (const plugin of [
  'tauri-plugin-shell',
  'tauri-plugin-process',
  'tauri-plugin-opener',
  'tauri-plugin-fs',
]) {
  if (cargo.includes(plugin)) fail(`Cargo.toml: dependência proibida ${plugin}`);
}
const pkg = readJson(new URL('package.json', root));
for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
  if (/^@tauri-apps\/plugin-(shell|process|opener|fs|dialog)$/.test(name))
    fail(`package.json: dependência proibida ${name}`);
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
// R-6.25: a janela principal nasce com navegação, janelas novas e downloads bloqueados.
for (const guard of [
  '.on_navigation(',
  '.on_new_window(',
  'NewWindowResponse::Deny',
  '.on_download(',
]) {
  if (!libRs.includes(guard)) fail(`lib.rs: guarda de navegação ausente (${guard})`);
}

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

if (problems.length > 0) {
  console.error(`check:security — ${problems.length} problema(s):`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log(
  `check:security — OK: CSP definida, ${identifiers.length} capability(ies) sem escopo estático de fs, ` +
    'sem plugin fs nem permissões fs/diálogo no webview, sem shell/process/opener, ' +
    "script-src 'self' blob:, navegação/janelas novas bloqueadas, " +
    `connect-src ${CONNECT_SRC} (inalterado), assetProtocol e drag-and-drop desligados.`,
);
console.log(`  comandos do app (${APP_COMMANDS.length}): ${APP_COMMANDS.join(', ')}`);
console.log(
  `  comandos de chave (AC-11.5, nenhum devolve a chave): ${Object.keys(KEY_COMMAND_RETURNS)
    .map((name) => `${name} → ${commandSignatures.get(name)}`)
    .join('; ')}`,
);
console.log(
  `  capabilities: ${identifiers.join(', ')} (${join('apps', 'desktop', 'src-tauri', 'capabilities')})`,
);
