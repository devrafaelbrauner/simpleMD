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
//   `pnpm audit --prod --audit-level high` e `cargo-audit` (DO-4), o trufflehog
//   (`--only-verified --fail --no-update`) ou o osv-scanner (dois lockfiles, `osv-scanner.toml`)
//   fixados por versão e sha256 (B-05), ou o `ci.yml#semgrep` sem as regras fixadas por commit e
//   sha256 de `.github/semgrep-rules.txt`, com outra config além do diretório fixado ou com regras
//   flutuantes do registro (B-18, CR3-A1); ou um job tiver mais downloads com `curl` que
//   conferências `sha256sum --check`/`-c`;
// - o release.yml (B-01) tiver gatilho além de push.tags v* e workflow_dispatch, usar `secrets`
//   (em qualquer forma, ou no env do workflow) fora de um job do Environment `release` em tag v*,
//   um job de matriz do Environment não começar pelo passo `require-signing-secrets`, ou o
//   `publish` não depender do `bundle-release` ou fizer checkout/executar código do repositório;
//   ou o `bundle-release` puser segredo fora do `require-signing-secrets` e do passo
//   `tauri bundle`, deixar de falhar sempre no Windows, fizer checkout sem `fetch-depth: 0` ou
//   não conferir, antes do build, que o commit da tag está na main (APPSEC-R3-01/05, CR3-R6).
//   A única escrita aceita é a do job `publish` do release.yml (Environment `release`,
//   `if: startsWith(github.ref, 'refs/tags/v')`, só contents/id-token/attestations: write;
//   AC-B01.8);
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
/** Regras flutuantes do registro (literal: nada de RegExp montada em tempo de execução). */
const REGISTRY_RULES = /--config[\s=]+['"]?(auto|p\/|r\/)/;

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

// B-01 / AC-B01.8: a única escrita do CI é o job `publish` do release.yml, só em tag v*, só no
// Environment `release` e só com contents/id-token/attestations.
const RELEASE_TAG_IF = "startsWith(github.ref, 'refs/tags/v')";
const RELEASE_WRITE = /^(contents|id-token|attestations): write$/;
const environmentOf = (job) =>
  job.environment !== null && typeof job.environment === 'object'
    ? job.environment.name
    : job.environment;
const tagOnly = (job) => String(job.if ?? '').includes(RELEASE_TAG_IF);
/** `on:` do release.yml: só push de tag v* (sem branches/paths) e workflow_dispatch. */
const releaseTriggers = (on) =>
  on !== null &&
  typeof on === 'object' &&
  !Array.isArray(on) &&
  Object.keys(on).sort().join(',') === 'push,workflow_dispatch' &&
  JSON.stringify(on.push) === JSON.stringify({ tags: ['v*'] });
const releaseWriteAllowed = (file, workflow, id, job) =>
  file === 'release.yml' &&
  id === 'publish' &&
  environmentOf(job) === 'release' &&
  String(job.if ?? '')
    .replace(/\s+/g, ' ')
    .trim() === RELEASE_TAG_IF &&
  releaseTriggers(workflow.on);

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
let releaseException = null;
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
        const allowed = releaseWriteAllowed(file, workflow, id, job);
        for (const bad of writePermissions(job.permissions)) {
          if (allowed && RELEASE_WRITE.test(bad)) releaseException = `${file}#${id}`;
          else fail(`${where}: jobs.${id}: permissão de escrita no CI: ${bad}`);
        }
      } else if (!top) {
        fail(
          `${where}: jobs.${id} sem bloco permissions (e o workflow não define permissions no topo)`,
        );
      }
    }
    if (file === 'release.yml') {
      if (!releaseTriggers(workflow.on))
        fail(`${where}: gatilhos só push.tags ['v*'] e workflow_dispatch (sem pull_request*)`);
      // CR3-R2: `secrets` em qualquer forma (secrets.X, secrets['X'], toJSON(secrets)), também no
      // env do workflow.
      if (/\bsecrets\b/.test(JSON.stringify(workflow.env ?? {})))
        fail(
          `${where}: env do workflow lê secrets (só em env de passo de job do Environment release)`,
        );
      for (const [id, job] of jobs) {
        if (job === null || typeof job !== 'object') continue;
        const inRelease = environmentOf(job) === 'release';
        if (/\bsecrets\b/.test(JSON.stringify(job)) && !(inRelease && tagOnly(job)))
          fail(`${where}: jobs.${id} usa secrets.* fora do Environment release em tag v*`);
        if (inRelease && job.strategy?.matrix && job.steps?.[0]?.id !== 'require-signing-secrets')
          fail(
            `${where}: jobs.${id}: o 1º passo tem de ser id: require-signing-secrets (fail-closed)`,
          );
      }
      // CR3-R2: o job com escrita só roda depois do bundle-release e não executa nada do repo.
      const publish = workflow.jobs?.publish ?? {};
      if (![publish.needs].flat().includes('bundle-release'))
        fail(`${where}: jobs.publish tem de ter needs: bundle-release`);
      for (const step of Array.isArray(publish.steps) ? publish.steps : []) {
        if (String(step?.uses ?? '').startsWith('actions/checkout@'))
          fail(`${where}: jobs.publish não pode fazer checkout (token de escrita)`);
        if (
          /\b(git|node|pnpm|npm|npx|python3?|bash|sh)\b|scripts\/|\.\//.test(
            String(step?.run ?? ''),
          )
        )
          fail(`${where}: jobs.publish não pode executar código do repositório: ${step.run}`);
      }
      // APPSEC-R3-01/R3-05, CR3-R6: os passos de segurança do bundle-release ficam fixados.
      const bundle = workflow.jobs?.['bundle-release'] ?? {};
      const steps = Array.isArray(bundle.steps) ? bundle.steps : [];
      const runOf = (step) => String(step?.run ?? '');
      if (/\bsecrets\b/.test(JSON.stringify(bundle.env ?? {})))
        fail(`${where}: jobs.bundle-release: env do job lê secrets`);
      steps.forEach((step, i) => {
        const signing =
          (i === 0 && step?.id === 'require-signing-secrets') ||
          runOf(step).startsWith('pnpm --filter @simplemd/desktop tauri bundle ');
        if (/\bsecrets\b/.test(JSON.stringify(step ?? {})) && !signing)
          fail(
            `${where}: jobs.bundle-release: segredos só no require-signing-secrets e no passo ` +
              `tauri bundle (passo ${i + 1})`,
          );
      });
      if (
        !runOf(steps[0]).includes('if [ "$RUNNER_OS" != macOS ]; then') ||
        !runOf(steps[0]).includes('assinatura do Windows não configurada')
      )
        fail(
          `${where}: jobs.bundle-release: o require-signing-secrets tem de falhar sempre no Windows`,
        );
      const checkoutAt = steps.findIndex((s) =>
        String(s?.uses ?? '').startsWith('actions/checkout@'),
      );
      if (checkoutAt < 0 || steps[checkoutAt]?.with?.['fetch-depth'] !== 0)
        fail(`${where}: jobs.bundle-release: checkout sem fetch-depth: 0`);
      const ancestorAt = steps.findIndex((s) =>
        runOf(s).includes('git merge-base --is-ancestor "$GITHUB_SHA" origin/main ||'),
      );
      const buildAt = steps.findIndex((s) => /\btauri (build|bundle)\b/.test(runOf(s)));
      if (ancestorAt < 0 || ancestorAt < checkoutAt || ancestorAt > buildAt)
        fail(
          `${where}: jobs.bundle-release: falta a conferência de que o commit da tag está na main ` +
            '(depois do checkout, antes do build)',
        );
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
const trufflehogJob = jobWith(
  /trufflehog"?\s+git\s+file:\/\/\.\s+--only-verified\s+--fail\s+--no-update/,
  'fetch-depth: 0',
  /TRUFFLEHOG_VERSION: \d+\.\d+\.\d+\s/,
  /TRUFFLEHOG_SHA256: [0-9a-f]{64}\s/,
  'releases/download/v${TRUFFLEHOG_VERSION}/',
  '${TRUFFLEHOG_SHA256}',
);
if (!trufflehogJob)
  fail(
    'CI: falta o job do trufflehog fixado (git file://. --only-verified --fail --no-update, ' +
      'fetch-depth: 0, TRUFFLEHOG_VERSION e TRUFFLEHOG_SHA256 no download)',
  );
const osvJob = jobWith(
  /osv-scanner"?\s+scan\s+source/,
  '--config osv-scanner.toml',
  '--lockfile pnpm-lock.yaml',
  '--lockfile apps/desktop/src-tauri/Cargo.lock',
  /OSV_SCANNER_VERSION: \d+\.\d+\.\d+\s/,
  /OSV_SCANNER_SHA256: [0-9a-f]{64}\s/,
  'releases/download/v${OSV_SCANNER_VERSION}/',
  '${OSV_SCANNER_SHA256}',
);
if (!osvJob)
  fail(
    'CI: falta o osv-scanner fixado (scan source --config osv-scanner.toml nos dois lockfiles, ' +
      'OSV_SCANNER_VERSION e OSV_SCANNER_SHA256 no download)',
  );
if (read('osv-scanner.toml') === null) fail('osv-scanner.toml ausente (B-05)');
// B-18: o job obrigatório `semgrep` usa só as regras fixadas (commit + sha256 + lista no repo).
const semgrepBody = allJobs.get('ci.yml#semgrep') ?? '';
const semgrepCommit = /SEMGREP_RULES_COMMIT: ([0-9a-f]{40})\s/.exec(semgrepBody)?.[1];
const semgrepPinned =
  semgrepCommit &&
  /SEMGREP_RULES_SHA256: [0-9a-f]{64}\s/.test(semgrepBody) &&
  [
    'semgrep scan',
    '--error',
    '--metrics=off',
    'codeload.github.com/semgrep/semgrep-rules/tar.gz/${SEMGREP_RULES_COMMIT}',
    '${SEMGREP_RULES_SHA256}',
    '.github/semgrep-rules.txt',
  ].every((needle) => semgrepBody.includes(needle));
if (!semgrepPinned)
  fail(
    'CI: falta o job ci.yml#semgrep com --error, --metrics=off e as regras fixadas ' +
      '(SEMGREP_RULES_COMMIT de 40 hex, SEMGREP_RULES_SHA256, .github/semgrep-rules.txt)',
  );
if (REGISTRY_RULES.test(semgrepBody))
  fail('CI: ci.yml#semgrep usa regras flutuantes do registro (--config auto, p/… ou r/…)');
// CR3-A1: o scan usa SÓ o diretório fixado (nada de -c/--config extra, URL do registro ou a
// variável SEMGREP_RULES, que o Semgrep lê como --config). O `-c` do sha256sum não conta.
const semgrepConfigs = semgrepBody.match(/(?<!sha256sum)\s(?:-c|--config)(?=[\s=])/g)?.length ?? 0;
if (
  semgrepConfigs !== 1 ||
  !semgrepBody.includes('--config "$RUNNER_TEMP/semgrep-pinned"') ||
  /semgrep\.dev/.test(semgrepBody) ||
  /^\s*SEMGREP_RULES\s*:/m.test(semgrepBody)
)
  fail(
    'CI: ci.yml#semgrep tem de rodar só com --config "$RUNNER_TEMP/semgrep-pinned" ' +
      `(achado: ${semgrepConfigs} -c/--config; sem semgrep.dev nem SEMGREP_RULES)`,
  );
const ruleList = (read('.github/semgrep-rules.txt') ?? '')
  .split(/\r?\n/)
  .filter((line) => line.trim() !== '' && !line.startsWith('#'));
if (ruleList.length === 0) fail('.github/semgrep-rules.txt ausente ou vazio (B-18)');
for (const rule of ruleList) {
  if (!/^[\w./-]+\.ya?ml$/.test(rule) || rule.includes('..'))
    fail(`.github/semgrep-rules.txt: caminho de regra inválido: ${rule}`);
}
for (const [id, body] of allJobs) {
  const downloads = body.match(/\bcurl\b/g)?.length ?? 0;
  const checks = body.match(/sha256sum (--check|-c)\b/g)?.length ?? 0;
  if (downloads > checks)
    fail(
      `CI: o job ${id} baixa com curl sem conferir o sha256 (${downloads} curl, ` +
        `${checks} sha256sum --check)`,
    );
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
console.log(
  `  jobs: gitleaks ${gitleaksJob}, auditoria ${auditJob}, semgrep ci.yml#semgrep, ` +
    `trufflehog ${trufflehogJob}, osv-scanner ${osvJob}, ` +
    `regras semgrep ${semgrepCommit.slice(0, 8)} (${ruleList.length} arquivos), ` +
    `exceção de escrita ${releaseException ?? 'nenhuma'}`,
);
