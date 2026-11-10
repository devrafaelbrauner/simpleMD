#!/usr/bin/env node
// CR4-W01-4: o `simplemd.exe` de RELEASE leva os argumentos do WebView2 de release (`WEBVIEW2_ARGS`
// de webview_net.rs) uma vez, nenhuma `--force-…` e não leva os de dev (`WEBVIEW2_DEV_ARGS`) isolados.
// Os de dev são prefixo dos de release: uma ocorrência deles conta só onde os de release não começam.
// Uso: node scripts/assert-webview2-args.mjs [binário]
//      (padrão: apps/desktop/src-tauri/target/release/simplemd[.exe])
import { existsSync, readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../apps/desktop/src-tauri/src/webview_net.rs', import.meta.url),
  'utf8',
);
const RELEASE_RE = /const WEBVIEW2_ARGS: &str =\s*"((?:[^"\\]|\\[\s\S])*)"/;
const DEV_RE = /const WEBVIEW2_DEV_ARGS: &str =\s*"((?:[^"\\]|\\[\s\S])*)"/;
const constant = (re) => (re.exec(source)?.[1] ?? '').replace(/\\\n\s*/g, '');
const release = constant(RELEASE_RE);
const dev = constant(DEV_RE);
if (!release || !dev) {
  console.error(
    'assert-webview2-args: WEBVIEW2_ARGS/WEBVIEW2_DEV_ARGS não lidos de webview_net.rs',
  );
  process.exit(1);
}
const fallback = `apps/desktop/src-tauri/target/release/simplemd${process.platform === 'win32' ? '.exe' : ''}`;
const binary = process.argv[2] ?? fallback;
if (!existsSync(binary)) {
  console.error(`assert-webview2-args: ${binary} não existe (rode o build de release antes)`);
  process.exit(1);
}
const bytes = readFileSync(binary);
const offsets = (text) => {
  const needle = Buffer.from(text, 'utf8');
  const found = [];
  for (let at = bytes.indexOf(needle); at !== -1; at = bytes.indexOf(needle, at + 1))
    found.push(at);
  return found;
};
const releaseAt = offsets(release);
const forceAt = offsets('--force-');
const devAt = offsets(dev).filter((at) => !releaseAt.includes(at));
const problems = [];
if (releaseAt.length !== 1)
  problems.push(`WEBVIEW2_ARGS ${releaseAt.length} vez(es), esperado 1: "${release}"`);
if (forceAt.length > 0) problems.push(`"--force-" nos bytes ${forceAt.join(', ')}`);
if (devAt.length > 0) problems.push(`WEBVIEW2_DEV_ARGS isolado nos bytes ${devAt.join(', ')}`);
if (problems.length > 0) {
  console.error(`assert-webview2-args: ${binary}:`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log(
  `assert-webview2-args — OK: ${binary} (${bytes.length} bytes), WEBVIEW2_ARGS 1 vez no byte ${releaseAt[0]}, 0 "--force-", 0 WEBVIEW2_DEV_ARGS isolado.`,
);
