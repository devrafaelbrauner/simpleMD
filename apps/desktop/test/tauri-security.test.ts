// r3 (AC-B01.6, AC-B06.5, AC-B12.6, AC-B12.14), r4 (AC-W01.7) e r7 (AC-X7.6, AC-X7.7, AC-I8.2): o
// portão `scripts/check-tauri-security.mjs` (parte de `pnpm check:security`) aprova o repositório
// com os 26 comandos e a CSP inteira de R-X7.7 e reprova, numa cópia alterada, cada regressão:
// núcleo do Tauri além da lista mínima, WebView2 sem a política de WebRTC, sem o proxy morto, com a
// `--force-…` do r3, com os argumentos de dev na release ou sem os padrões do wry, preferência do
// WebKit sem guarda, janela fora do `harden`, overlay com chaves de app/identificador, entitlements
// que desmontam o hardened runtime; r7: CSP com fonte nova, opener registrado/fora da função livre,
// pacote JS do opener em qualquer package.json, inventário fora do lugar e LanguageTool fora de
// loopback:8081.
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
  test('o repositório passa com os 26 comandos e a lista mínima do núcleo', () => {
    const r = run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('check:security — OK');
    expect(r.stdout).toContain('comandos do app (26)');
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
