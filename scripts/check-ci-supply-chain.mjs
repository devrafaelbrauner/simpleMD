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
// - o release.yml (B-01) tiver gatilho além de push.tags v* e workflow_dispatch (este só com o
//   input booleano `unsigned_prerelease`, default false), usar `secrets` (em qualquer forma, ou no
//   env do workflow) fora de um job do Environment `release` em tag v*, um job de matriz do
//   Environment não começar pelo passo `require-signing-secrets`, ou o `publish` não depender do
//   `bundle-release` ou fizer checkout/executar código do repositório; ou o `bundle-release` puser
//   segredo fora do `require-signing-secrets` e do passo `tauri bundle`, deixar de falhar sempre no
//   Windows, fizer checkout sem `fetch-depth: 0` ou não conferir, antes do build, que o commit da
//   tag está na main (APPSEC-R3-01/05, CR3-R6). As escritas aceitas são só as dos jobs `publish`
//   (`if: startsWith(github.ref, 'refs/tags/v')`) e `publish-unsigned` (r5: workflow_dispatch com
//   `inputs.unsigned_prerelease == true` numa tag v*) do release.yml, os dois no Environment
//   `release` e só com contents/id-token/attestations: write (AC-B01.8);
// - r5 (pré-lançamento sem assinatura, AS-R5-M01…M19 / CI-R5-01…12): o `bundle-dry-run` não roda
//   só em workflow_dispatch, sem Environment, sem checkout com `fetch-depth: 0`, sem o
//   `unsigned-prerelease-guard` exato (tag v*, main, versões) antes do install/build, sem o
//   `tauri bundle` com `APPLE_SIGNING_IDENTITY: '-'` (só ali) ou sem conferir a assinatura ad-hoc
//   do .app antes do upload; o `publish-unsigned` não depender só do `bundle-dry-run`, ler
//   secrets, fizer checkout, usar outra ação além de download-artifact/attest-build-provenance,
//   executar código do repositório, baixar algo além dos dois artefatos por nome, não exigir a
//   lista exata dos pacotes, não atestar antes do `gh release create --verify-tag --draft
//   --prerelease` exato (só o .dmg, o -setup.exe e SHA256SUMS) ou gerar notas sem os elementos
//   obrigatórios; o release.yml tiver always()/cancelled()/failure(), continue-on-error, `${{` dentro
//   de `run`, cache, `gh release upload|edit|delete` ou instrução para contornar a proteção do
//   sistema; algum `tauri build` de qualquer workflow não terminar em ` -- --locked`
//   (APPSEC-R3-04); ou as configs do Tauri tiverem assinatura/updater, ou existir
//   `tauri.{macos,windows,linux}.conf.json`;
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

// B-01 / AC-B01.8 + r5: as escritas do CI são só os jobs `publish` (tag v*) e `publish-unsigned`
// (workflow_dispatch com o input booleano numa tag v*) do release.yml, cada um com a forma exata
// do `if`, no Environment `release` e só com contents/id-token/attestations.
const RELEASE_TAG_IF = "startsWith(github.ref, 'refs/tags/v')";
const UNSIGNED_IF =
  "github.event_name == 'workflow_dispatch' && inputs.unsigned_prerelease == true && " +
  "startsWith(github.ref, 'refs/tags/v')";
const WRITE_JOBS = new Map([
  ['publish', RELEASE_TAG_IF],
  ['publish-unsigned', UNSIGNED_IF],
]);
const RELEASE_WRITE = /^(contents|id-token|attestations): write$/;
/** Código do repositório (ou um shell que o rode) num job com token de escrita. */
const REPO_CODE = /\b(git|node|pnpm|npm|npx|python3?|bash|sh)\b|scripts\/|\.\//;
const environmentOf = (job) =>
  job.environment !== null && typeof job.environment === 'object'
    ? job.environment.name
    : job.environment;
const tagOnly = (job) => String(job.if ?? '').includes(RELEASE_TAG_IF);
const normIf = (node) =>
  String(node?.if ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const stepsOf = (job) => (Array.isArray(job?.steps) ? job.steps : []);
const runOf = (step) => String(step?.run ?? '');
const runLines = (step) =>
  runOf(step)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
/** `on:` do release.yml: só push de tag v* (sem branches/paths) e workflow_dispatch. */
const releaseTriggers = (on) =>
  on !== null &&
  typeof on === 'object' &&
  !Array.isArray(on) &&
  Object.keys(on).sort().join(',') === 'push,workflow_dispatch' &&
  JSON.stringify(on.push) === JSON.stringify({ tags: ['v*'] });
/** workflow_dispatch vazio ou só o input booleano unsigned_prerelease (default false). */
const dispatchOk = (wd) => {
  if (wd === null || wd === undefined) return true;
  if (typeof wd !== 'object' || Array.isArray(wd)) return false;
  if (Object.keys(wd).length === 0) return true;
  if (Object.keys(wd).join() !== 'inputs') return false;
  const inputs = wd.inputs;
  if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) return false;
  const input = inputs.unsigned_prerelease;
  return (
    Object.keys(inputs).join() === 'unsigned_prerelease' &&
    input !== null &&
    typeof input === 'object' &&
    Object.keys(input).every((k) => ['description', 'type', 'default', 'required'].includes(k)) &&
    input.type === 'boolean' &&
    input.default === false &&
    (input.required ?? false) === false
  );
};
const releaseWriteAllowed = (file, workflow, id, job) =>
  file === 'release.yml' &&
  WRITE_JOBS.has(id) &&
  environmentOf(job) === 'release' &&
  normIf(job) === WRITE_JOBS.get(id) &&
  releaseTriggers(workflow.on) &&
  dispatchOk(workflow.on.workflow_dispatch);

// r5 (AS-R5-M01): o guard do bundle-dry-run, linha a linha (nada de `|| true` acrescentado).
const GUARD_IF = "inputs.unsigned_prerelease == true || github.ref_type == 'tag'";
const GUARD_RUN = [
  '[ "$GITHUB_REF_TYPE" = tag ] && [[ "$TAG" == v* ]] || { echo "::error::unsigned_prerelease só numa tag v* (ref: $GITHUB_REF)"; exit 1; }',
  'git merge-base --is-ancestor "$GITHUB_SHA" origin/main || { echo "::error::o commit da tag não está na main"; exit 1; }',
  `v=$(node -p "require('./apps/desktop/src-tauri/tauri.release.conf.json').version || require('./apps/desktop/src-tauri/tauri.conf.json').version")`,
  `cargo=$(sed -n 's/^version = "\\([^"]*\\)"$/\\1/p' apps/desktop/src-tauri/Cargo.toml)`,
  `pkg=$(node -p "require('./apps/desktop/package.json').version")`,
  '[ "$TAG" = "v$v" ] && [ "$cargo" = "$v" ] && [ "$pkg" = "$v" ] || { echo "::error::tag $TAG, Cargo.toml $cargo e package.json $pkg têm de ser a versão do app (v$v)"; exit 1; }',
];
const TAG_ENV = '${{ github.ref_name }}';
// r5 (AS-R5-M07): o único `tauri bundle` do dry-run assina ad-hoc (identidade `-`, não é segredo).
const DRY_BUNDLE_RUN =
  'pnpm --filter @simplemd/desktop tauri bundle --config src-tauri/tauri.release.conf.json';
// r5 (AS-R5-M08): a conferência da assinatura ad-hoc do .app.
const CODESIGN_LINES = [
  'codesign --verify --deep --strict --verbose=2 "$app"',
  `grep -qx 'Signature=adhoc' <<< "$info" || { echo "::error::o .app não tem assinatura ad-hoc"; exit 1; }`,
  `grep -qx 'Identifier=io.github.devrafaelbrauner.simplemd' <<< "$info" || { echo "::error::identificador da assinatura errado"; exit 1; }`,
  `grep -qF '(adhoc,runtime)' <<< "$info" || { echo "::error::assinatura sem hardened runtime"; exit 1; }`,
];
// r5 (AS-R5-M11): lista exata dos 3 arquivos dos artefatos; só o .dmg e o -setup.exe sobem.
const LIST_LINES = [
  'V="${TAG#v}"',
  'DMG="simpleMD_${V}_aarch64.dmg"',
  'EXE="simpleMD_${V}_x64-setup.exe"',
  `printf '%s\\n' "release/dmg/$DMG" "release/msi/simpleMD_\${V}_x64_en-US.msi" "release/nsis/$EXE" > "$RUNNER_TEMP/esperado"`,
  'find release ! -type d | LC_ALL=C sort > "$RUNNER_TEMP/achado"',
  'diff -u "$RUNNER_TEMP/esperado" "$RUNNER_TEMP/achado" || { echo "::error::os artefatos não são exatamente os 3 pacotes de $TAG"; exit 1; }',
  'mv -- "release/dmg/$DMG" "release/nsis/$EXE" assets/',
  'sha256sum -- "$DMG" "$EXE" > SHA256SUMS',
];
// r5 (AS-R5-M13): o único `gh release` do publish-unsigned, exato.
const CREATE_RUN =
  'gh release create "$TAG" --repo "$GITHUB_REPOSITORY" --verify-tag --draft --prerelease ' +
  '--title "simpleMD ${TAG#v} (pré-lançamento sem assinatura)" --notes-file "$RUNNER_TEMP/notas.md" ' +
  '"simpleMD_${TAG#v}_aarch64.dmg" "simpleMD_${TAG#v}_x64-setup.exe" SHA256SUMS';
// r5 (AS-R5-M19, CI-R5-12): o que as notas geradas no job têm de ter.
const NOTES_REQUIRED = [
  'https://github.com/devrafaelbrauner/simpleMD/releases',
  'gh attestation verify',
  '--signer-workflow devrafaelbrauner/simpleMD/.github/workflows/release.yml',
  '--source-ref refs/tags/',
  'shasum -a 256',
  'Get-FileHash',
  'Abrir Mesmo Assim',
  'Negar',
];
/** Instruções para contornar a proteção do sistema (AppSec R2): nunca no release.yml. */
const BYPASS = /xattr|spctl|unblock-file|set-mppreference|master-disable|global-disable|\bsudo\b/i;
/** Chaves de assinatura/updater que não podem estar nas configs do Tauri (AS-R5-M07). */
const TAURI_SIGNING_KEYS = [
  'signingIdentity',
  'signCommand',
  'certificateThumbprint',
  'createUpdaterArtifacts',
];
const keysOf = (value) =>
  value !== null && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)])
    : [];

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
const releaseExceptions = new Set();
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
          if (allowed && RELEASE_WRITE.test(bad)) releaseExceptions.add(`${file}#${id}`);
          else fail(`${where}: jobs.${id}: permissão de escrita no CI: ${bad}`);
        }
      } else if (!top) {
        fail(
          `${where}: jobs.${id} sem bloco permissions (e o workflow não define permissions no topo)`,
        );
      }
    }
    // APPSEC-R3-04 (CI-R5-07): todo `tauri build` de qualquer workflow usa o Cargo.lock do
    // repositório (o cargo recebe --locked pelo `--` do tauri CLI).
    for (const [id, job] of jobs) {
      for (const step of stepsOf(job)) {
        for (const line of runOf(step).split('\n')) {
          if (/\btauri build\b/.test(line) && !line.trim().endsWith(' -- --locked'))
            fail(
              `${where}: jobs.${id}: tauri build sem -- --locked (APPSEC-R3-04): ${line.trim()}`,
            );
        }
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
        if (REPO_CODE.test(runOf(step)))
          fail(`${where}: jobs.publish não pode executar código do repositório: ${step.run}`);
      }
      // APPSEC-R3-01/R3-05, CR3-R6: os passos de segurança do bundle-release ficam fixados.
      const bundle = workflow.jobs?.['bundle-release'] ?? {};
      const steps = Array.isArray(bundle.steps) ? bundle.steps : [];
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
      // CI-R5-05 (CR3-S2): a conferência da main e a falha do Windows, linha exata.
      if (!steps.some((s) => runLines(s).includes(GUARD_RUN[1])))
        fail(
          `${where}: jobs.bundle-release: a conferência da main tem de ser a linha exata ` +
            '(… || { echo "::error::o commit da tag não está na main"; exit 1; })',
        );
      if (
        !runLines(steps[0]).includes(
          'echo "::error::assinatura do Windows não configurada (B-01)"; exit 1',
        )
      )
        fail(
          `${where}: jobs.bundle-release: o require-signing-secrets tem de falhar sempre no Windows`,
        );
      // CI-R5-09: no bundle-release a identidade de assinatura só vem de secrets.
      for (const node of [bundle, ...steps]) {
        const identity = node?.env?.APPLE_SIGNING_IDENTITY;
        if (identity !== undefined && identity !== '${{ secrets.APPLE_SIGNING_IDENTITY }}')
          fail(
            `${where}: jobs.bundle-release: APPLE_SIGNING_IDENTITY só de secrets.APPLE_SIGNING_IDENTITY`,
          );
      }
      if (/APPLE_SIGNING_IDENTITY/.test(JSON.stringify(workflow.env ?? {})))
        fail(`${where}: env do workflow com APPLE_SIGNING_IDENTITY`);

      // ---- r5: pré-lançamento sem assinatura (AS-R5-M01…M19, CI-R5-01…12) ----
      // CI-R5-02 (C1): o opt-in é um input booleano tipado (nunca string: 'false' é verdadeiro).
      if (!dispatchOk(workflow.on?.workflow_dispatch))
        fail(
          `${where}: workflow_dispatch só aceita o input booleano unsigned_prerelease (default false)`,
        );
      // CI-R5-12 (R2): nada que ensine a contornar a proteção do sistema; CI-R5-06: nada de mexer
      // em release já criado.
      const bypass = BYPASS.exec(text);
      if (bypass)
        fail(`${where}: instrução para contornar a proteção do sistema (achado: ${bypass[0]})`);
      if (/\bgh release (upload|edit|delete)\b/.test(text))
        fail(`${where}: gh release upload/edit/delete no workflow (só gh release create)`);
      for (const [id, job] of jobs) {
        if (job === null || typeof job !== 'object') continue;
        const nodes = [job, ...stepsOf(job)];
        // CI-R5-03: nada roda se uma perna falhou; nada de falha engolida.
        if (nodes.some((node) => /\b(always|cancelled|failure)\s*\(/.test(String(node?.if ?? ''))))
          fail(`${where}: jobs.${id}: always()/cancelled()/failure() no release.yml`);
        if (
          nodes.some(
            (node) => node !== null && typeof node === 'object' && 'continue-on-error' in node,
          )
        )
          fail(`${where}: jobs.${id}: continue-on-error no release.yml`);
        // C16: a identidade ad-hoc nunca chega ao caminho assinado nem à publicação.
        if (id !== 'bundle-dry-run' && /"APPLE_SIGNING_IDENTITY":"-"/.test(JSON.stringify(job)))
          fail(
            `${where}: jobs.${id}: APPLE_SIGNING_IDENTITY '-' só no tauri bundle do bundle-dry-run`,
          );
        stepsOf(job).forEach((step, i) => {
          // CI-R5-11 (C17): valores dinâmicos só por env (injeção de expressão).
          if (runOf(step).includes('${{'))
            fail(`${where}: jobs.${id}: \${{ }} dentro de run (use env) (passo ${i + 1})`);
          // CI-R5-08 (C18): build de release sem cache.
          const uses = String(step?.uses ?? '');
          const inputs = step?.with;
          if (
            /^(actions\/cache(\/[\w-]+)?|Swatinem\/rust-cache)@/.test(uses) ||
            (inputs !== null &&
              typeof inputs === 'object' &&
              ('cache' in inputs || 'cache-dependency-path' in inputs))
          )
            fail(`${where}: jobs.${id}: cache no workflow de release (passo ${i + 1})`);
        });
      }

      const D = `${where}: jobs.bundle-dry-run`;
      const dry = workflow.jobs?.['bundle-dry-run'] ?? {};
      const drySteps = stepsOf(dry);
      const dryIndex = (match) => drySteps.findIndex(match);
      // C11 (AS-R5-M02): as pernas sem assinatura não têm Environment (nem segredo).
      if (normIf(dry) !== "github.event_name == 'workflow_dispatch'" || 'environment' in dry)
        fail(`${D}: só em workflow_dispatch, sem Environment`);
      // C12: o guard compara com origin/main, que precisa do histórico.
      const dryCheckoutAt = dryIndex((s) => String(s?.uses ?? '').startsWith('actions/checkout@'));
      if (dryCheckoutAt < 0 || drySteps[dryCheckoutAt]?.with?.['fetch-depth'] !== 0)
        fail(`${D}: checkout sem fetch-depth: 0`);
      // C13 / CI-R5-04 (AS-R5-M01): o guard exato depois do checkout e antes do install/build.
      const guardAt = dryIndex((s) => s?.id === 'unsigned-prerelease-guard');
      const guard = drySteps[guardAt];
      const installAt = dryIndex((s) => /\bpnpm install\b/.test(runOf(s)));
      const dryTauriAt = dryIndex((s) => /\btauri (build|bundle)\b/.test(runOf(s)));
      if (
        guardAt < 0 ||
        normIf(guard) !== GUARD_IF ||
        guard.shell !== 'bash' ||
        JSON.stringify(guard.env ?? null) !== JSON.stringify({ TAG: TAG_ENV }) ||
        JSON.stringify(runLines(guard)) !== JSON.stringify(GUARD_RUN) ||
        !(
          dryCheckoutAt >= 0 &&
          dryCheckoutAt < guardAt &&
          guardAt < installAt &&
          installAt < dryTauriAt
        )
      )
        fail(
          `${D}: falta o unsigned-prerelease-guard (tag v*, main, versões) antes do install/build`,
        );
      // C14 / CI-R5-09 (AS-R5-M07): só o único tauri bundle do dry-run tem a identidade `-`.
      const dryBundles = drySteps.filter((s) => /\btauri bundle\b/.test(runOf(s)));
      const dryBundleAt = drySteps.indexOf(dryBundles[0]);
      if (
        dryBundles.length !== 1 ||
        runOf(dryBundles[0]).trim() !== DRY_BUNDLE_RUN ||
        JSON.stringify(dryBundles[0].env ?? null) !== '{"APPLE_SIGNING_IDENTITY":"-"}'
      )
        fail(`${D}: o tauri bundle só assina ad-hoc (APPLE_SIGNING_IDENTITY: '-')`);
      if (
        /APPLE_SIGNING_IDENTITY/.test(
          JSON.stringify({ ...dry, steps: drySteps.filter((s) => s !== dryBundles[0]) }),
        )
      )
        fail(`${D}: APPLE_SIGNING_IDENTITY só no env do passo tauri bundle`);
      // C15 / CI-R5-10 (AS-R5-M08): a assinatura ad-hoc é conferida no .app antes do upload, e os
      // dois asserts rodam entre o bundle e o upload.
      const uploadAt = dryIndex((s) =>
        String(s?.uses ?? '').startsWith('actions/upload-artifact@'),
      );
      const codesignAt = dryIndex(
        (s) =>
          normIf(s) === "runner.os == 'macOS'" &&
          s.shell === 'bash' &&
          CODESIGN_LINES.every((line) => runLines(s).includes(line)),
      );
      if (dryBundleAt < 0 || codesignAt < dryBundleAt || uploadAt < codesignAt)
        fail(`${D}: falta conferir a assinatura ad-hoc do .app antes do upload`);
      for (const name of ['assert-no-harness.mjs', 'assert-no-ai-recorder.mjs']) {
        const at = dryIndex((s) => runOf(s).startsWith(`node scripts/${name}`));
        if (at < 0 || at < dryBundleAt || uploadAt < at)
          fail(`${D}: ${name} tem de rodar entre o tauri bundle e o upload`);
      }

      const unsigned = workflow.jobs?.['publish-unsigned'];
      if (unsigned !== undefined) {
        const P = `${where}: jobs.publish-unsigned`;
        const unsignedSteps = stepsOf(unsigned);
        const usesOf = (step) => String(step?.uses ?? '');
        // C2 (AS-R5-M03): só depois de TODAS as pernas do dry-run (que passaram pelo guard).
        if (JSON.stringify([unsigned?.needs].flat()) !== '["bundle-dry-run"]')
          fail(`${P} tem de ter needs: bundle-dry-run`);
        // C3 (AS-R5-M04): o tagOnly() da regra geral aceitaria secrets aqui.
        if (/\bsecrets\b/.test(JSON.stringify(unsigned))) fail(`${P} não pode ler secrets`);
        unsignedSteps.forEach((step, i) => {
          const uses = usesOf(step);
          // C4/C5: nada do repositório nem ação de terceiros com o token de escrita.
          if (uses.startsWith('actions/checkout@'))
            fail(`${P} não pode fazer checkout (token de escrita)`);
          else if (
            uses !== '' &&
            !/^actions\/(download-artifact|attest-build-provenance)@/.test(uses)
          )
            fail(
              `${P} só usa actions/download-artifact e actions/attest-build-provenance (${uses})`,
            );
          // C6 (AS-R5-M10…M14).
          if (REPO_CODE.test(runOf(step)))
            fail(`${P} não pode executar código do repositório (passo ${i + 1})`);
        });
        // C7 (AS-R5-M10): os dois artefatos desta execução, por nome exato.
        const downloads = unsignedSteps.filter((s) =>
          usesOf(s).startsWith('actions/download-artifact@'),
        );
        if (
          downloads.length !== 2 ||
          downloads.some(
            (s) =>
              Object.keys(s.with ?? {})
                .sort()
                .join() !== 'name,path' || s.with.path !== 'release',
          ) ||
          downloads
            .map((s) => s.with?.name)
            .sort()
            .join() !== 'bundle-dry-run-macos,bundle-dry-run-windows'
        )
          fail(`${P} baixa só bundle-dry-run-macos e bundle-dry-run-windows, por nome`);
        // C8 (AS-R5-M11): a lista exata antes do SHA256SUMS (nomes explícitos, nada de `*`).
        const listAt = unsignedSteps.findIndex((s) => {
          const got = runLines(s);
          const at = LIST_LINES.map((line) => got.indexOf(line));
          return (
            s?.env?.TAG === TAG_ENV &&
            at.every((index, k) => index >= 0 && (k === 0 || index > at[k - 1]))
          );
        });
        if (listAt < 0 || unsignedSteps.some((s) => /sha256sum\b.*\*/.test(runOf(s))))
          fail(
            `${P}: falta a lista exata dos pacotes (3 nos artefatos; sobem só o .dmg e o -setup.exe) ` +
              'antes do SHA256SUMS',
          );
        // C9 (AS-R5-M13): a atestação dos dois pacotes antes de criar o release.
        const createSteps = unsignedSteps.filter((s) => /\bgh release\b/.test(runOf(s)));
        const createAt = unsignedSteps.indexOf(createSteps[0]);
        const attestAt = unsignedSteps.findIndex(
          (s) =>
            usesOf(s).startsWith('actions/attest-build-provenance@') &&
            s.with?.['subject-checksums'] === 'assets/SHA256SUMS',
        );
        if (attestAt < 0 || attestAt < listAt || createAt < attestAt)
          fail(`${P}: falta a atestação antes do gh release create`);
        // C10 (AS-R5-M13): rascunho, pré-lançamento, tag que já existe, só os 2 pacotes + somas.
        const create = createSteps[0];
        if (
          createSteps.length !== 1 ||
          runOf(create).trim() !== CREATE_RUN ||
          create['working-directory'] !== 'assets' ||
          JSON.stringify(create.env ?? null) !==
            JSON.stringify({ GH_TOKEN: '${{ github.token }}', TAG: TAG_ENV })
        )
          fail(
            `${P}: gh release create com --verify-tag --draft --prerelease, --notes-file e só o ` +
              '.dmg, o -setup.exe e SHA256SUMS',
          );
        // AS-R5-M04b: o token só no passo do gh release create.
        if (
          unsignedSteps.some(
            (s) => s !== create && /GH_TOKEN|GITHUB_TOKEN|github\.token/.test(JSON.stringify(s)),
          )
        )
          fail(`${P}: o token só no env do passo gh release create`);
        // CI-R5-12 (AS-R5-M12/M19): as notas nascem no job, com os elementos obrigatórios.
        const notes = unsignedSteps.map(runOf).join('\n');
        const missing = NOTES_REQUIRED.filter((needle) => !notes.includes(needle));
        if (missing.length > 0)
          fail(`${P}: as notas geradas no job não têm: ${missing.join(', ')}`);
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

// ---- CI-R5-09 (AS-R5-M07): assinatura só pelo env dos workflows, nunca pelas configs do Tauri ----
// O Tauri mescla sozinho `tauri.<plataforma>.conf.json`; uma config assim mudaria a assinatura sem
// passar pelo --config do workflow.
const TAURI_DIR = 'apps/desktop/src-tauri';
for (const platform of ['macos', 'windows', 'linux']) {
  if (existsSync(join(root, TAURI_DIR, `tauri.${platform}.conf.json`)))
    fail(`${TAURI_DIR}/tauri.${platform}.conf.json: config de plataforma do Tauri não é permitida`);
}
for (const name of ['tauri.conf.json', 'tauri.release.conf.json']) {
  const text = read(`${TAURI_DIR}/${name}`);
  let conf;
  try {
    conf = text === null ? null : JSON.parse(text);
  } catch {
    conf = null;
  }
  if (conf === null || typeof conf !== 'object') {
    fail(`${TAURI_DIR}/${name}: ausente ou JSON inválido`);
    continue;
  }
  const keys = keysOf(conf);
  const found = TAURI_SIGNING_KEYS.filter((key) => keys.includes(key));
  if (conf.plugins?.updater !== undefined) found.push('plugins.updater');
  if (found.length > 0)
    fail(`${TAURI_DIR}/${name}: assinatura/updater na config do Tauri (${found.join(', ')})`);
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
    `exceções de escrita ${[...releaseExceptions].sort().join(', ') || 'nenhuma'}`,
);
