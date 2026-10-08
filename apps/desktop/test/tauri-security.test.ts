// r3 (AC-B01.6, AC-B06.5, AC-B12.6, AC-B12.14) e r4 (AC-W01.7): o portão
// `scripts/check-tauri-security.mjs` (parte de `pnpm check:security`) aprova o repositório com os
// 21 comandos e reprova, numa cópia alterada, cada regressão: núcleo do Tauri além da lista mínima,
// WebView2 sem a política de WebRTC, sem o proxy morto, com a `--force-…` do r3, com os argumentos
// de dev na release ou sem os padrões do wry, preferência do WebKit sem guarda, janela fora do
// `harden`, overlay com chaves de app/identificador e entitlements que desmontam o hardened runtime.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const ROOT = join(__dirname, '../../..');
const SCRIPT = join(ROOT, 'scripts/check-tauri-security.mjs');
const TAURI = 'apps/desktop/src-tauri';
const FILES = [
  'apps/desktop/package.json',
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
  test('o repositório passa com os 21 comandos e a lista mínima do núcleo', () => {
    const r = run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('check:security — OK');
    expect(r.stdout).toContain('comandos do app (21)');
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
