#!/usr/bin/env node
// B-01 (assinatura do Windows, CR3-R1): o instalador nsis do Windows (o único publicado, decisão do
// r5) leva byte a byte o exe esperado. No release.yml, `SIMPLEMD_SIGNED_EXE_SHA256` traz o sha256 do
// exe que o `sign-windows-exe` conferiu (assinado pelo SignPath na rodada 1), e o `simplemd.exe` de
// `target/release` também tem de ser ele; sem a variável, vale o de `target/release`. Só funciona com
// `tauri bundle --no-binary-patching`: sem isso o Tauri grava o tipo do pacote no exe do instalador,
// o que muda os bytes e quebra a assinatura. Extrai o exe do instalador com o 7-Zip e compara o
// sha256. Só Windows.
// Uso: [SIMPLEMD_SIGNED_EXE_SHA256=<hex>] node scripts/assert-installer-embeds-exe.mjs [target/release]
//      (padrão: apps/desktop/src-tauri/target/release)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const EXE = 'simplemd.exe';
const release = resolve(process.argv[2] ?? 'apps/desktop/src-tauri/target/release');
const SEVEN_ZIP = join(process.env.ProgramFiles ?? 'C:\\Program Files', '7-Zip', '7z.exe');

const fail = (message) => {
  console.error(`assert-installer-embeds-exe: ${message}`);
  process.exit(1);
};
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

if (process.platform !== 'win32') fail('só roda no Windows (7-Zip)');
const exe = join(release, EXE);
if (!existsSync(exe)) fail(`${exe} não existe (rode o build de release antes)`);
const signed = process.env.SIMPLEMD_SIGNED_EXE_SHA256;
if (signed !== undefined && !/^[0-9a-f]{64}$/.test(signed))
  fail(`SIMPLEMD_SIGNED_EXE_SHA256 inválido: "${signed}" (esperado o sha256 em hex minúsculo)`);
const local = sha256(exe);
const want = signed ?? local;
if (local !== want) fail(`${exe} (${local}) não é o exe que o sign-windows-exe conferiu (${want})`);
const expected = signed === undefined ? `o ${EXE} de target/release` : 'o exe do sign-windows-exe';
const nsisDir = join(release, 'bundle', 'nsis');
const found = existsSync(nsisDir)
  ? readdirSync(nsisDir).filter((name) => name.endsWith('-setup.exe'))
  : [];
if (found.length !== 1) fail(`${nsisDir}: esperado 1 *-setup.exe, achados ${found.length}`);
const nsis = join(nsisDir, found[0]);

// As falhas são juntadas e reportadas depois do finally: process.exit não roda o finally.
const problems = [];
const work = mkdtempSync(join(tmpdir(), 'smd-installer-'));
try {
  const seven = spawnSync(SEVEN_ZIP, ['x', nsis, `-o${work}`, '-y'], { encoding: 'utf8' });
  if (seven.error || seven.status !== 0)
    problems.push(
      `7-Zip falhou (${seven.error?.message ?? `código ${seven.status}`})\n` +
        `${seven.stdout ?? ''}${seven.stderr ?? ''}`.trim(),
    );
  const copies = readdirSync(work, { recursive: true })
    .filter((rel) => basename(rel).toLowerCase() === EXE)
    .map((rel) => join(work, rel));
  if (copies.length !== 1) {
    problems.push(`${basename(nsis)}: esperado 1 ${EXE}, achados ${copies.length}`);
  } else {
    const got = sha256(copies[0]);
    console.log(`  ${basename(nsis)}: ${EXE} ${got}`);
    if (got !== want)
      problems.push(`${basename(nsis)}: o ${EXE} de dentro (${got}) não é ${expected}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (problems.length > 0) fail(problems.join('\n'));
console.log(
  `assert-installer-embeds-exe — OK: ${basename(nsis)} leva ${expected} byte a byte ` +
    `(sha256 ${want}).`,
);
