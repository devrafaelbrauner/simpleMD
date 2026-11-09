#!/usr/bin/env node
// `pnpm deps:fix` (r23, R21-DEPENDABOT): no branch de um PR npm do Dependabot, faz o que é mecânico
// e resume o que continua pedindo decisão humana. Nunca commita, nunca envia, nunca mexe na política
// do pnpm. Cada passo só escreve se o resultado muda (rodar de novo não muda nada):
// 0. `pnpm install --frozen-lockfile` (o pnpm 12 reaplica `minimumReleaseAge` e `trustPolicy` ao
//    lock). Falha vira pendência e encerra: nada de exceção nova nem lock regenerado;
// 1. overrides de "mesma versão do app": `pai>p` com `p` na lista de cópia única
//    (`check-single-version.mjs`) e dependência direta de algum pacote do workspace recebe a versão
//    direta do lock. Recusa (pendência, sem escrever) versões diretas diferentes entre pacotes e
//    rebaixamento (piso de segurança). Os outros overrides (os de segurança: `re2js`, `lodash`,
//    `minimatch`) só mudam por decisão registrada, nunca aqui. Se mudou: `pnpm install
//    --no-frozen-lockfile` (mesma idade mínima) e de novo `--frozen-lockfile`;
// 2. `MARKDOWNLINT_VERSION` do `rules.ts` = versão do markdownlint instalado (D-R23-02);
// 3. `check-licenses.mjs --fix` (linhas do NOTICES de licença aprovada) e o prettier no NOTICES;
// 4. `build-plugin-example.mjs` (`plugins-examples/calc/main.js`);
// 5. conferência: cópia única e versões citadas na seção do r7 do NOTICES (sempre); sem
//    `--no-verify`, também check-licenses `--require-destinations`, eslint, prettier, typecheck,
//    Vitest, `pnpm audit --prod --audit-level high` e o osv-scanner (se estiver no PATH).
// Saída: 0 = nada pendente; 1 = pendências (licença, segurança, testes, recusas); 2 = erro de uso ou
// de ambiente. Uso: `node scripts/deps-fix.mjs [--root <dir>] [--licenses <json>] [--no-build]
// [--no-verify]`. Para os testes (sem rede): `--root` (exige `--no-build`), `--licenses` (repassado
// ao check-licenses) e as variáveis `DEPS_FIX_PNPM` (script do Node no lugar do pnpm) e
// `DEPS_FIX_OSV` (binário do osv-scanner).
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  isSingleVersion,
  keyName,
  readLockfile,
  singleVersionReport,
} from './check-single-version.mjs';

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(SCRIPTS, '..');
const WORKSPACE = 'pnpm-workspace.yaml';
const LOCK = 'pnpm-lock.yaml';
const NOTICES = 'THIRD-PARTY-NOTICES.md';
const RULES = 'packages/plugins-internal/src/lint/rules.ts';
const MARKDOWNLINT = 'packages/plugins-internal/node_modules/markdownlint/package.json';
const CALC = 'plugins-examples/calc/main.js';
const R7_SECTION = 'Dependências npm novas de produção do r7';
const EXACT = /^(\d+)\.(\d+)\.(\d+)$/;

const changes = [];
const pending = new Set();
const checked = [];
const notes = [];

function usage(message) {
  console.error(
    `deps:fix: ${message}\nUso: node scripts/deps-fix.mjs [--root <dir>] [--licenses <json>] [--no-build] [--no-verify]`,
  );
  process.exit(2);
}

const options = { root: REPO, licenses: undefined, build: true, verify: true };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--root' || arg === '--licenses') {
    const value = argv[(i += 1)];
    if (!value) usage(`${arg} sem valor.`);
    options[arg.slice(2)] = resolve(value);
  } else if (arg === '--no-build') options.build = false;
  else if (arg === '--no-verify') options.verify = false;
  else usage(`opção desconhecida: ${arg}`);
}
const { root } = options;
for (const file of [WORKSPACE, LOCK, NOTICES])
  if (!existsSync(join(root, file))) usage(`${root} não é a raiz do simpleMD (falta ${file}).`);
if (options.build && realpathSync(root) !== realpathSync(REPO))
  usage('--root de outro diretório exige --no-build (o exemplo calc é gerado neste repositório).');
const licensesArgs = options.licenses ? ['--licenses', options.licenses] : [];
// Caminhos que o Vitest devolve vêm resolvidos (o `/tmp` do macOS é `/private/tmp`).
const realRoot = realpathSync(root);

/** O pnpm que roda este script (`pnpm deps:fix`), sem shell; fora do pnpm, `pnpm` do PATH. */
function pnpmCommand() {
  if (process.env.DEPS_FIX_PNPM) return [process.execPath, [process.env.DEPS_FIX_PNPM]];
  const execpath = process.env.npm_execpath;
  if (!execpath || !process.env.npm_config_user_agent?.startsWith('pnpm/')) return ['pnpm', []];
  return /\.[cm]?js$/.test(execpath) ? [process.execPath, [execpath]] : [execpath, []];
}

/** Roda na raiz; `out` junta stdout e stderr. */
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    shell: command === 'pnpm' && process.platform === 'win32',
  });
  const stdout = result.stdout ?? '';
  const error = result.error ? `\n${result.error.message}` : '';
  return {
    status: result.error ? -1 : result.status,
    stdout,
    out: `${stdout}${result.stderr ?? ''}${error}`,
    missing: result.error?.code === 'ENOENT',
  };
}
function pnpm(...args) {
  const [command, prefix] = pnpmCommand();
  return run(command, [...prefix, ...args]);
}
const script = (name, ...args) => run(process.execPath, [join(SCRIPTS, name), ...args]);

/** Fim da saída de um comando que reprovou, antes do resumo. */
function show(name, result) {
  const tail = result.out.trimEnd().split('\n').slice(-15).join('\n');
  console.log(`--- ${name} (código ${result.status}) ---\n${tail}`);
}

/** Problemas listados por um portão (`check-licenses: N problema(s):` + `- …`). */
const problems = (out) =>
  out
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());

function finish() {
  console.log('deps:fix — mudou:');
  console.log(changes.length > 0 ? changes.map((c) => `  ${c}`).join('\n') : '  (nada)');
  console.log('deps:fix — pendente (decisão humana):');
  console.log(pending.size > 0 ? [...pending].map((p) => `  ${p}`).join('\n') : '  (nada)');
  if (checked.length > 0) console.log(`deps:fix — conferido: ${checked.join(', ')}`);
  for (const note of notes) console.log(`deps:fix — ${note}`);
  console.log(`deps:fix: ${changes.length} mudança(s), ${pending.size} pendência(s).`);
  process.exit(pending.size > 0 ? 1 : 0);
}

function readLock() {
  try {
    return readLockfile(readFileSync(join(root, LOCK), 'utf8'));
  } catch (error) {
    console.error(`deps:fix: ${LOCK} ilegível: ${error.message}`);
    process.exit(2);
  }
}

/** Versões diretas por pacote: nome → (pacote do workspace → versão). */
function directVersions(docs) {
  const versions = new Map();
  for (const data of docs)
    for (const [importer, deps] of Object.entries(data.importers ?? {}))
      for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'])
        for (const [name, entry] of Object.entries(deps?.[section] ?? {})) {
          const version = String(entry?.version ?? '').replace(/\(.*$/, '');
          if (!/^\d/.test(version)) continue;
          if (!versions.has(name)) versions.set(name, new Map());
          versions.get(name).set(importer, version);
        }
  return versions;
}

/** Pacote que o override `pai>p@faixa` troca. */
const overrideTarget = (key) => key.slice(key.lastIndexOf('>') + 1).replace(/^(@?[^@]+)@.*$/, '$1');

function compare(a, b) {
  const [x, y] = [EXACT.exec(a).slice(1).map(Number), EXACT.exec(b).slice(1).map(Number)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** O texto com o valor de `key` trocado na sua linha (comentários e aspas intactos). */
function setOverride(text, key, from, to) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = new RegExp(
    `^([ \\t]+(['"]?)${escape(key)}\\2[ \\t]*:[ \\t]*(['"]?))${escape(from)}(\\3[ \\t]*(?:#[^\\r\\n]*)?\\r?)$`,
    'gm',
  );
  if ([...text.matchAll(line)].length !== 1) return undefined;
  return text.replace(line, (_, head, _key, _quote, tail) => `${head}${to}${tail}`);
}

function installFrozen() {
  const result = pnpm('install', '--frozen-lockfile');
  if (result.status === 0) return;
  if (result.missing) {
    console.error('deps:fix: pnpm não encontrado no PATH.');
    process.exit(2);
  }
  show('pnpm install --frozen-lockfile', result);
  pending.add(
    'install: `pnpm install --frozen-lockfile` reprovou (idade mínima, confiança ou lock desatualizado?); nada mais foi feito',
  );
  finish();
}

function alignOverrides() {
  const path = join(root, WORKSPACE);
  const text = readFileSync(path, 'utf8');
  let workspace;
  try {
    workspace = parse(text) ?? {};
  } catch (error) {
    console.error(`deps:fix: ${WORKSPACE} ilegível: ${error.message}`);
    process.exit(2);
  }
  const direct = directVersions(readLock());
  let next = text;
  const aligned = [];
  for (const [key, value] of Object.entries(workspace.overrides ?? {})) {
    const target = overrideTarget(key);
    if (!isSingleVersion(target) || !direct.has(target)) continue;
    const users = direct.get(target);
    const versions = [...new Set(users.values())];
    const current = String(value);
    if (versions.length > 1) {
      const list = [...users].map(([importer, version]) => `${importer} ${version}`).join(', ');
      pending.add(`overrides: \`${key}\`: o app usa ${target} em versões diferentes (${list})`);
      continue;
    }
    const [want] = versions;
    if (current === want) continue;
    if (!EXACT.test(current) || !EXACT.test(want)) {
      pending.add(`overrides: \`${key}\`: ${current} → ${want} não é troca entre versões exatas`);
      continue;
    }
    if (compare(want, current) < 0) {
      pending.add(`overrides: \`${key}\`: ${current} → ${want} seria rebaixamento`);
      continue;
    }
    const edited = setOverride(next, key, current, want);
    if (edited === undefined || String(parse(edited)?.overrides?.[key]) !== want) {
      pending.add(`overrides: \`${key}\`: linha não encontrada no ${WORKSPACE} (troque à mão)`);
      continue;
    }
    next = edited;
    aligned.push(`${WORKSPACE}: ${key} ${current} → ${want}`);
  }
  if (next === text) return;
  writeFileSync(path, next);
  const lock = join(root, LOCK);
  const before = readFileSync(lock, 'utf8');
  // O pnpm recusou (idade mínima, confiança): volta o workspace e o lock como estavam.
  const refuse = (name, result) => {
    show(name, result);
    writeFileSync(path, text);
    writeFileSync(lock, before);
    pending.add(
      `lock: \`${name}\` reprovou com os overrides alinhados (versão abaixo do minimumReleaseAge?); nada mudou, nada de exceção nova`,
    );
  };
  const resolved = pnpm('install', '--no-frozen-lockfile');
  if (resolved.status !== 0) return refuse('pnpm install --no-frozen-lockfile', resolved);
  const frozen = pnpm('install', '--frozen-lockfile');
  if (frozen.status !== 0) return refuse('pnpm install --frozen-lockfile', frozen);
  changes.push(...aligned);
  if (readFileSync(lock, 'utf8') !== before)
    changes.push(`${LOCK}: re-resolvido; --frozen-lockfile ok`);
}

function syncMarkdownlintVersion() {
  const pkg = join(root, MARKDOWNLINT);
  const rules = join(root, RULES);
  if (!existsSync(pkg) || !existsSync(rules)) {
    pending.add(`${RULES}: markdownlint não instalado em packages/plugins-internal`);
    return;
  }
  const { version } = JSON.parse(readFileSync(pkg, 'utf8'));
  const text = readFileSync(rules, 'utf8');
  const line = /^export const MARKDOWNLINT_VERSION = '([^']*)';$/m;
  const found = line.exec(text);
  if (!found || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(String(version))) {
    pending.add(`${RULES}: MARKDOWNLINT_VERSION não encontrada (escreva ${version} à mão)`);
    return;
  }
  if (found[1] === version) return;
  writeFileSync(rules, text.replace(line, `export const MARKDOWNLINT_VERSION = '${version}';`));
  changes.push(`${RULES}: MARKDOWNLINT_VERSION ${found[1]} → ${version}`);
}

async function fixNotices() {
  const path = join(root, NOTICES);
  const before = readFileSync(path, 'utf8');
  const result = script('check-licenses.mjs', root, '--fix', ...licensesArgs);
  const after = readFileSync(path, 'utf8');
  if (after !== before) {
    const prettier = await import('prettier');
    const config = (await prettier.resolveConfig(path)) ?? {};
    const formatted = await prettier.format(after, { ...config, filepath: path });
    if (formatted !== after) writeFileSync(path, formatted);
    const added = /^check-licenses: (\+\d+ linha\(s\)) no [^:]+: (.+)$/m.exec(result.out);
    changes.push(`${NOTICES}: ${added ? `${added[1]} (${added[2]})` : 'tabela atualizada'}`);
  }
  if (result.status !== 0)
    gate('check-licenses --fix', result, { prefix: 'check-licenses', list: true });
}

function buildCalc() {
  const path = join(root, CALC);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const result = script('build-plugin-example.mjs');
  if (result.status !== 0) {
    show('build-plugin-example', result);
    pending.add('calc: build-plugin-example.mjs reprovou');
    return;
  }
  if (readFileSync(path, 'utf8') !== before) changes.push(`${CALC}: regenerado`);
}

function checkSingleVersion(docs) {
  for (const [name, keys] of singleVersionReport(docs).duplicated)
    pending.add(`cópia única: ${name} com ${keys.length} cópias (${keys.join(', ')})`);
  checked.push('cópia única');
}

/** Itens `- \`nome\` x.y.z` da seção do r7 do NOTICES (texto e tag escritos à mão) × lock. */
function checkNoticesVersions(docs) {
  const installed = new Map();
  for (const data of docs)
    for (const key of Object.keys(data.packages ?? {})) {
      const name = keyName(key);
      if (!name) continue;
      if (!installed.has(name)) installed.set(name, new Set());
      installed.get(name).add(key.slice(name.length + 1).replace(/\(.*$/, ''));
    }
  const text = readFileSync(join(root, NOTICES), 'utf8');
  const start = text.indexOf(`\n## ${R7_SECTION}\n`);
  if (start < 0) return;
  const end = text.indexOf('\n## ', start + 1);
  const section = text.slice(start, end < 0 ? undefined : end);
  for (const [, name, version] of section.matchAll(/^- `([^`]+)` (\d+\.\d+\.\d+)\b/gm)) {
    const versions = installed.get(name);
    if (versions && !versions.has(version))
      pending.add(
        `${NOTICES} (seção do r7): \`${name}\` cita ${version}, o lock tem ${[...versions].join(', ')} (versão e tag à mão)`,
      );
  }
  checked.push('versões do NOTICES (r7)');
}

/**
 * Portão externo: passou → conferido; reprovou → pendência por problema listado (`- …`, com
 * `list`) ou uma só, com o fim da saída antes do resumo.
 */
function gate(name, result, { prefix = name, list = false } = {}) {
  if (result.status === 0) {
    checked.push(name);
    return;
  }
  const listed = list ? problems(result.out) : [];
  if (listed.length === 0) show(name, result);
  for (const problem of listed.length > 0 ? listed : ['reprovou (saída acima)'])
    pending.add(`${prefix}: ${problem}`);
}

function tests() {
  const dir = mkdtempSync(join(tmpdir(), 'deps-fix-'));
  const file = join(dir, 'vitest.json');
  try {
    const result = pnpm('exec', 'vitest', 'run', '--reporter=json', `--outputFile=${file}`);
    if (result.status === 0) {
      checked.push('vitest');
      return;
    }
    let failed = [];
    try {
      failed = JSON.parse(readFileSync(file, 'utf8'))
        .testResults.filter((t) => t.status === 'failed')
        .map((t) => relative(realRoot, existsSync(t.name) ? realpathSync(t.name) : t.name))
        .map((path) => path.split(sep).join('/'));
    } catch {
      failed = [];
    }
    if (failed.length > 0)
      pending.add(`vitest: ${failed.length} arquivo(s) reprovando: ${failed.join(', ')}`);
    else {
      show('vitest', result);
      pending.add('vitest: reprovou (saída acima)');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function audit() {
  const result = pnpm('audit', '--prod', '--audit-level', 'high', '--json');
  let advisories;
  try {
    advisories = Object.values(JSON.parse(result.stdout).advisories ?? {});
  } catch {
    advisories = undefined;
  }
  const high = (advisories ?? []).filter((a) => a.severity === 'high' || a.severity === 'critical');
  if (result.status === 0 && advisories && high.length === 0) {
    checked.push('pnpm audit --prod');
    return;
  }
  if (high.length === 0) {
    show('pnpm audit --prod --audit-level high', result);
    pending.add('audit: `pnpm audit --prod --audit-level high` reprovou sem aviso legível (rede?)');
    return;
  }
  for (const advisory of high) {
    const finding = advisory.findings?.[0];
    pending.add(
      `audit: ${advisory.severity} ${advisory.github_advisory_id ?? advisory.url} ${advisory.module_name} ${finding?.version ?? '?'} (${finding?.paths?.[0] ?? '?'})`,
    );
  }
}

function osv() {
  const result = run(process.env.DEPS_FIX_OSV ?? 'osv-scanner', [
    'scan',
    'source',
    '--config',
    'osv-scanner.toml',
    '--lockfile',
    LOCK,
    '--lockfile',
    'apps/desktop/src-tauri/Cargo.lock',
  ]);
  if (result.missing)
    notes.push('osv-scanner: não rodou (binário ausente; o job audit do CI roda)');
  else gate('osv-scanner', result);
}

installFrozen();
alignOverrides();
syncMarkdownlintVersion();
await fixNotices();
if (options.build) buildCalc();
const docs = readLock();
checkSingleVersion(docs);
checkNoticesVersions(docs);
if (options.verify) {
  gate(
    'check-licenses --require-destinations',
    script('check-licenses.mjs', root, '--require-destinations', ...licensesArgs),
    { prefix: 'check-licenses', list: true },
  );
  gate('eslint', pnpm('exec', 'eslint', '.', '--max-warnings=0'));
  gate('prettier', pnpm('exec', 'prettier', '--check', '.'));
  gate('typecheck', pnpm('typecheck'));
  tests();
  audit();
  osv();
} else notes.push('conferência externa: não rodou (--no-verify)');
finish();
