// r3 (AC-B01.6, AC-B06.5, AC-B12.6, AC-B12.14), r4 (AC-W01.7), r7 (AC-X7.6, AC-X7.7, AC-I8.2),
// r32a (AC-R32A-3), r36a (AC-R36-1), r33a (AC-R33-3), r37b (AC-R37B-3) e r34 (AC-R34-1, AC-R34-3):
// o portão `scripts/check-tauri-security.mjs` (parte de `pnpm check:security`) aprova o repositório
// com os 35
// comandos e a CSP inteira de R-X7.7 e reprova, numa cópia alterada, cada regressão:
// núcleo do Tauri além da lista mínima, WebView2 sem a política de WebRTC, sem o proxy morto, com a
// `--force-…` do r3, com os argumentos de dev na release ou sem os padrões do wry, preferência do
// WebKit sem guarda, janela fora do `harden`, overlay com chaves de app/identificador, entitlements
// que desmontam o hardened runtime; r7: CSP com fonte nova, opener registrado/fora da função livre,
// pacote JS do opener em qualquer package.json, inventário fora do lugar e LanguageTool fora de
// loopback:8081; r36a: comando de `src/vault/**`/`save_targets.rs` com E/S na thread do runtime;
// r33a: `dict_import`/`dict_manage` fora de um dos três lugares ou com E/S, token ou diálogo fora do
// `blocking(`/`.with_root(`; r37b: `vault_search_text`/`vault_search_cancel` fora de um dos três
// lugares ou com a E/S fora da closure, e o job que não é closure (review r36a NB1); AppSec r37b
// item 3: E/S escondida depois de uma raw string ou de um `"/*"`/`"//"` num literal, e a E/S de
// `Path` fora da closure; r34: `spell_*` fora de um dos três lugares, com cálculo ou token fora do
// `blocking(` e o corretor (`src/spell/**`) falando com a rede (clientes, sockets, `std::net`,
// `tokio::net`, `tauri_plugin_http`, `crate::ai`, `crate::languagetool`, `://`); r41a: o
// `AI_SEND_GATE` no código (literal, `mod t {}` vazio ou fechado fora da coluna 0, `"/*"`),
// `Transport::prepare` fora do `cfg(test)`/feature `fixtures`, a feature ligada no app, o TS do
// contador ausente, e a E/S do vault com outro nome (`use … as`, função trazida pelo `use`, `*`),
// pelo caminho (`Path::read_dir(p)`), com espaço (`fs ::`), pelo `dir::` ou num helper.
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
  // O TS do contador da IA: com o pacote do app, o portão exige que ele exista (r41a).
  'apps/desktop/src/platform/tauri/aiTransport.ts',
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
  test('o repositório passa com os 35 comandos e a lista mínima do núcleo', () => {
    const r = run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('check:security — OK');
    expect(r.stdout).toContain('comandos do app (35)');
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
    expect(r.stdout).toContain('comandos do app (35)');
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

  test('a saída OK conta os 21 comandos conferidos', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'E/S fora do runtime (AC-R36-1): 21 comandos de src/vault/**, src/spell/** e save_targets.rs com blocking( ou .with_root( + .await, job sempre uma closure (|…| ou move |…|); ops::, fs::, File::, OpenOptions::, dir::, .root( e a E/S de Path só dentro dela, também com outro nome por use ou num helper com E/S (sem comentários nem literais, raw strings inclusive)',
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
        'lib.rs: vault::vault_mkdir não foi achado como comando em src/vault/**, src/spell/** nem em src/save_targets.rs',
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
    expect(r.stdout).toContain('comandos do app (35)');
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
    expect(r.stdout).toContain('comandos do app (35)');
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

// AppSec r37b item 3: a guarda lê o Rust numa passada só, como o lexer — uma raw string
// (`r#"x"y"#`), um `"/*"` ou um `"//"` num literal não escondem mais a E/S que vem depois — e
// reconhece a E/S de `Path` (`Path::new(..).metadata()`) fora da closure. Controle: o que só está
// num literal (raw string inclusive) ou num comentário aninhado, um caractere `'"'` e um tempo de
// vida não contam.
describe('check:security — r37b c1 (AppSec r37b item 3: literais do Rust e E/S de Path)', () => {
  const SEARCH = `${TAURI}/src/vault/search.rs`;
  const CANCEL =
    '    let state = state.inner().clone();\n    blocking(move || {\n        state.cancel_search(search_id);';
  const before = (code: string) => (t: string) => t.replace(CANCEL, `${code}\n${CANCEL}`);
  const LEAK =
    'src/vault/search.rs: comando vault_search_cancel com fs:: fora da closure de blocking( ou .with_root(';

  test.each([
    {
      name: 'raw string r#"x"y"# antes de std::fs::metadata (vault_search_cancel)',
      change: before('    let _ = r#"x"y"#;\n    let _ = std::fs::metadata("a");'),
      message: LEAK,
    },
    {
      name: '"/*" num literal antes de std::fs::metadata (vault_search_cancel)',
      change: before('    let _ = "/*";\n    let _ = std::fs::metadata("a");\n    let _ = "*/";'),
      message: LEAK,
    },
    {
      name: '"//" num literal na linha de std::fs::metadata (vault_search_cancel)',
      change: before('    let _ = ("//", std::fs::metadata("a"));'),
      message: LEAK,
    },
    {
      name: 'Path::new(..).metadata() fora da closure (vault_search_text)',
      change: (t: string) =>
        t.replace(
          '    let state = state.inner().clone();\n    blocking(move || search(',
          '    let _ = Path::new(&query).metadata();\n    let state = state.inner().clone();\n    blocking(move || search(',
        ),
      message:
        'src/vault/search.rs: comando vault_search_text com .metadata( fora da closure de blocking( ou .with_root(',
    },
  ])('reprova: $name', ({ change, message }) => {
    const r = run(mutated(SEARCH, change));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });

  test('passa: E/S só num literal ou num comentário aninhado; caractere e tempo de vida', () => {
    const code = [
      '    let _: &\'static str = r#"std::fs::metadata("a") blocking("#;',
      "    let _ = ('\"', '\\'', 'x');",
      '    /* /* */ std::fs::metadata("a"); */',
    ].join('\n');
    const r = run(mutated(SEARCH, before(code)));
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});

// r34 (AC-R34-1, AC-R34-3, D-R34-4): o corretor entra no inventário (32 → 35) nos três lugares, fora
// de `SECRET_READER`; os três comandos (`src/spell/mod.rs`) passam pela guarda da r36a (cálculo,
// leitura e token só na closure de `blocking(` + `.await`) e o código de `src/spell/**` não fala com
// a rede: `reqwest`, `TcpStream`, `TcpListener`, `UdpSocket`, `ToSocketAddrs`, `tauri_plugin_http`,
// `std::net`, `tokio::net`, `crate::ai`, `crate::languagetool` (também por `super::` ou num `use`
// agrupado) ou `://` reprovam (AppSec r34 N3, code review r34 NB-6); num comentário ou num teste,
// não, nem um nome que só contém um deles.
describe('check:security — r34 (corretor offline: 32 → 35)', () => {
  const SPELL = `${TAURI}/src/spell/mod.rs`;

  test('a saída OK lista os comandos do corretor e a regra sem rede', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('comandos do app (35)');
    for (const command of ['spell_check', 'spell_suggest', 'spell_reload'])
      expect(r.stdout).toContain(command);
    expect(r.stdout).toContain(
      'corretor (r34): src/spell/** sem reqwest, TcpStream, TcpListener, UdpSocket, ToSocketAddrs, tauri_plugin_http, std::net, tokio::net, crate::ai, crate::languagetool, :// no código (nada sai pela rede)',
    );
  });

  test('rede num comentário ou num teste do corretor, ou num nome que só a contém, não reprova', () => {
    const dir = mutated(SPELL, (t) =>
      t
        .replace(
          '#[cfg(test)]\nmod tests {\n',
          '// fonte: https://git.libreoffice.org/dictionaries (sem std::net nem crate::ai)\n#[cfg(test)]\nmod tests {\n    use std::net::TcpListener;\n    const _FONTE: &str = "https://git.libreoffice.org/dictionaries";\n',
        )
        .replace(
          'const LANGS: &[&str] = &["pt-BR"];',
          'const LANGS: &[&str] = &["pt-BR"];\nconst _AIM: &str = "crate::aim super::network std::netlify";',
        ),
    );
    const r = run(dir);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
  test.each([
    {
      name: 'build.rs sem spell_check',
      file: `${TAURI}/build.rs`,
      change: (t: string) => t.replace('            "spell_check",\n', ''),
      message: 'build.rs: comandos declarados',
    },
    {
      name: 'lib.rs sem spell_reload no generate_handler!',
      file: `${TAURI}/src/lib.rs`,
      change: (t: string) => t.replace('            spell::spell_reload,\n', ''),
      message: 'lib.rs: comandos registrados',
    },
    {
      name: 'capability sem allow-spell-suggest',
      file: CAPABILITY,
      change: (t: string) => t.replace('    "allow-spell-suggest",\n', ''),
      message: '≠ inventário',
    },
    {
      name: 'reqwest no corretor',
      file: SPELL,
      change: (t: string) => `${t}\nfn baixar() {\n    let _ = reqwest::Client::new();\n}\n`,
      message: 'src/spell/mod.rs: reqwest no corretor (nada sai pela rede; AC-R34-1)',
    },
    {
      name: 'URL textual no corretor',
      file: SPELL,
      change: (t: string) =>
        t.replace(
          'const LANGS: &[&str] = &["pt-BR"];',
          'const LANGS: &[&str] = &["pt-BR"];\nconst _FONTE: &str = "https://dicionario.example/pt_BR.dic";',
        ),
      message: 'src/spell/mod.rs: :// no corretor',
    },
    {
      name: 'TcpStream no corretor',
      file: SPELL,
      change: (t: string) =>
        t.replace(
          'use std::hint::black_box;',
          'use std::hint::black_box;\nuse std::net::TcpStream;',
        ),
      message: 'src/spell/mod.rs: TcpStream no corretor',
    },
    {
      name: 'UdpSocket no corretor',
      file: SPELL,
      change: (t: string) =>
        t.replace(
          'use std::hint::black_box;',
          'use std::hint::black_box;\nuse std::net::UdpSocket;',
        ),
      message: 'src/spell/mod.rs: UdpSocket no corretor',
    },
    {
      name: 'TcpListener no corretor',
      file: SPELL,
      change: (t: string) =>
        `${t}\nfn ouvir() -> usize {\n    std::mem::size_of::<std::net::TcpListener>()\n}\n`,
      message: 'src/spell/mod.rs: TcpListener no corretor',
    },
    {
      name: 'ToSocketAddrs no corretor',
      file: SPELL,
      change: (t: string) =>
        t.replace(
          'use std::hint::black_box;',
          'use std::hint::black_box;\nuse std::net::ToSocketAddrs as _;',
        ),
      message: 'src/spell/mod.rs: ToSocketAddrs no corretor',
    },
    {
      name: 'std::net num use agrupado do corretor',
      file: SPELL,
      change: (t: string) =>
        t.replace('use std::hint::black_box;', 'use std::{hint::black_box, net::Ipv4Addr};'),
      message: 'src/spell/mod.rs: std::net no corretor',
    },
    {
      name: 'tokio::net no corretor',
      file: SPELL,
      change: (t: string) =>
        `${t}\nfn resolver() {\n    let _ = tokio::net::lookup_host("localhost:80");\n}\n`,
      message: 'src/spell/mod.rs: tokio::net no corretor',
    },
    {
      name: 'tauri_plugin_http no corretor',
      file: SPELL,
      change: (t: string) =>
        `${t}\nfn baixar() {\n    let _ = tauri_plugin_http::init::<tauri::Wry>();\n}\n`,
      message: 'src/spell/mod.rs: tauri_plugin_http no corretor',
    },
    {
      name: 'crate::ai num use agrupado do corretor',
      file: SPELL,
      change: (t: string) =>
        t.replace('use crate::error::AppError;', 'use crate::{ai as _, error::AppError};'),
      message: 'src/spell/mod.rs: crate::ai no corretor',
    },
    {
      name: 'crate::languagetool por super:: no corretor',
      file: SPELL,
      change: (t: string) =>
        t.replace(
          'use crate::error::AppError;',
          'use crate::error::AppError;\nuse super::languagetool::LtState as _;',
        ),
      message: 'src/spell/mod.rs: crate::languagetool no corretor',
    },
    {
      name: 'spell_check conferindo na thread do runtime',
      file: SPELL,
      change: (t: string) =>
        t.replace(
          '            blocking(move || spell.check(generation, &words, LIMITS.check)).await\n',
          '            spell.check(generation, &words, LIMITS.check)\n',
        ),
      message: 'src/spell/mod.rs: comando spell_check sem blocking( nem .with_root(',
    },
    {
      name: 'spell_reload resolvendo o token fora da closure',
      file: SPELL,
      change: (t: string) =>
        t.replace(
          '    let ticket = spell.next_reload();\n',
          '    let ticket = spell.next_reload();\n    let _ = token.map(|token| vault.root(token));\n',
        ),
      message:
        'src/spell/mod.rs: comando spell_reload com .root( fora da closure de blocking( ou .with_root(',
    },
    {
      name: 'spell_suggest com blocking( sem .await (o job nem roda)',
      file: SPELL,
      change: (t: string) =>
        t.replace(
          '            blocking(move || spell.suggest(generation, &word, LIMITS.check)).await\n',
          '            let _ = blocking(move || spell.suggest(generation, &word, LIMITS.check));\n            Ok(Vec::new())\n',
        ),
      message: 'src/spell/mod.rs: comando spell_suggest com blocking( sem .await',
    },
    {
      name: 'comando registrado em spell:: que a guarda não acha',
      file: SPELL,
      change: (t: string) =>
        t.replace('pub async fn spell_suggest(', 'pub async fn spell_suggest_feito('),
      message:
        'lib.rs: spell::spell_suggest não foi achado como comando em src/vault/**, src/spell/** nem em src/save_targets.rs',
    },
  ])('reprova: $name', ({ file, change, message }) => {
    const r = run(mutated(file, change));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });
});

// r41a (R31-PREPARE-CFG; AppSec r31 R1-1/R1-2, code review r31 NB-R1-1..3): o `AI_SEND_GATE` lido
// como o lexer do Rust — um literal não satisfaz o portão, e um `mod t {}` vazio, um `mod` fechado
// fora da coluna 0 ou um `"/*"` num literal não escondem o código que vem depois (aqui, no corretor,
// onde a regra é de ausência) —; `Transport::prepare` só sob `cfg(test)`/feature `fixtures` (o
// doctest `compile_fail` de `transport.rs` prova a compilação), a feature nunca ligada no app; o
// nome do evento sai do literal da declaração do código; o TS do contador ausente reprova.
describe('check:security — r41a (AI_SEND_GATE no código; Transport::prepare por compilação)', () => {
  const AI_MOD = `${TAURI}/src/ai/mod.rs`;
  const SPELL = `${TAURI}/src/spell/mod.rs`;
  const TS = 'apps/desktop/src/platform/tauri/aiTransport.ts';
  const REQWEST = '\nfn baixar() {\n    let _ = reqwest::Client::new();\n}\n';

  test('a saída OK descreve o portão no código e o prepare só sob o cfg', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      `ai_send (AI_SEND_GATE, r31): session: State<'_, Arc<SessionGate>> + prepare_admitted( + .record( + .emit_to( + USAGE_EVENT no código; Transport::prepare e o Admit sem portão só sob #[cfg(any(test, feature = "fixtures"))] (fixtures fora do default); evento do contador ai-usage`,
    );
  });

  test.each([
    {
      name: 'R1-1: prepare_admitted( só num literal não satisfaz o portão',
      file: AI_MOD,
      change: (t: string) =>
        t.replace(
          'transport.prepare_admitted(&req, &*gate)',
          'let _ = (&gate, "prepare_admitted(");\n        transport.prepare(&req)',
        ),
      message: 'ai/mod.rs: ai_send sem prepare_admitted( (AI_SEND_GATE, r31)',
    },
    {
      name: 'NB-R1-1: um mod t {} vazio não engole o código que vem depois',
      file: SPELL,
      change: (t: string) => `${t}\n#[cfg(test)]\nmod t {}\n${REQWEST}`,
      message: 'src/spell/mod.rs: reqwest no corretor (nada sai pela rede; AC-R34-1)',
    },
    {
      name: 'R1-2 M12: um mod de teste fechado fora da coluna 0 não engole o que vem depois',
      file: SPELL,
      change: (t: string) => `${t}\n#[cfg(test)]\nmod t {\n    }\n${REQWEST}`,
      message: 'src/spell/mod.rs: reqwest no corretor (nada sai pela rede; AC-R34-1)',
    },
    {
      name: 'AppSec r37b NB 2: "/*" num literal não esconde o código do corretor',
      file: SPELL,
      change: (t: string) =>
        `${t}\nfn baixar() {\n    let _ = "/*";\n    let _ = reqwest::Client::new();\n    let _ = "*/";\n}\n`,
      message: 'src/spell/mod.rs: reqwest no corretor (nada sai pela rede; AC-R34-1)',
    },
    {
      name: 'Transport::prepare sem o #[cfg] (o app compilaria o pedido sem portão)',
      file: `${TAURI}/src/ai/transport.rs`,
      change: (t: string) => t.replace('    #[cfg(any(test, feature = "fixtures"))]\n', ''),
      message:
        'ai/transport.rs: Transport::prepare (sem o portão de sessão) fora de #[cfg(any(test, feature = "fixtures"))] (r41a)',
    },
    {
      name: 'AppSec r41a NB1: o NoGate (Admit que não pergunta) sem o #[cfg]',
      file: `${TAURI}/src/ai/transport.rs`,
      change: (t: string) =>
        t.replace(
          '#[cfg(any(test, feature = "fixtures"))]\nimpl Admit for NoGate {',
          'impl Admit for NoGate {',
        ),
      message:
        'ai/transport.rs: impl Admit for NoGate (portão de sessão que não pergunta) fora de #[cfg(any(test, feature = "fixtures"))] (r41a)',
    },
    {
      name: 'AppSec r41a NB1: Admit genérico para closures (o &|_| Ok(()) voltaria a compilar)',
      file: `${TAURI}/src/ai/transport.rs`,
      change: (t: string) =>
        t.replace(
          'impl sealed::Sealed for SessionGate {}\n',
          'impl sealed::Sealed for SessionGate {}\nimpl<F: Fn(&Checked) -> Result<(), AppError>> sealed::Sealed for F {}\n',
        ),
      message:
        'ai/transport.rs: impl Sealed for F (portão de sessão que não pergunta) fora de #[cfg(any(test, feature = "fixtures"))] (r41a)',
    },
    {
      name: 'a feature fixtures ligada pelo default, por outra feature',
      file: `${TAURI}/Cargo.toml`,
      change: (t: string) =>
        t.replace(
          'fixtures = []',
          'default = ["gravador"]\ngravador = ["fixtures"]\nfixtures = []',
        ),
      message:
        'Cargo.toml: a feature fixtures (Transport::prepare sem o portão) ligada pelo default (r41a)',
    },
    {
      name: 'a feature fixtures no build.features do tauri.conf.json',
      file: `${TAURI}/tauri.conf.json`,
      change: (t: string) => t.replace('"build": {', '"build": {\n    "features": ["fixtures"],'),
      message:
        'tauri.conf.json: build.features liga fixtures (Transport::prepare sem o portão; r41a)',
    },
    {
      name: 'o nome do evento sai da declaração do código, não de um literal que a imita',
      file: `${TAURI}/src/ai/session.rs`,
      change: (t: string) =>
        t.replace(
          'pub const USAGE_EVENT: &str = "ai-usage";',
          'const _DOC: &str = r#"pub const USAGE_EVENT: &str = "ai-usage";"#;\npub const USAGE_EVENT: &str = "ai-usage-2";',
        ),
      message: 'aiTransport.ts escuta ai-usage; o Rust emite ai-usage-2 (AI_SEND_GATE, r31)',
    },
    {
      name: 'M13: o TS escuta outro evento',
      file: TS,
      change: (t: string) => t.replace("listen<AiUsage>('ai-usage'", "listen<AiUsage>('ai-uso'"),
      message: 'aiTransport.ts escuta ai-uso; o Rust emite ai-usage (AI_SEND_GATE, r31)',
    },
  ])('reprova: $name', ({ file, change, message }) => {
    const r = run(mutated(file, change));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });

  test('reprova: NB-R1-3 o TS do contador movido não pula a conferência calado', () => {
    const dir = mutated(TS, (t) => `${t}\n`);
    rmSync(join(dir, TS));
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'apps/desktop/src/platform/tauri/aiTransport.ts ausente: o evento do contador não foi conferido (AI_SEND_GATE, r31)',
    );
  });
});

// r41a (R37B-GUARDA-ALIAS; AppSec r37b NB 1): a E/S do vault fora da closure também reprova com outro
// nome por um `use` (`use std::fs as f`, `use std::fs::read_to_string`, `File as Fh`), pelo caminho
// (`Path::read_dir(p)`, `Path::exists(p)`), com espaço antes do `::`, pelo `dir::` da busca e dentro
// de um helper (função ou método próprio, direto ou por outro helper); um `use std::fs::*` também.
// Controle: o helper e o alias só dentro da closure, e um método de `impl Trait for` com o nome de
// uma chamada (o `drop` de `replace.rs` e o `drop(busy)` de `dict_import`, no repositório), passam.
describe('check:security — r41a (E/S do vault com outro nome, pelo caminho ou num helper)', () => {
  const SEARCH = `${TAURI}/src/vault/search.rs`;
  const CANCEL =
    '    let state = state.inner().clone();\n    blocking(move || {\n        state.cancel_search(search_id);';
  const COMMAND = '/// Cancela a busca `search_id` se for a atual';
  const USES = 'use std::fs::Metadata;\n';
  /**
   * `uses` no topo, `items` antes do comando e `code` no começo do corpo de `vault_search_cancel`.
   * Cada âncora tem de existir: sem ela a alteração sumiria calada e o teste viraria vácuo (code
   * review r41a NB3).
   */
  const around =
    ({ uses = '', items = '', code = '' }) =>
    (t: string) => {
      for (const anchor of [USES, COMMAND, CANCEL]) expect(t).toContain(anchor);
      return t
        .replace(USES, `${USES}${uses}`)
        .replace(COMMAND, `${items}${COMMAND}`)
        .replace(CANCEL, `${code}${CANCEL}`);
    };
  const HELPER = 'fn espiar(rel: &str) -> bool {\n    Path::new(rel).exists()\n}\n\n';
  const leak = (found: string) =>
    `src/vault/search.rs: comando vault_search_cancel com ${found} fora da closure de blocking( ou .with_root(`;

  test.each([
    {
      name: 'use std::fs as f; f::read(…)',
      change: around({ uses: 'use std::fs as f;\n', code: '    let _ = f::read("a.md");\n' }),
      message: leak('f::'),
    },
    {
      name: 'use std::fs::read_to_string; read_to_string(…)',
      change: around({
        uses: 'use std::fs::read_to_string;\n',
        code: '    let _ = read_to_string("a.md");\n',
      }),
      message: leak('read_to_string'),
    },
    {
      name: 'use std::fs::File as Fh; Fh::open(…)',
      change: around({
        uses: 'use std::fs::File as Fh;\n',
        code: '    let _ = Fh::open("a.md");\n',
      }),
      message: leak('Fh::'),
    },
    {
      name: 'Path::read_dir(p) pelo caminho',
      change: around({ code: '    let _ = Path::read_dir(Path::new("."));\n' }),
      message: leak('Path::read_dir'),
    },
    {
      name: 'Path::exists(p) pelo caminho',
      change: around({ code: '    let _ = Path::exists(Path::new("a.md"));\n' }),
      message: leak('Path::exists'),
    },
    {
      name: 'std::fs ::metadata (espaço antes do ::)',
      change: around({ code: '    let _ = std::fs ::metadata("a.md");\n' }),
      message: leak('fs::'),
    },
    {
      name: 'dir::Dir::open_root(…) da busca',
      change: around({ code: '    let _ = dir::Dir::open_root(Path::new("."));\n' }),
      message: leak('dir:: Dir::'),
    },
    {
      name: 'helper com E/S chamado fora da closure',
      change: around({ items: HELPER, code: '    let _ = espiar("a.md");\n' }),
      message:
        'src/vault/search.rs: comando vault_search_cancel chama espiar( fora da closure de blocking( ou .with_root(, e espiar faz E/S (src/vault/search.rs; AC-R36-1, r41a)',
    },
    {
      name: 'helper sem E/S que chama um helper com E/S',
      change: around({
        items: `fn olhar(rel: &str) -> bool {\n    espiar(rel)\n}\n\n${HELPER}`,
        code: '    let _ = olhar("a.md");\n',
      }),
      message:
        'src/vault/search.rs: comando vault_search_cancel chama olhar( fora da closure de blocking( ou .with_root(, e olhar faz E/S (src/vault/search.rs, por espiar; AC-R36-1, r41a)',
    },
    {
      name: 'método próprio com E/S chamado fora da closure',
      change: around({
        items:
          'impl VaultState {\n    fn raiz_existe(&self) -> bool {\n        Path::new(".").exists()\n    }\n}\n\n',
        code: '    let _ = state.raiz_existe();\n',
      }),
      message: 'src/vault/search.rs: comando vault_search_cancel chama raiz_existe(',
    },
    {
      name: "code review r41a NB1 (P1): método de impl próprio com for<'a> no where",
      change: around({
        items:
          'struct Filtro<F>(F);\n\nimpl<F> Filtro<F>\nwhere\n    F: for<\'a> Fn(&\'a str) -> bool,\n{\n    fn raiz_existe(&self) -> bool {\n        Path::new(".").exists()\n    }\n}\n\n',
        code: '    let _ = Filtro(|_: &str| true).raiz_existe();\n',
      }),
      message: 'src/vault/search.rs: comando vault_search_cancel chama raiz_existe(',
    },
    {
      name: "método de impl próprio com for<'a> no bound do genérico",
      change: around({
        items:
          'struct Filtro<F>(F);\n\nimpl<F: for<\'a> Fn(&\'a str) -> bool> Filtro<F> {\n    fn raiz_existe(&self) -> bool {\n        Path::new(".").exists()\n    }\n}\n\n',
        code: '    let _ = Filtro(|_: &str| true).raiz_existe();\n',
      }),
      message: 'src/vault/search.rs: comando vault_search_cancel chama raiz_existe(',
    },
    {
      name: 'use std::fs::* (não dá para saber o que entra)',
      change: around({ uses: 'use std::fs::*;\n' }),
      message: 'src/vault/search.rs: use com * de fs, ops ou dir',
    },
  ])('reprova: $name', ({ change, message }) => {
    const r = run(mutated(SEARCH, change));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });

  test('passa: helper e alias de E/S só dentro da closure', () => {
    const INSIDE = '        state.cancel_search(search_id);';
    const change = (t: string) => {
      const prepared = around({ uses: 'use std::fs as f;\n', items: HELPER })(t);
      expect(prepared).toContain(INSIDE);
      return prepared.replace(
        INSIDE,
        `        let _ = (espiar("a.md"), f::read("a.md"));\n${INSIDE}`,
      );
    };
    const r = run(mutated(SEARCH, change));
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  test("passa: método de impl Trait for com for<'a> no where (o trait o chama)", () => {
    const change = around({
      items:
        'struct Filtro<F>(F);\n\nimpl<F> Drop for Filtro<F>\nwhere\n    F: for<\'a> Fn(&\'a str) -> bool,\n{\n    fn drop(&mut self) {\n        let _ = Path::new(".").exists();\n    }\n}\n\n',
      code: '    drop(Filtro(|_: &str| true));\n',
    });
    const r = run(mutated(SEARCH, change));
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
