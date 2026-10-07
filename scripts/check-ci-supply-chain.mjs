#!/usr/bin/env node
// Portão estático da cadeia de suprimentos do CI (etapa 12a; R-12.4, AC-12.8). Roda dentro de
// `pnpm check:security`. Falha (código 1) se:
// - algum `uses:` de .github/workflows/*.yml não estiver fixado pelo SHA de 40 hex do commit com
//   a versão no comentário (`@<sha> # v1.2.3`; AS-05, Secrets F-2) ou alguma `image:` de contêiner
//   não estiver fixada pelo digest sha256;
// - algum `actions/checkout` não tiver `persist-credentials: false` (Secrets F-3);
// - algum workflow não declarar `permissions:` (no topo ou em todo job) ou pedir permissão de
//   escrita, em qualquer forma YAML (bloco, `{ … }`, entre aspas, `write-all`): o CI só lê;
// - algum `actions/setup-node` não usar `node-version-file: .node-version`, algum `toolchain:`
//   for um canal flutuante, `.node-version` não for uma versão exata ou `rust-toolchain.toml` não
//   fixar uma versão exata do Rust (DO-1);
// - faltar o job do gitleaks no histórico inteiro (Secrets F-1), o de auditoria com
//   `pnpm audit --prod --audit-level high` e `cargo-audit` ou o do Semgrep com as regras da
//   AppSec (DO-4), ou um job baixar binário com `curl` sem conferir o sha256;
// - `pnpm-workspace.yaml` não tiver `minimumReleaseAge` ≥ 1440, `trustPolicy: no-downgrade` e
//   `blockExoticSubdeps: true` (AS-06).
// Uso: `node scripts/check-ci-supply-chain.mjs [raiz]` (padrão: este repositório).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const root = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
const problems = [];
const fail = (message) => problems.push(message);
const read = (path) =>
  existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null;

const SHA_PIN = /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/;
const VERSION_COMMENT = /^#\s*v\d+(\.\d+){0,2}\b/;
const DIGEST_PIN = /@sha256:[0-9a-f]{64}$/;
/** Conjuntos de regras do Semgrep da AppSec r1 (literais: nada de RegExp montada em tempo de execução). */
const SEMGREP_CONFIGS = [
  /--config auto(\s|$)/,
  /--config p\/typescript(\s|$)/,
  /--config p\/react(\s|$)/,
  /--config p\/rust(\s|$)/,
  /--config p\/secrets(\s|$)/,
];

const indentOf = (line) => /^\s*/.exec(line)[0].length;

/**
 * Permissões de um nível (`permissions:` do topo ou de um job) já lidas como YAML: só `read-all`,
 * `{}` ou um mapa com `read`/`none` (CR2-05). Devolve as violações.
 */
function writePermissions(value) {
  if (typeof value === 'string') return value === 'read-all' ? [] : [value];
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return [JSON.stringify(value)];
  return Object.entries(value)
    .filter(([, level]) => level !== 'read' && level !== 'none')
    .map(([scope, level]) => `${scope}: ${level}`);
}

const meaningful = (line) => line.trim() !== '' && !line.trim().startsWith('#');

/** Linhas do passo (item de lista `- …`) que contém a linha `index`. */
function stepLines(lines, index) {
  let start = index;
  while (start >= 0 && !/^\s*-\s/.test(lines[start])) start -= 1;
  if (start < 0) return [lines[index]];
  const dash = indentOf(lines[start]);
  let end = start + 1;
  while (end < lines.length && !(meaningful(lines[end]) && indentOf(lines[end]) <= dash)) end += 1;
  return lines.slice(start, end);
}

/** Blocos `jobs.<id>` (id → texto), pela indentação de duas casas do YAML do workflow. */
function jobBlocks(lines) {
  const jobs = new Map();
  const at = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (at < 0) return jobs;
  let current = null;
  for (const line of lines.slice(at + 1)) {
    if (meaningful(line) && indentOf(line) === 0) break;
    const id = /^ {2}([\w-]+):\s*$/.exec(line)?.[1];
    if (id) {
      current = id;
      jobs.set(id, []);
    } else if (current) jobs.get(current).push(line);
  }
  return new Map([...jobs].map(([id, body]) => [id, body.join('\n')]));
}

// ---- workflows ----
const workflowDir = join(root, '.github/workflows');
const workflowFiles = existsSync(workflowDir)
  ? readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f))
  : [];
if (workflowFiles.length === 0) fail('.github/workflows: nenhum workflow encontrado');
let pinnedActions = 0;
let checkouts = 0;
const allJobs = new Map();
for (const file of workflowFiles) {
  const where = `.github/workflows/${file}`;
  const text = readFileSync(join(workflowDir, file), 'utf8');
  const lines = text.split(/\r?\n/);
  // Permissões pelo YAML de verdade (forma de fluxo, aspas, âncoras), não por linha.
  const parsed = parseDocument(text);
  if (parsed.errors.length > 0) {
    fail(`${where}: YAML inválido: ${parsed.errors[0].message.split('\n')[0]}`);
  } else {
    const workflow = parsed.toJS() ?? {};
    const jobs = Object.entries(workflow.jobs ?? {});
    const top = 'permissions' in workflow;
    if (top) {
      for (const bad of writePermissions(workflow.permissions))
        fail(`${where}: permissão de escrita no CI: ${bad}`);
    }
    for (const [id, job] of jobs) {
      if (job !== null && typeof job === 'object' && 'permissions' in job) {
        for (const bad of writePermissions(job.permissions))
          fail(`${where}: jobs.${id}: permissão de escrita no CI: ${bad}`);
      } else if (!top) {
        fail(
          `${where}: jobs.${id} sem bloco permissions (e o workflow não define permissions no topo)`,
        );
      }
    }
  }
  lines.forEach((line, i) => {
    const at = `${where}:${i + 1}`;
    const uses = /^\s*(?:-\s+)?uses:\s*['"]?([^\s'"#]+)['"]?\s*(#.*)?$/.exec(line);
    if (uses) {
      const [, ref, comment = ''] = uses;
      if (ref.startsWith('./')) return;
      if (ref.startsWith('docker://')) {
        if (!DIGEST_PIN.test(ref)) fail(`${at}: imagem sem digest sha256: ${ref}`);
        return;
      }
      if (!SHA_PIN.test(ref)) fail(`${at}: ação não fixada por SHA de 40 hex: ${ref}`);
      else if (!VERSION_COMMENT.test(comment.trim()))
        fail(`${at}: ação fixada sem a versão no comentário (# vX.Y.Z): ${ref}`);
      else pinnedActions += 1;
      const step = stepLines(lines, i);
      if (/^actions\/checkout@/.test(ref)) {
        checkouts += 1;
        if (!step.some((l) => /^\s*persist-credentials:\s*false\s*(#.*)?$/.test(l)))
          fail(`${at}: actions/checkout sem persist-credentials: false`);
      }
      if (/^actions\/setup-node@/.test(ref)) {
        if (!step.some((l) => /^\s*node-version-file:\s*['"]?\.node-version['"]?\s*$/.test(l)))
          fail(`${at}: actions/setup-node sem node-version-file: .node-version`);
        if (step.some((l) => /^\s*node-version:/.test(l)))
          fail(`${at}: actions/setup-node com node-version fixo no workflow`);
      }
    }
    const image = /^\s*(?:-\s+)?image:\s*['"]?([^\s'"#]+)/.exec(line);
    if (image && !DIGEST_PIN.test(image[1]))
      fail(`${at}: imagem de contêiner sem digest sha256: ${image[1]}`);
    if (meaningful(line) && /^\s*toolchain:\s*['"]?(stable|beta|nightly)\b/.test(line))
      fail(`${at}: toolchain do Rust flutuante: ${line.trim()}`);
  });
  for (const [id, body] of jobBlocks(lines)) allJobs.set(`${file}#${id}`, body);
}

const jobWith = (...needles) =>
  [...allJobs].find(([, body]) =>
    needles.every((n) => (n instanceof RegExp ? n.test(body) : body.includes(n))),
  )?.[0];
const gitleaksJob = jobWith(/gitleaks"?\s+git\s/, 'fetch-depth: 0', '--exit-code 1');
if (!gitleaksJob)
  fail(
    'CI: falta o job do gitleaks no histórico inteiro (gitleaks git, fetch-depth: 0, --exit-code 1)',
  );
const auditJob = jobWith(
  'pnpm audit --prod --audit-level high',
  /cargo-audit"?\s+audit|cargo audit/,
);
if (!auditJob)
  fail('CI: falta o job de auditoria (pnpm audit --prod --audit-level high e cargo-audit)');
const semgrepJob = jobWith('semgrep scan', '--error', ...SEMGREP_CONFIGS);
if (!semgrepJob)
  fail(
    'CI: falta o job do Semgrep com --error e --config auto, p/typescript, p/react, p/rust, p/secrets',
  );
for (const [id, body] of allJobs) {
  if (/\bcurl\b/.test(body) && !/sha256sum --check/.test(body))
    fail(`CI: o job ${id} baixa com curl sem conferir o sha256 (sha256sum --check)`);
}

// ---- toolchains (DO-1) ----
const nodeVersion = read('.node-version')?.trim();
if (!nodeVersion || !/^\d+\.\d+\.\d+$/.test(nodeVersion))
  fail(`.node-version: versão exata do Node ausente (achado: ${nodeVersion ?? 'arquivo ausente'})`);
const toolchain = read('rust-toolchain.toml');
const rustChannel = toolchain && /^\s*channel\s*=\s*"([^"]*)"\s*$/m.exec(toolchain)?.[1];
if (!rustChannel || !/^\d+\.\d+\.\d+$/.test(rustChannel))
  fail(
    `rust-toolchain.toml: channel deve ser uma versão exata (achado: ${rustChannel ?? 'ausente'})`,
  );

// ---- pnpm (AS-06) ----
const workspace = read('pnpm-workspace.yaml') ?? '';
const releaseAge = Number(/^minimumReleaseAge:\s*(\d+)\s*$/m.exec(workspace)?.[1] ?? 0);
if (releaseAge < 1440)
  fail(`pnpm-workspace.yaml: minimumReleaseAge ausente ou < 1440 (achado: ${releaseAge})`);
if (!/^trustPolicy:\s*no-downgrade\s*$/m.test(workspace))
  fail('pnpm-workspace.yaml: trustPolicy: no-downgrade ausente');
if (!/^blockExoticSubdeps:\s*true\s*$/m.test(workspace))
  fail('pnpm-workspace.yaml: blockExoticSubdeps: true ausente');

if (problems.length > 0) {
  console.error(`check:ci — ${problems.length} problema(s):`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log(
  `check:ci — OK: ${pinnedActions} ação(ões) fixada(s) por SHA, ${checkouts} checkout(s) com ` +
    'persist-credentials: false, sem permissão de escrita, imagens por digest, ' +
    `Node ${nodeVersion} (.node-version), Rust ${rustChannel} (rust-toolchain.toml), ` +
    `pnpm minimumReleaseAge ${releaseAge} + trustPolicy no-downgrade + blockExoticSubdeps.`,
);
console.log(`  jobs: gitleaks ${gitleaksJob}, auditoria ${auditJob}, semgrep ${semgrepJob}`);
