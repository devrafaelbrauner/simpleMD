// r3 (AC-B01.6, AC-B06.5, AC-B12.6, AC-B12.14), r4 (AC-W01.7), r7 (AC-X7.6, AC-X7.7, AC-I8.2),
// r32a (AC-R32A-3), r36a (AC-R36-1), r33a (AC-R33-3) e r37b (AC-R37B-3): o portão
// `scripts/check-tauri-security.mjs` (parte de `pnpm check:security`) aprova o repositório com os 32
// comandos e a CSP inteira de R-X7.7 e reprova, numa cópia alterada, cada regressão:
// núcleo do Tauri além da lista mínima, WebView2 sem a política de WebRTC, sem o proxy morto, com a
// `--force-…` do r3, com os argumentos de dev na release ou sem os padrões do wry, preferência do
// WebKit sem guarda, janela fora do `harden`, overlay com chaves de app/identificador, entitlements
// que desmontam o hardened runtime; r7: CSP com fonte nova, opener registrado/fora da função livre,
// pacote JS do opener em qualquer package.json, inventário fora do lugar e LanguageTool fora de
// loopback:8081; r36a: comando de `src/vault/**`/`save_targets.rs` com E/S na thread do runtime;
// r33a: `dict_import`/`dict_manage` fora de um dos três lugares ou com E/S, token ou diálogo fora do
// `blocking(`/`.with_root(`; r37b: `vault_search_text`/`vault_search_cancel` fora de um dos três
// lugares ou com a E/S fora da closure, e o job que não é closure (review r36a NB1).
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const ROOT = join(__dirname, '../../..');
const SCRIPT = join(ROOT, 'scripts/check-tauri-security.mjs');
const TAURI = 'apps/desktop/src-tauri';
/** Todos os package.json do workspace (raiz, apps/*, packages/*): o portão lê todos (r7 §1.5). */
const MANIFESTS = [
  'package.json',
  ...['apps', 'packages'].flatMap((group) =>
    readdirSync(join(ROOT, group))
      .map((name) => `${group}/${name}/package.json`)
      .filter((manifest) => existsSync(join(ROOT, manifest))),
  ),
];
const FILES = [
  ...MANIFESTS,
  `${TAURI}/tauri.conf.json`,
  `${TAURI}/tauri.release.conf.json`,
  `${TAURI}/Entitlements.plist`,
  `${TAURI}/Cargo.toml`,
  `${TAURI}/build.rs`,
  `${TAURI}/capabilities`,
  `${TAURI}/src`,
];

const run = (root?: string) =>
  spawnSync(process.execPath, root ? [SCRIPT, root] : [SCRIPT], { encoding: 'utf8' });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Cópia dos arquivos conferidos com uma alteração em `file`. */
function mutated(file: string, change: (text: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), 'smd-tauri-gate-'));
  dirs.push(dir);
  for (const name of FILES) cpSync(join(ROOT, name), join(dir, name), { recursive: true });
  const target = join(dir, file);
  const before = readFileSync(target, 'utf8');
  const after = change(before);
  expect(after).not.toBe(before);
  writeFileSync(target, after);
  return dir;
}

const CAPABILITY = `${TAURI}/capabilities/main-window.json`;
const WEBVIEW_NET = `${TAURI}/src/webview_net.rs`;
const OVERLAY = `${TAURI}/tauri.release.conf.json`;

describe('check:security — Tauri (r3: R2-08, B-06, B-01)', () => {
  test('o repositório passa com os 32 comandos e a lista mínima do núcleo', () => {
    const r = run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('check:security — OK');
    expect(r.stdout).toContain('comandos do app (32)');
    expect(r.stdout).toContain(
      'core:* = event listen/unlisten, window destroy, webview print; WebRTC: WebView2 args + guarded WKPreferences; overlays: tauri.release.conf.json (bundle only)',
    );
  });

  test('a cópia sem alteração também passa (o portão lê a raiz recebida)', () => {
    const dir = mutated(`${TAURI}/build.rs`, (t) => `${t}\n`);
    expect(run(dir).status).toBe(0);
  });

  test.each([
    {
      name: 'core:default de volta (AC-B12.6)',
      file: CAPABILITY,
      change: (t: string) => t.replace('"permissions": [', '"permissions": [\n    "core:default",'),
      message: 'permissão do núcleo fora da lista mínima: core:default',
    },
    {
      name: 'core:menu:default (um plugin trocaria o menu do app)',
      file: CAPABILITY,
      change: (t: string) =>
        t.replace('"permissions": [', '"permissions": [\n    "core:menu:default",'),
      message: 'permissão do núcleo fora da lista mínima: core:menu:default',
    },
    {
      name: 'WebView2 com a --force-… do r3 no lugar da política (F-WIN-01)',
      file: WEBVIEW_NET,
      change: (t: string) =>
        t.replace(
          '--webrtc-ip-handling-policy=disable_non_proxied_udp \\\n--proxy-server',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp \\\n--proxy-server',
        ),
      message: 'WEBVIEW2_ARGS sem --webrtc-ip-handling-policy=disable_non_proxied_udp',
    },
    {
      name: 'a --force-… do r3 é proibida (F-WIN-01)',
      file: WEBVIEW_NET,
      change: (t: string) =>
        t.replace(
          '--webrtc-ip-handling-policy=disable_non_proxied_udp \\\n--proxy-server',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp \\\n--proxy-server',
        ),
      message: '--force-webrtc-ip-handling-policy não tem efeito no WebView2 (F-WIN-01)',
    },
    {
      name: 'WebView2 sem --proxy-bypass-list=<-loopback> (W-01)',
      file: WEBVIEW_NET,
      change: (t: string) => t.replace(' --proxy-bypass-list=<-loopback>";', '";'),
      message: 'WEBVIEW2_ARGS sem --proxy-bypass-list=<-loopback>',
    },
    {
      name: 'WebView2 sem o proxy morto --proxy-server (W-01)',
      file: WEBVIEW_NET,
      change: (t: string) =>
        t.replace(
          '--proxy-server=http://127.0.0.1:9 --proxy-bypass-list=<-loopback>";',
          '--proxy-bypass-list=<-loopback>";',
        ),
      message: 'WEBVIEW2_ARGS sem --proxy-server=http://127.0.0.1:9',
    },
    {
      name: 'release e dev trocados na escolha dos argumentos (W-01)',
      file: WEBVIEW_NET,
      change: (t: string) =>
        t.replace(
          'if dev {\n        WEBVIEW2_DEV_ARGS\n    } else {\n        WEBVIEW2_ARGS\n    }',
          'if dev {\n        WEBVIEW2_ARGS\n    } else {\n        WEBVIEW2_DEV_ARGS\n    }',
        ),
      message: 'webview2_args deve ser if dev { WEBVIEW2_DEV_ARGS } else { WEBVIEW2_ARGS }',
    },
    {
      name: 'argumentos de dev fixos no harden (W-01)',
      file: WEBVIEW_NET,
      change: (t: string) => t.replace('webview2_args(tauri::is_dev())', 'webview2_args(true)'),
      message: 'WebView2 sem additional_browser_args(webview2_args(tauri::is_dev()))',
    },
    {
      name: 'WEBVIEW2_DEV_ARGS sem a política de WebRTC (W-01)',
      file: WEBVIEW_NET,
      change: (t: string) =>
        t.replace(
          'msSmartScreenProtection \\\n--webrtc-ip-handling-policy=disable_non_proxied_udp";',
          'msSmartScreenProtection";',
        ),
      message: 'WEBVIEW2_DEV_ARGS sem --webrtc-ip-handling-policy=disable_non_proxied_udp',
    },
    {
      name: 'harden com webview2_args(true) e a chamada certa num comentário (CR4-W01-1)',
      file: WEBVIEW_NET,
      change: (t: string) =>
        t.replace(
          '    let builder = builder.additional_browser_args(webview2_args(tauri::is_dev()));',
          '    // let builder = builder.additional_browser_args(webview2_args(tauri::is_dev()));\n' +
            '    let builder = builder.additional_browser_args(webview2_args(true));',
        ),
      message: 'WebView2 sem additional_browser_args(webview2_args(tauri::is_dev()))',
    },
    {
      name: 'harden com WEBVIEW2_DEV_ARGS e a chamada certa num comentário (SG-2)',
      file: WEBVIEW_NET,
      change: (t: string) =>
        t.replace(
          '    let builder = builder.additional_browser_args(webview2_args(tauri::is_dev()));',
          '    /* additional_browser_args(webview2_args(tauri::is_dev())) */\n' +
            '    let builder = builder.additional_browser_args(WEBVIEW2_DEV_ARGS);',
        ),
      message: 'WebView2 sem additional_browser_args(webview2_args(tauri::is_dev()))',
    },
    {
      name: 'switch repetido no fim de WEBVIEW2_ARGS reabre o canal (SG-1)',
      file: WEBVIEW_NET,
      change: (t: string) =>
        t.replace(
          '--proxy-bypass-list=<-loopback>";',
          '--proxy-bypass-list=<-loopback> --proxy-bypass-list=*";',
        ),
      message: 'WEBVIEW2_ARGS deve ser exatamente',
    },
    {
      name: 'a --force-… depois de um #[cfg(test)] que não é o mod tests (CR4-W01-2)',
      file: WEBVIEW_NET,
      change: (t: string) =>
        t.replace(
          'use tauri::{AppHandle, Wry};\n',
          'use tauri::{AppHandle, Wry};\n#[cfg(test)]\nconst _X: u8 = 0;\n' +
            'const _Y: &str = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";\n',
        ),
      message: '--force-webrtc-ip-handling-policy não tem efeito no WebView2 (F-WIN-01)',
    },
    {
      name: 'WebView2 sem um padrão do wry (msSmartScreenProtection)',
      file: WEBVIEW_NET,
      change: (t: string) => t.replace('msPdfOOUI,msSmartScreenProtection \\', 'msPdfOOUI \\'),
      message: 'WEBVIEW2_ARGS sem msSmartScreenProtection',
    },
    {
      name: 'preferência do WebKit sem a guarda respondsToSelector (AC-B06.5)',
      file: WEBVIEW_NET,
      change: (t: string) =>
        t.replace('prefs.respondsToSelector(sel!(_setPeerConnectionEnabled:))', 'true'),
      message: '_setPeerConnectionEnabled: ausente ou sem a guarda respondsToSelector antes',
    },
    {
      name: 'janela principal fora do harden',
      file: `${TAURI}/src/lib.rs`,
      change: (t: string) => t.replace('webview_net::harden(builder)', 'builder'),
      message: 'lib.rs: a janela principal não passa por webview_net::harden(',
    },
    {
      name: 'overlay com chave de app (AC-B01.6)',
      file: OVERLAY,
      change: (t: string) => t.replace('{\n  "bundle"', '{\n  "app": {},\n  "bundle"'),
      message: 'tauri.release.conf.json: overlay só pode ter bundle/version (achado: app)',
    },
    {
      name: 'overlay com outro identifier (AC-B01.6)',
      file: OVERLAY,
      change: (t: string) => t.replace('{\n  "bundle"', '{\n  "identifier": "x.y",\n  "bundle"'),
      message: 'tauri.release.conf.json: identifier diferente do base (x.y)',
    },
    {
      name: 'entitlement proibido (AC-B01.5)',
      file: `${TAURI}/Entitlements.plist`,
      change: (t: string) =>
        t.replace(
          '<dict/>',
          '<dict>\n  <key>com.apple.security.cs.disable-library-validation</key>\n  <true/>\n</dict>',
        ),
      message:
        'Entitlements.plist: chave proibida com.apple.security.cs.disable-library-validation',
    },
    {
      name: 'hardened runtime desligado no overlay de release',
      file: OVERLAY,
      change: (t: string) => t.replace('"hardenedRuntime": true', '"hardenedRuntime": false'),
      message: 'tauri.release.conf.json: bundle.macOS.hardenedRuntime deve ser true',
    },
    {
      name: 'overlay de release sem o THIRD-PARTY-LICENSES.txt nos recursos (r8, R-R8-1.6)',
      file: OVERLAY,
      change: (t: string) =>
        t.replace(
          ',\n      "../../../build/third-party/THIRD-PARTY-LICENSES.txt": "THIRD-PARTY-LICENSES.txt"',
          '',
        ),
      message:
        'tauri.release.conf.json: bundle.resources deve levar ../../../build/third-party/THIRD-PARTY-LICENSES.txt como THIRD-PARTY-LICENSES.txt',
    },
    {
      name: 'overlay de release com o NOTICES fora da raiz de recursos (r8, R-R8-1.6)',
      file: OVERLAY,
      change: (t: string) =>
        t.replace(
          '"../../../THIRD-PARTY-NOTICES.md": "THIRD-PARTY-NOTICES.md"',
          '"../../../THIRD-PARTY-NOTICES.md": "docs/THIRD-PARTY-NOTICES.md"',
        ),
      message:
        'tauri.release.conf.json: bundle.resources deve levar ../../../THIRD-PARTY-NOTICES.md como THIRD-PARTY-NOTICES.md',
    },
    {
      name: 'overlay de release com um recurso além da atribuição (r8, CR-R8-05)',
      file: OVERLAY,
      change: (t: string) =>
        t.replace(
          '"../../../THIRD-PARTY-NOTICES.md": "THIRD-PARTY-NOTICES.md",',
          '"../../../THIRD-PARTY-NOTICES.md": "THIRD-PARTY-NOTICES.md",\n      "../../../.env": ".env",',
        ),
      message:
        'tauri.release.conf.json: bundle.resources só pode ter a atribuição (achado: ../../../.env)',
    },
    {
      name: 'overlay de release com recurso de nome herdado do protótipo (r8, AS-R8-07)',
      file: OVERLAY,
      change: (t: string) =>
        t.replace(
          '"../../../THIRD-PARTY-NOTICES.md": "THIRD-PARTY-NOTICES.md",',
          '"../../../THIRD-PARTY-NOTICES.md": "THIRD-PARTY-NOTICES.md",\n      "constructor": "constructor",',
        ),
      message:
        'tauri.release.conf.json: bundle.resources só pode ter a atribuição (achado: constructor)',
    },
    {
      name: 'tauri.conf.json base com bundle.resources (r8, D-R8-S03)',
      file: `${TAURI}/tauri.conf.json`,
      change: (t: string) =>
        t.replace(
          '"active": false,',
          '"active": false,\n    "resources": { "../../../THIRD-PARTY-NOTICES.md": "THIRD-PARTY-NOTICES.md" },',
        ),
      message: 'tauri.conf.json: bundle.resources só no overlay tauri.release.conf.json (D-R8-S03)',
    },
  ])('reprova: $name', ({ file, change, message }) => {
    const r = run(mutated(file, change));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });
});

const CONF = `${TAURI}/tauri.conf.json`;
const LT_MOD = `${TAURI}/src/languagetool/mod.rs`;

describe('check:security — r7 (AC-X7.6, AC-X7.7, AC-I8.2)', () => {
  test('a saída OK lista a CSP inteira de csp e devCsp (só img-src ganhou blob:)', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "  csp: default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; font-src 'self'; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'",
    );
    expect(r.stdout).toContain(
      "  devCsp: default-src 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; font-src 'self'; connect-src ipc: http://ipc.localhost ws://localhost:1420 http://localhost:1420; object-src 'none'; base-uri 'none'",
    );
    for (const command of ['open_url', 'vault_read_image', 'lt_languages', 'lt_check', 'lt_cancel'])
      expect(r.stdout).toContain(command);
  });

  test.each([
    {
      name: 'data: em img-src da csp (AC-X7.7)',
      file: CONF,
      change: (t: string) =>
        t.replace(
          "img-src 'self' blob:; font-src 'self'; connect-src ipc: http://ipc.localhost;",
          "img-src 'self' blob: data:; font-src 'self'; connect-src ipc: http://ipc.localhost;",
        ),
      message: 'tauri.conf.json: csp difere da esperada (R-X7.7)',
    },
    {
      name: 'data: em img-src da devCsp (AC-X7.7)',
      file: CONF,
      change: (t: string) =>
        t.replace(
          "img-src 'self' blob:; font-src 'self'; connect-src ipc: http://ipc.localhost ws:",
          "img-src 'self' blob: data:; font-src 'self'; connect-src ipc: http://ipc.localhost ws:",
        ),
      message: 'tauri.conf.json: devCsp difere da esperada (R-X7.7)',
    },
    {
      name: "'unsafe-eval' na csp (AC-X7.7)",
      file: CONF,
      change: (t: string) =>
        t.replace(
          "script-src 'self' blob:; style-src",
          "script-src 'self' blob: 'unsafe-eval'; style-src",
        ),
      message: "CSP de produção não pode ter 'unsafe-eval'",
    },
    {
      name: 'connect-src com o LanguageTool (variante W, recusada na N; AC-X7.7, AC-I8.2)',
      file: CONF,
      change: (t: string) =>
        t.replace(
          'connect-src ipc: http://ipc.localhost;',
          'connect-src ipc: http://ipc.localhost http://127.0.0.1:8081;',
        ),
      message: 'connect-src da CSP mudou',
    },
    {
      name: 'capability com opener:default (AC-X7.6)',
      file: CAPABILITY,
      change: (t: string) =>
        t.replace('"permissions": [', '"permissions": [\n    "opener:default",'),
      message: 'plugin proibido: opener:default',
    },
    {
      name: 'capability com shell:allow-open (AC-X7.6)',
      file: CAPABILITY,
      change: (t: string) =>
        t.replace('"permissions": [', '"permissions": [\n    "shell:allow-open",'),
      message: 'plugin proibido: shell:allow-open',
    },
    {
      name: 'capability com allow-foo fora do inventário',
      file: CAPABILITY,
      change: (t: string) => t.replace('"allow-lt-cancel"', '"allow-lt-cancel",\n    "allow-foo"'),
      message: '≠ inventário',
    },
    {
      name: 'build.rs sem lt_cancel',
      file: `${TAURI}/build.rs`,
      change: (t: string) => t.replace('            "lt_cancel",\n', ''),
      message: 'build.rs: comandos declarados',
    },
    {
      name: 'plugin do opener registrado em lib.rs (AC-X7.6)',
      file: `${TAURI}/src/lib.rs`,
      change: (t: string) =>
        t.replace(
          '.plugin(tauri_plugin_dialog::init())',
          '.plugin(tauri_plugin_dialog::init())\n        .plugin(tauri_plugin_opener::init())',
        ),
      message: 'lib.rs: o plugin opener não pode ser registrado nem usado',
    },
    {
      name: 'open_path em opener.rs (AC-X7.6)',
      file: `${TAURI}/src/opener.rs`,
      change: (t: string) =>
        t.replace(
          'tauri_plugin_opener::open_url(url, None::<&str>)',
          'tauri_plugin_opener::open_path(url, None::<&str>)',
        ),
      message: 'src/opener.rs: só tauri_plugin_opener::open_url é permitido',
    },
    {
      name: 'tauri_plugin_opener fora de opener.rs',
      file: `${TAURI}/src/error.rs`,
      change: (t: string) => `${t}\n#[allow(unused_imports)]\nuse tauri_plugin_opener::open_url;\n`,
      message: 'src/error.rs: tauri_plugin_opener só pode aparecer em src/opener.rs',
    },
    {
      name: 'crate do opener com features no Cargo.toml',
      file: `${TAURI}/Cargo.toml`,
      change: (t: string) =>
        t.replace(
          'tauri-plugin-opener = "2.7"',
          'tauri-plugin-opener = { version = "2.7", features = ["x"] }',
        ),
      message: 'Cargo.toml: tauri-plugin-opener só como',
    },
    {
      name: 'tauri-plugin-shell no Cargo.toml',
      file: `${TAURI}/Cargo.toml`,
      change: (t: string) => t.replace('url = "2.5"', 'url = "2.5"\ntauri-plugin-shell = "2"'),
      message: 'Cargo.toml: dependência proibida tauri-plugin-shell',
    },
    {
      name: '@tauri-apps/plugin-opener em packages/core/package.json (AC-X7.6)',
      file: 'packages/core/package.json',
      change: (t: string) =>
        t.replace(
          '"dependencies": {',
          '"dependencies": {\n    "@tauri-apps/plugin-opener": "2.5.0",',
        ),
      message: 'packages/core/package.json: dependência proibida @tauri-apps/plugin-opener',
    },
    {
      name: '@tauri-apps/plugin-opener no package.json da raiz',
      file: 'package.json',
      change: (t: string) =>
        t.replace(
          '"devDependencies": {',
          '"devDependencies": {\n    "@tauri-apps/plugin-opener": "2.5.0",',
        ),
      message: 'package.json: dependência proibida @tauri-apps/plugin-opener',
    },
    {
      name: 'LanguageTool em outra porta (AC-I8.2)',
      file: LT_MOD,
      change: (t: string) =>
        t.replace('pub const LT_PORT: u16 = 8081;', 'pub const LT_PORT: u16 = 8082;'),
      message: 'src/languagetool/mod.rs: sem const LT_PORT: u16 = 8081',
    },
    {
      name: 'LanguageTool sem no_proxy (AC-I8.2)',
      file: LT_MOD,
      change: (t: string) => t.replace('        .no_proxy()\n', ''),
      message: 'src/languagetool/mod.rs: sem .no_proxy()',
    },
    {
      name: 'LanguageTool seguindo redirecionamentos (AC-I8.2)',
      file: LT_MOD,
      change: (t: string) =>
        t.replace('.redirect(Policy::none())', '.redirect(Policy::limited(3))'),
      message: 'src/languagetool/mod.rs: sem Policy::none()',
    },
    {
      name: 'LanguageTool com host textual (AC-I8.2)',
      file: `${TAURI}/src/languagetool/transport.rs`,
      change: (t: string) =>
        t.replace(
          'let url = format!("http://{addr}{}", call.path);',
          'let url = format!("http://localhost:8081{}", call.path);',
        ),
      message: 'URL textual proibida ("http://localhost:8081{}")',
    },
    {
      name: 'LanguageTool com constante de host externo (SN-SEC-04)',
      file: `${TAURI}/src/languagetool/transport.rs`,
      change: (t: string) =>
        t.replace(
          'use bytes::Bytes;',
          'use bytes::Bytes;\nconst _X: &str = "http://evil.example:8081";',
        ),
      message: 'URL textual proibida ("http://evil.example:8081")',
    },
    {
      name: 'LanguageTool com IP fora do loopback (SN-SEC-04)',
      file: LT_MOD,
      change: (t: string) =>
        t.replace(
          'pub const LT_PORT: u16 = 8081;',
          'pub const LT_PORT: u16 = 8081;\nconst _Y: &str = "http://10.0.0.5:8081";',
        ),
      message: 'URL textual proibida ("http://10.0.0.5:8081")',
    },
    {
      name: 'LanguageTool com https no formato montado (SN-SEC-04)',
      file: `${TAURI}/src/languagetool/transport.rs`,
      change: (t: string) => t.replace('format!("http://{addr}{}"', 'format!("https://{addr}{}"'),
      message: 'URL textual proibida ("https://{addr}{}")',
    },
  ])('reprova: $name', ({ file, change, message }) => {
    const r = run(mutated(file, change));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });
});

// r32a (AC-R32A-3): a camada global de dicionários entra no inventário (26 → 28) nos três lugares,
// fora de `SECRET_READER`; tirar um dos dois comandos de qualquer lugar reprova.
describe('check:security — r32a (dicionários: 26 → 28)', () => {
  test('a saída OK lista dict_global_read e dict_global_write', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('comandos do app (32)');
    for (const command of ['dict_global_read', 'dict_global_write'])
      expect(r.stdout).toContain(command);
  });

  test.each([
    {
      name: 'build.rs sem dict_global_write',
      file: `${TAURI}/build.rs`,
      change: (t: string) => t.replace('            "dict_global_write",\n', ''),
      message: 'build.rs: comandos declarados',
    },
    {
      name: 'lib.rs sem dict_global_read no generate_handler!',
      file: `${TAURI}/src/lib.rs`,
      change: (t: string) => t.replace('            vault::dictionaries::dict_global_read,\n', ''),
      message: 'lib.rs: comandos registrados',
    },
    {
      name: 'capability sem allow-dict-global-write',
      file: CAPABILITY,
      change: (t: string) => t.replace(',\n    "allow-dict-global-write"', ''),
      message: '≠ inventário',
    },
    {
      name: 'comando de dicionário com nome de leitura de segredo (AC-11.5)',
      file: `${TAURI}/src/vault/dictionaries.rs`,
      change: (t: string) =>
        t.replace('pub async fn dict_global_read(', 'pub async fn dict_global_read_secret('),
      message: 'comando com nome de leitura de segredo: dict_global_read_secret',
    },
  ])('reprova: $name', ({ file, change, message }) => {
    const r = run(mutated(file, change));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });
});

// r36a (AC-R36-1, R21-RS-02): todo comando de `src/vault/**` e `src/save_targets.rs` chama
// `blocking(` ou `.with_root(` no código, com `.await`, e só dentro da closure usa `ops::`, `fs::` e
// `.root(`. Prova negativa da guarda: a E/S de volta na thread do runtime, a chamada só num
// comentário ou num literal, `blocking(` sem `.await`, `spawn_blocking` direto, a E/S ou o token ao
// lado de um `.with_root(` (code review r36a NB-2: o mutante M1), um comando novo sem a chamada e um
// comando registrado que a guarda não acha reprovam.
describe('check:security — r36a (E/S do vault fora do runtime)', () => {
  const VAULT_MOD = `${TAURI}/src/vault/mod.rs`;

  test('a saída OK conta os 18 comandos conferidos', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'E/S do vault fora do runtime (AC-R36-1): 18 comandos de src/vault/** e save_targets.rs com blocking( ou .with_root( + .await, job sempre uma closure (|…| ou move |…|); ops::, fs:: e .root( só dentro dela',
    );
  });

  test.each([
    {
      name: 'vault_read_dir com a E/S de volta na thread do runtime',
      file: VAULT_MOD,
      change: (t: string) =>
        t.replace(
          '    state\n        .with_root(token, move |root| ops::read_dir(root, &rel))\n        .await\n',
          '    ops::read_dir(&state.root(token)?, &rel)\n',
        ),
      message: 'src/vault/mod.rs: comando vault_read_dir sem blocking( nem .with_root(',
    },
    {
      name: 'a chamada só num comentário não conta (vault_unwatch)',
      file: VAULT_MOD,
      change: (t: string) =>
        t.replace(
          '    blocking(move || {\n        state.unwatch(id);\n        Ok(())\n    })\n    .await\n',
          '    // blocking(move || …) fica para depois\n    state.unwatch(id);\n    Ok(())\n',
        ),
      message: 'src/vault/mod.rs: comando vault_unwatch sem blocking( nem .with_root(',
    },
    {
      name: 'mutante M1: vault_lstat com a E/S e o token inline antes do .with_root(',
      file: VAULT_MOD,
      change: (t: string) =>
        t.replace(
          '    state\n        .with_root(token, move |root| ops::lstat(root, &rel))',
          '    ops::lstat(&state.root(token)?, &rel)?;\n    state\n        .with_root(token, move |root| ops::lstat(root, &rel))',
        ),
      message:
        'src/vault/mod.rs: comando vault_lstat com ops:: .root( fora da closure de blocking( ou .with_root(',
    },
    {
      name: 'vault_read_file com fs:: fora da closure',
      file: VAULT_MOD,
      change: (t: string) =>
        t.replace(
          '    let bytes = state\n        .with_root(token, move |root| ops::read_file(root, &rel))',
          '    std::fs::metadata(&rel)?;\n    let bytes = state\n        .with_root(token, move |root| ops::read_file(root, &rel))',
        ),
      message:
        'src/vault/mod.rs: comando vault_read_file com fs:: fora da closure de blocking( ou .with_root(',
    },
    {
      name: 'vault_mkdir resolvendo o token fora da closure',
      file: VAULT_MOD,
      change: (t: string) =>
        t.replace(
          '    state\n        .with_root(token, move |root| ops::mkdir(root, &rel))',
          '    let _ = state.root(token)?;\n    state\n        .with_root(token, move |root| ops::mkdir(root, &rel))',
        ),
      message:
        'src/vault/mod.rs: comando vault_mkdir com .root( fora da closure de blocking( ou .with_root(',
    },
    {
      name: 'a chamada só num literal não conta (vault_unwatch)',
      file: VAULT_MOD,
      change: (t: string) =>
        t.replace(
          '    blocking(move || {\n        state.unwatch(id);\n        Ok(())\n    })\n    .await\n',
          '    println!("blocking(move || state.unwatch(id)).await");\n    state.unwatch(id);\n    Ok(())\n',
        ),
      message: 'src/vault/mod.rs: comando vault_unwatch sem blocking( nem .with_root(',
    },
    {
      name: 'blocking( sem .await: o job nem roda (vault_watch)',
      file: VAULT_MOD,
      change: (t: string) =>
        t.replace(
          '    blocking(move || state.watch(token, on_event)).await\n',
          '    let _ = blocking(move || state.watch(token, on_event));\n    Ok(0)\n',
        ),
      message: 'src/vault/mod.rs: comando vault_watch com blocking( sem .await',
    },
    {
      name: 'spawn_blocking direto no lugar de vault::blocking (dict_global_read)',
      file: `${TAURI}/src/vault/dictionaries.rs`,
      change: (t: string) =>
        t.replace(
          'blocking(move || global.read()).await;',
          'tauri::async_runtime::spawn_blocking(move || global.read())\n        .await\n        .unwrap_or_else(|_| Err(AppError::new("IO")));',
        ),
      message: 'src/vault/dictionaries.rs: comando dict_global_read sem blocking( nem .with_root(',
    },
    {
      name: 'save_target_write gravando na thread do runtime',
      file: `${TAURI}/src/save_targets.rs`,
      change: (t: string) =>
        t.replace(
          /\n {4}blocking\(move \|\| \{\n {8}let mut file[\s\S]*?\n {4}\}\)\n {4}\.await\n/,
          '\n    let mut file = OpenOptions::new().write(true).create(true).truncate(true).open(path)?;\n    file.write_all(&bytes)?;\n    Ok(())\n',
        ),
      message: 'src/save_targets.rs: comando save_target_write sem blocking( nem .with_root(',
    },
    {
      name: 'comando novo em src/vault/ sem blocking(',
      file: `${TAURI}/src/vault/image.rs`,
      change: (t: string) =>
        `${t}\n#[tauri::command]\npub async fn vault_extra(state: State<'_, VaultState>, token: u32) -> Result<Vec<u8>, AppError> {\n    ops::read_file(&state.root(token)?, "a.md")\n}\n`,
      message: 'src/vault/image.rs: comando vault_extra sem blocking( nem .with_root(',
    },
    {
      name: 'comando registrado em vault:: que a guarda não acha',
      file: VAULT_MOD,
      change: (t: string) =>
        t.replace('pub async fn vault_mkdir(', 'pub async fn vault_mkdir_feito('),
      message:
        'lib.rs: vault::vault_mkdir não foi achado como comando em src/vault/** nem em src/save_targets.rs',
    },
  ])('reprova: $name', ({ file, change, message }) => {
    const r = run(mutated(file, change));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });
});

// r33a (AC-R33-3): a importação de listas entra no inventário (28 → 30) nos três lugares, fora de
// `SECRET_READER`, e os dois comandos (`src/vault/dictionaries/import.rs`) passam pela guarda da
// r36a: diálogo, leitura, gravação e token só nas closures de `blocking(`/`.with_root(` + `.await`.
describe('check:security — r33a (listas de termos: 28 → 30)', () => {
  const IMPORT = `${TAURI}/src/vault/dictionaries/import.rs`;

  test('a saída OK lista dict_import e dict_manage', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('comandos do app (32)');
    for (const command of ['dict_import', 'dict_manage']) expect(r.stdout).toContain(command);
  });

  test.each([
    {
      name: 'build.rs sem dict_import',
      file: `${TAURI}/build.rs`,
      change: (t: string) => t.replace('            "dict_import",\n', ''),
      message: 'build.rs: comandos declarados',
    },
    {
      name: 'lib.rs sem dict_manage no generate_handler!',
      file: `${TAURI}/src/lib.rs`,
      change: (t: string) =>
        t.replace('            vault::dictionaries::import::dict_manage,\n', ''),
      message: 'lib.rs: comandos registrados',
    },
    {
      name: 'capability sem allow-dict-import',
      file: CAPABILITY,
      change: (t: string) => t.replace('    "allow-dict-import",\n', ''),
      message: '≠ inventário',
    },
    {
      name: 'dict_import lendo a fonte na thread do runtime',
      file: IMPORT,
      change: (t: string) =>
        t.replace(
          '    let busy = Busy::take(&global)?;\n',
          '    let busy = Busy::take(&global)?;\n    let _ = std::fs::metadata("lista.txt")?;\n',
        ),
      message:
        'src/vault/dictionaries/import.rs: comando dict_import com fs:: fora da closure de blocking( ou .with_root(',
    },
    {
      name: 'dict_manage resolvendo o token fora da closure',
      file: IMPORT,
      change: (t: string) =>
        t.replace(
          '    let kind = manage.kind();\n',
          '    let kind = manage.kind();\n    let _ = vault.root(token.unwrap_or(0))?;\n',
        ),
      message:
        'src/vault/dictionaries/import.rs: comando dict_manage com .root( fora da closure de blocking( ou .with_root(',
    },
    {
      name: 'dict_import com o diálogo sem .await (o job nem roda)',
      file: IMPORT,
      change: (t: string) =>
        t.replace(
          '    })\n    .await;\n    let result = match (picked, token) {',
          '    });\n    let picked: Result<Option<List>, AppError> = Ok(None);\n    let result = match (picked, token) {',
        ),
      message: 'src/vault/dictionaries/import.rs: comando dict_import com blocking( sem .await',
    },
  ])('reprova: $name', ({ file, change, message }) => {
    const r = run(mutated(file, change));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });
});

// r37b (AC-R37B-3): a busca no texto entra no inventário (30 → 32) nos três lugares e os dois
// comandos (`src/vault/search.rs`) passam pela guarda da r36a. Review r36a NB1: o job de
// `blocking(`/`.with_root(` precisa ser uma closure — um bloco (M3, M3b) ou um helper chamado na
// hora (M7) rodam na thread do runtime — e o argumento do token não esconde E/S.
describe('check:security — r37b (busca no texto: 30 → 32; job sempre closure)', () => {
  const SEARCH = `${TAURI}/src/vault/search.rs`;
  const VAULT_MOD = `${TAURI}/src/vault/mod.rs`;

  test('a saída OK lista vault_search_text e vault_search_cancel', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('comandos do app (32)');
    for (const command of ['vault_search_text', 'vault_search_cancel'])
      expect(r.stdout).toContain(command);
  });

  test.each([
    {
      name: 'build.rs sem vault_search_text',
      file: `${TAURI}/build.rs`,
      change: (t: string) => t.replace('            "vault_search_text",\n', ''),
      message: 'build.rs: comandos declarados',
    },
    {
      name: 'lib.rs sem vault_search_cancel no generate_handler!',
      file: `${TAURI}/src/lib.rs`,
      change: (t: string) => t.replace('            vault::search::vault_search_cancel,\n', ''),
      message: 'lib.rs: comandos registrados',
    },
    {
      name: 'capability sem allow-vault-search-text',
      file: CAPABILITY,
      change: (t: string) => t.replace('    "allow-vault-search-text",\n', ''),
      message: '≠ inventário',
    },
    {
      name: 'vault_search_text resolvendo o token fora da closure',
      file: SEARCH,
      change: (t: string) =>
        t.replace(
          '    let state = state.inner().clone();\n    blocking(move || search(',
          '    let _ = state.root(token)?;\n    let state = state.inner().clone();\n    blocking(move || search(',
        ),
      message:
        'src/vault/search.rs: comando vault_search_text com .root( fora da closure de blocking( ou .with_root(',
    },
    {
      name: 'vault_search_cancel sem blocking(',
      file: SEARCH,
      change: (t: string) =>
        t.replace(
          '    blocking(move || {\n        state.cancel_search(search_id);\n        Ok(())\n    })\n    .await\n',
          '    state.cancel_search(search_id);\n    Ok(())\n',
        ),
      message: 'src/vault/search.rs: comando vault_search_cancel sem blocking( nem .with_root(',
    },
    {
      name: 'NB1 M3: job de .with_root( que é um bloco (vault_read_dir)',
      file: VAULT_MOD,
      change: (t: string) =>
        t.replace(
          '.with_root(token, move |root| ops::read_dir(root, &rel))',
          '.with_root(token, {\n            let r = state.root(token)?;\n            move |_| ops::read_dir(&r, &rel)\n        })',
        ),
      message:
        'src/vault/mod.rs: comando vault_read_dir com .with_root( cujo job não é uma closure',
    },
    {
      name: 'NB1 M3b: bloco com ops:: antes da closure (vault_lstat)',
      file: VAULT_MOD,
      change: (t: string) =>
        t.replace(
          '.with_root(token, move |root| ops::lstat(root, &rel))',
          '.with_root(token, {\n            ops::lstat(Path::new("."), &rel)?;\n            move |root| ops::lstat(root, &rel)\n        })',
        ),
      message: 'src/vault/mod.rs: comando vault_lstat com .with_root( cujo job não é uma closure',
    },
    {
      name: 'NB1 M7: helper chamado na hora como job (pick_vault)',
      file: VAULT_MOD,
      change: (t: string) =>
        t.replace('blocking(move || pick_folder(&app))', 'blocking(pick_folder_now(&app)?)'),
      message: 'src/vault/mod.rs: comando pick_vault com blocking( cujo job não é uma closure',
    },
    {
      name: 'E/S no argumento do token de .with_root( (vault_mkdir)',
      file: VAULT_MOD,
      change: (t: string) =>
        t.replace(
          '.with_root(token, move |root| ops::mkdir(root, &rel))',
          '.with_root(state.root(token).map(|_| token)?, move |root| ops::mkdir(root, &rel))',
        ),
      message:
        'src/vault/mod.rs: comando vault_mkdir com .root( fora da closure de blocking( ou .with_root(',
    },
  ])('reprova: $name', ({ file, change, message }) => {
    const r = run(mutated(file, change));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });
});
