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
//   input booleano `unsigned_prerelease`, default false), jobs além de `bundle-dry-run`,
//   `bundle-macos`, `bundle-windows`, `sign-macos`, `publish` e `publish-unsigned`, ou usar
//   `secrets` (em qualquer forma, ou no env do workflow) fora do env dos passos
//   `require-signing-secrets` e `sign` do `sign-macos`, com outros nomes além dos 5 segredos da
//   Apple (sem Apple ID, sem chave por caminho, sem identidade de entrada) ou `vars` além de
//   `vars.APPLE_TEAM_ID` nos passos do `sign-macos`. As escritas aceitas são só as dos jobs
//   `publish` (push de tag v*) e `publish-unsigned` (r5: workflow_dispatch com
//   `inputs.unsigned_prerelease == true` numa tag v*) do release.yml, os dois no Environment
//   `release` e só com contents/id-token/attestations: write (AC-B01.8);
// - r6/r18 (portões do macOS assinado: CR3-S1, CR3-R1, AS-R5-S08, L-1; CI-R6-01…24): o
//   `bundle-macos` e o `bundle-windows` saírem da forma fixada (só no push de tag v*, sem matriz,
//   sem Environment, sem segredo, checkout com `fetch-depth: 0`, `release-guard` exato antes do
//   install/build, `tauri bundle --bundles app|nsis` sem identidade, tar do .app com a lista exata
//   e o NSIS conferido como `NotSigned`, cada um subindo UM arquivo com `archive: false` e
//   entregando id + sha256); o `sign-macos` (Environment `release`, `permissions: {}`, runner
//   `macos-26`, sem checkout nem código do projeto, só ferramentas da Apple por caminho absoluto no
//   bash do sistema) sair dos passos fixados linha a linha (segredos e variável que faltam, Apple ID
//   recusado, entrada por id + sha256, tar cru com a lista exata, keychain temporário com limpeza
//   por trap, identidade única com o nome do `bundle.publisher`, codesign sem `--deep`,
//   `--preserve-metadata`, `--entitlements` ou ad-hoc, notarização pela chave de API com `--wait` e
//   o log, grampo, conferência completa com TeamIdentifier antes do único upload); o
//   `Entitlements.plist` ganhar chave; ou o `publish` não depender só do `sign-macos` e do
//   `bundle-windows`, baixar algo além dos dois arquivos pelos ids das saídas, não conferir o sha256
//   de cada um, não ter a lista exata, somar com `*` (L-1) ou não atestar antes do
//   `gh release create --verify-tag --draft --prerelease` exato;
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
// - `pnpm-workspace.yaml` não tiver `minimumReleaseAge` ≥ 10080, `trustPolicy: no-downgrade` e
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

// B-01 / AC-B01.8 + r5 + r6: as escritas do CI são só os jobs `publish` (push de tag v*) e
// `publish-unsigned` (workflow_dispatch com o input booleano numa tag v*) do release.yml, cada um
// com a forma exata do `if`, no Environment `release` e só com contents/id-token/attestations.
const RELEASE_TAG_IF = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')";
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
/** Executáveis que o job de assinatura nunca roda (AS-R6-M01), além de REPO_CODE. */
const SIGNER_FORBIDDEN =
  /\b(npm|npx|yarn|bun|cargo|rustup|tauri|ruby|perl|curl|wget|brew|pip3?|python3?)\b/;
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
// r5 (AS-R5-M11, AS-R5-REV-01): cada artefato na sua pasta, com exatamente os pacotes da sua perna;
// só o .dmg e o -setup.exe sobem.
const LIST_LINES = [
  'V="${TAG#v}"',
  'DMG="simpleMD_${V}_aarch64.dmg"',
  'EXE="simpleMD_${V}_x64-setup.exe"',
  `printf '%s\\n' "release/macos/dmg/$DMG" "release/windows/msi/simpleMD_\${V}_x64_en-US.msi" "release/windows/nsis/$EXE" > "$RUNNER_TEMP/esperado"`,
  'find release ! -type d | LC_ALL=C sort > "$RUNNER_TEMP/achado"',
  'diff -u "$RUNNER_TEMP/esperado" "$RUNNER_TEMP/achado" || { echo "::error::os artefatos não são exatamente os pacotes de $TAG de cada perna"; exit 1; }',
  'mv -- "release/macos/dmg/$DMG" "release/windows/nsis/$EXE" assets/',
  'sha256sum -- "$DMG" "$EXE" > SHA256SUMS',
];
/** Pasta de download de cada artefato no publish-unsigned (AS-R5-REV-01). */
const DOWNLOAD_PATHS =
  '{"bundle-dry-run-macos":"release/macos","bundle-dry-run-windows":"release/windows"}';
// ---- r6/r18 (portões do macOS assinado): o caminho de assinatura fixado linha a linha ----
/** Os jobs do release.yml (DV-2) e os do caminho assinado, só no push de tag v* (DV-3). */
const SIGNED_JOBS = ['bundle-macos', 'bundle-windows', 'sign-macos', 'publish'];
const RELEASE_JOBS = ['bundle-dry-run', ...SIGNED_JOBS, 'publish-unsigned'];
/** Pasta do app Tauri (configs, Entitlements.plist). */
const TAURI_DIR = 'apps/desktop/src-tauri';
/** Runner de cada job do caminho assinado (DV-15; CI-R6-24: o assinador num rótulo fixo). */
const SIGNED_RUNNERS = {
  'bundle-macos': 'macos-26',
  'bundle-windows': 'windows-latest',
  'sign-macos': 'macos-26',
  publish: 'ubuntu-latest',
};
const SIGN_SHELL = '/bin/bash --noprofile --norc -euo pipefail {0}';
const SIGN_SECRETS = [
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_API_ISSUER',
  'APPLE_API_KEY',
  'APPLE_API_PRIVATE_KEY',
];
const TEAM_VAR = '${{ vars.APPLE_TEAM_ID }}';
/** O env exato dos dois passos do sign-macos que recebem os segredos (AS-R6-M05). */
const SIGN_ENV = JSON.stringify({
  ...Object.fromEntries(SIGN_SECRETS.map((name) => [name, `\${{ secrets.${name} }}`])),
  APPLE_TEAM_ID: TEAM_VAR,
});
// Os passos com `run` do caminho assinado, linha a linha (`@NOME@` = `bundle.publisher`, o nome
// provisório do certificado Developer ID; AS-R6-M11). O guard dos dois builds é o do dry-run, com a
// mensagem do caminho assinado na 1ª linha.
const RELEASE_GUARD_RUN = [
  '[ "$GITHUB_REF_TYPE" = tag ] && [[ "$TAG" == v* ]] || { echo "::error::caminho assinado só numa tag v* (ref: $GITHUB_REF)"; exit 1; }',
  ...GUARD_RUN.slice(1),
];
const MAC_BUNDLE_RUN =
  'pnpm --filter @simplemd/desktop tauri bundle --bundles app --config src-tauri/tauri.release.conf.json';
const WIN_BUNDLE_RUN =
  'pnpm --filter @simplemd/desktop tauri bundle --bundles nsis --config src-tauri/tauri.release.conf.json';
const APP_TAR_RUN = [
  'COPYFILE_DISABLE=1 /usr/bin/tar --no-mac-metadata --no-xattrs --no-acls --no-fflags -cf "$RUNNER_TEMP/simpleMD.app.tar" simpleMD.app',
  'printf \'%s\\n\' simpleMD.app/ simpleMD.app/Contents/ simpleMD.app/Contents/Info.plist simpleMD.app/Contents/MacOS/ simpleMD.app/Contents/MacOS/simplemd simpleMD.app/Contents/Resources/ simpleMD.app/Contents/Resources/THIRD-PARTY-LICENSES.txt simpleMD.app/Contents/Resources/THIRD-PARTY-NOTICES.md simpleMD.app/Contents/Resources/icon.icns | LC_ALL=C /usr/bin/sort > "$RUNNER_TEMP/esperado"',
  '/usr/bin/tar --options \'tar:!mac-ext\' -tf "$RUNNER_TEMP/simpleMD.app.tar" | LC_ALL=C /usr/bin/sort > "$RUNNER_TEMP/achado"',
  '/usr/bin/diff -u "$RUNNER_TEMP/esperado" "$RUNNER_TEMP/achado" || { echo "::error::o .app não é exatamente a lista esperada"; exit 1; }',
  'sha=$(/usr/bin/shasum -a 256 "$RUNNER_TEMP/simpleMD.app.tar" | /usr/bin/awk \'{print $1}\')',
  'echo "$sha  simpleMD.app.tar"',
  'echo "sha256=$sha" >> "$GITHUB_OUTPUT"',
];
const EXE_RUN = [
  '$v = (Get-Content -Raw -LiteralPath apps/desktop/src-tauri/tauri.conf.json | ConvertFrom-Json).version',
  '$name = "simpleMD_${v}_x64-setup.exe"',
  '$files = @(Get-ChildItem -LiteralPath apps/desktop/src-tauri/target/release/bundle/nsis -File)',
  'if ($files.Count -ne 1 -or $files[0].Name -ne $name) { Write-Output "::error::bundle/nsis tem de ter só $name"; exit 1 }',
  '$sig = Get-AuthenticodeSignature -LiteralPath $files[0].FullName',
  'Write-Output "${name}: $($sig.Status)"',
  'if ($sig.Status -ne \'NotSigned\') { Write-Output "::error::o -setup.exe tem de sair sem assinatura (NotSigned); achado: $($sig.Status)"; exit 1 }',
  '$sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $files[0].FullName).Hash.ToLowerInvariant()',
  'Write-Output "$sha  $name"',
  '"sha256=$sha" | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8',
];
const REQUIRE_SIGNING_RUN = [
  'missing=""',
  'for n in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_API_ISSUER APPLE_API_KEY APPLE_API_PRIVATE_KEY APPLE_TEAM_ID; do',
  '[ -n "${!n:-}" ] || missing="$missing $n"',
  'done',
  '[ -z "$missing" ] || { echo "::error::segredos de assinatura ausentes no Environment:$missing"; exit 1; }',
  '[ -z "${APPLE_ID:-}${APPLE_PASSWORD:-}" ] || { echo "::error::notarização por Apple ID não é aceita (só a chave de API da App Store Connect)"; exit 1; }',
  '[[ "$APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || { echo "::error::APPLE_TEAM_ID com formato inválido"; exit 1; }',
  '[[ "$APPLE_API_KEY" =~ ^[A-Z0-9]{10}$ ]] || { echo "::error::APPLE_API_KEY com formato inválido"; exit 1; }',
  '[[ "$APPLE_API_ISSUER" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "::error::APPLE_API_ISSUER com formato inválido"; exit 1; }',
  '[[ "$APPLE_CERTIFICATE" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || { echo "::error::APPLE_CERTIFICATE tem de ser base64 numa linha só"; exit 1; }',
  '[[ "$APPLE_API_PRIVATE_KEY" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || { echo "::error::APPLE_API_PRIVATE_KEY tem de ser base64 numa linha só"; exit 1; }',
];
const SIGN_INPUTS_RUN = [
  '[[ "$APP_TAR_ID" =~ ^[0-9]+$ ]] || { echo "::error::app-tar-artifact-id inválido"; exit 1; }',
  '[[ "$APP_TAR_SHA" =~ ^[0-9a-f]{64}$ ]] || { echo "::error::app-tar-sha256 inválido"; exit 1; }',
];
const INTAKE_RUN = [
  '[[ "$APP_TAR_SHA" =~ ^[0-9a-f]{64}$ ]] || { echo "::error::app-tar-sha256 inválido"; exit 1; }',
  'T="$RUNNER_TEMP/in/simpleMD.app.tar"',
  '[ "$(/usr/bin/find "$RUNNER_TEMP/in" -mindepth 1)" = "$T" ] && [ -f "$T" ] && [ ! -L "$T" ] || { echo "::error::o download não é exatamente simpleMD.app.tar"; exit 1; }',
  '[ "$(/usr/bin/shasum -a 256 "$T" | /usr/bin/awk \'{print $1}\')" = "$APP_TAR_SHA" ] || { echo "::error::o tar baixado não é o que o bundle-macos produziu"; exit 1; }',
  'printf \'%s\\n\' simpleMD.app/ simpleMD.app/Contents/ simpleMD.app/Contents/Info.plist simpleMD.app/Contents/MacOS/ simpleMD.app/Contents/MacOS/simplemd simpleMD.app/Contents/Resources/ simpleMD.app/Contents/Resources/THIRD-PARTY-LICENSES.txt simpleMD.app/Contents/Resources/THIRD-PARTY-NOTICES.md simpleMD.app/Contents/Resources/icon.icns | LC_ALL=C /usr/bin/sort > "$RUNNER_TEMP/esperado"',
  '/usr/bin/tar --options \'tar:!mac-ext\' -tf "$T" | LC_ALL=C /usr/bin/sort > "$RUNNER_TEMP/achado"',
  '/usr/bin/diff -u "$RUNNER_TEMP/esperado" "$RUNNER_TEMP/achado" || { echo "::error::o tar do .app não é exatamente a lista esperada"; exit 1; }',
  "bad=$(/usr/bin/tar --options 'tar:!mac-ext' -tvf \"$T\" | /usr/bin/awk '$1 !~ /^(d|-)[rwx-]{9}$/')",
  '[ -z "$bad" ] || { echo "::error::tipo ou modo proibido no tar"; echo "$bad"; exit 1; }',
  '/usr/bin/tar --options \'tar:!mac-ext\' -tvf "$T" | /usr/bin/awk \'$NF=="simpleMD.app/Contents/MacOS/simplemd" && $1!="-rwxr-xr-x"{exit 1}\' || { echo "::error::simplemd sem modo 755"; exit 1; }',
  '/bin/mkdir "$RUNNER_TEMP/app"',
  '/usr/bin/tar --options \'tar:!mac-ext\' --no-xattrs --no-acls --no-fflags --no-mac-metadata --no-same-owner -xf "$T" -C "$RUNNER_TEMP/app"',
  '/usr/bin/xattr -cr "$RUNNER_TEMP/app/simpleMD.app"',
  'P="$RUNNER_TEMP/app/simpleMD.app/Contents/Info.plist"',
  '[ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$P")" = io.github.devrafaelbrauner.simplemd ] || { echo "::error::CFBundleIdentifier errado"; exit 1; }',
  '[ "$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "$P")" = simplemd ] || { echo "::error::CFBundleExecutable errado"; exit 1; }',
  'V=$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$P")',
  '[[ "$V" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]] || { echo "::error::versão do app inválida"; exit 1; }',
  '[ "$TAG" = "v$V" ] || { echo "::error::a tag $TAG não é a versão do .app (v$V)"; exit 1; }',
  '[ "$(/usr/bin/lipo -archs "$RUNNER_TEMP/app/simpleMD.app/Contents/MacOS/simplemd")" = arm64 ] || { echo "::error::o binário não é só arm64"; exit 1; }',
];
const SIGN_RUN = [
  'umask 077',
  'KC="$RUNNER_TEMP/simplemd-signing.keychain-db"',
  'cleanup() { /usr/bin/security delete-keychain "$KC" 2>/dev/null || true; /bin/rm -f "$RUNNER_TEMP/devid.p12" "$RUNNER_TEMP/AuthKey.p8"; }',
  'trap cleanup EXIT INT TERM',
  'KC_PASS=$(/usr/bin/openssl rand -hex 32)',
  'echo "::add-mask::$KC_PASS"',
  '/usr/bin/security create-keychain -p "$KC_PASS" "$KC"',
  '/usr/bin/security set-keychain-settings -lut 7200 "$KC"',
  '/usr/bin/security unlock-keychain -p "$KC_PASS" "$KC"',
  '/usr/bin/base64 --decode <<< "$APPLE_CERTIFICATE" > "$RUNNER_TEMP/devid.p12"',
  '/usr/bin/security import "$RUNNER_TEMP/devid.p12" -k "$KC" -f pkcs12 -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign',
  '/bin/rm -f "$RUNNER_TEMP/devid.p12"',
  '/usr/bin/security set-key-partition-list -S apple-tool:,apple: -s -k "$KC_PASS" "$KC" > /dev/null',
  "read -r -a KCS <<< \"$(/usr/bin/security list-keychains -d user | /usr/bin/tr -d '\"' | /usr/bin/tr '\\n' ' ')\"",
  '/usr/bin/security list-keychains -d user -s "$KC" "${KCS[@]}"',
  'ids=$(/usr/bin/security find-identity -v -p codesigning "$KC")',
  'echo "$ids"',
  '[ "$(echo "$ids" | /usr/bin/tail -1)" = "     1 valid identities found" ] || { echo "::error::o keychain temporário não tem exatamente 1 identidade válida"; exit 1; }',
  'echo "$ids" | /usr/bin/grep -qF "\\"Developer ID Application: @NOME@ ($APPLE_TEAM_ID)\\"" || { echo "::error::a identidade não é a Developer ID Application de @NOME@ com o Team ID do Environment"; exit 1; }',
  'SHA1=$(echo "$ids" | /usr/bin/awk \'NR==1{print $2}\')',
  '[[ "$SHA1" =~ ^[0-9A-F]{40}$ ]] || { echo "::error::identidade sem SHA-1"; exit 1; }',
  '/usr/bin/base64 --decode <<< "$APPLE_API_PRIVATE_KEY" > "$RUNNER_TEMP/AuthKey.p8"',
  '/usr/bin/xcrun notarytool store-credentials simplemd-notary --key "$RUNNER_TEMP/AuthKey.p8" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --keychain "$KC"',
  '/bin/rm -f "$RUNNER_TEMP/AuthKey.p8"',
  'notarize() {',
  'local file="$1" what="$2" rc=0 sub',
  '/usr/bin/shasum -a 256 "$file" | /usr/bin/awk \'{print $1}\' > "$RUNNER_TEMP/notary-$what.sha256"',
  '/usr/bin/xcrun notarytool submit "$file" --keychain-profile simplemd-notary --keychain "$KC" --wait --timeout 45m --output-format json > "$RUNNER_TEMP/notary-$what.json" || rc=$?',
  '/bin/cat "$RUNNER_TEMP/notary-$what.json"',
  'sub=$(/usr/bin/plutil -extract id raw -o - "$RUNNER_TEMP/notary-$what.json")',
  '/usr/bin/xcrun notarytool log "$sub" --keychain-profile simplemd-notary --keychain "$KC" "$RUNNER_TEMP/notary-$what-log.json"',
  '/bin/cat "$RUNNER_TEMP/notary-$what-log.json"',
  '[ "$rc" = 0 ] && [ "$(/usr/bin/plutil -extract status raw -o - "$RUNNER_TEMP/notary-$what.json")" = Accepted ] || { echo "::error::notarização ($what) não aceita"; exit 1; }',
  '}',
  'APP="$RUNNER_TEMP/app/simpleMD.app"',
  'V=$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$APP/Contents/Info.plist")',
  '[[ "$V" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]] || { echo "::error::versão do app inválida"; exit 1; }',
  '/usr/bin/codesign --force --options runtime --timestamp --keychain "$KC" --sign "$SHA1" "$APP"',
  '/usr/bin/ditto -c -k --keepParent "$APP" "$RUNNER_TEMP/simpleMD.app.zip"',
  'notarize "$RUNNER_TEMP/simpleMD.app.zip" app',
  '/usr/bin/xcrun stapler staple "$APP"',
  '/bin/mkdir "$RUNNER_TEMP/stage" "$RUNNER_TEMP/out"',
  '/usr/bin/ditto "$APP" "$RUNNER_TEMP/stage/simpleMD.app"',
  '/bin/ln -s /Applications "$RUNNER_TEMP/stage/Applications"',
  'DMG="$RUNNER_TEMP/out/simpleMD_${V}_aarch64.dmg"',
  '/usr/bin/hdiutil create -volname simpleMD -srcfolder "$RUNNER_TEMP/stage" -fs HFS+ -format UDZO -ov "$DMG"',
  '/usr/bin/hdiutil verify "$DMG"',
  '/usr/bin/codesign --force --timestamp --keychain "$KC" --sign "$SHA1" --identifier io.github.devrafaelbrauner.simplemd.dmg "$DMG"',
  'notarize "$DMG" dmg',
  '/usr/bin/xcrun stapler staple "$DMG"',
];
/** AS-R5-S08: o verify começa recusando um Team ID vazio, `-` ou fora do formato. */
const TEAM_FORMAT_LINE =
  '[[ "$APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || { echo "::error::APPLE_TEAM_ID com formato inválido"; exit 1; }';
const VERIFY_RUN = [
  TEAM_FORMAT_LINE,
  '[ ! -e "$RUNNER_TEMP/simplemd-signing.keychain-db" ] && [ ! -e "$RUNNER_TEMP/devid.p12" ] && [ ! -e "$RUNNER_TEMP/AuthKey.p8" ] || { echo "::error::keychain ou chaves temporárias não foram apagados"; exit 1; }',
  'if /usr/bin/security list-keychains -d user | /usr/bin/grep -qF simplemd-signing; then echo "::error::keychain temporário ainda na lista de busca"; exit 1; fi',
  'ID="Developer ID Application: @NOME@ ($APPLE_TEAM_ID)"',
  'V=$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$RUNNER_TEMP/app/simpleMD.app/Contents/Info.plist")',
  '[[ "$V" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]] || { echo "::error::versão do app inválida"; exit 1; }',
  'DMG="$RUNNER_TEMP/out/simpleMD_${V}_aarch64.dmg"',
  '[ "$(/usr/bin/find "$RUNNER_TEMP/out" -mindepth 1)" = "$DMG" ] || { echo "::error::a pasta de saída tem de ter só o .dmg"; exit 1; }',
  'for w in app dmg; do',
  '/usr/bin/grep -Eq "\\"sha256\\" *: *\\"$(/bin/cat "$RUNNER_TEMP/notary-$w.sha256")\\"" "$RUNNER_TEMP/notary-$w-log.json" || { echo "::error::o log da notarização ($w) não é do arquivo enviado"; exit 1; }',
  '/usr/bin/grep -Eq \'"status" *: *"Accepted"\' "$RUNNER_TEMP/notary-$w-log.json" || { echo "::error::log da notarização ($w) sem status Accepted"; exit 1; }',
  'done',
  '/usr/bin/hdiutil verify "$DMG"',
  '/usr/bin/codesign --verify --strict --verbose=2 "$DMG"',
  'dinfo=$(/usr/bin/codesign -dvvv "$DMG" 2>&1)',
  'echo "$dinfo"',
  'for l in "Authority=$ID" \'Authority=Developer ID Certification Authority\' \'Authority=Apple Root CA\' "TeamIdentifier=$APPLE_TEAM_ID"; do /usr/bin/grep -qxF "$l" <<< "$dinfo" || { echo "::error::assinatura do .dmg sem a linha: $l"; exit 1; }; done',
  '/usr/bin/grep -q \'^Timestamp=\' <<< "$dinfo" || { echo "::error::.dmg sem carimbo de tempo seguro"; exit 1; }',
  '/usr/bin/xcrun stapler validate "$DMG"',
  'dgk=$(/usr/sbin/spctl --assess --type open --context context:primary-signature -vvv "$DMG" 2>&1)',
  'echo "$dgk"',
  '{ /usr/bin/grep -qF \': accepted\' <<< "$dgk" && /usr/bin/grep -qxF \'source=Notarized Developer ID\' <<< "$dgk"; } || { echo "::error::o Gatekeeper não aceita o .dmg como Notarized Developer ID"; exit 1; }',
  'M="$RUNNER_TEMP/verify-mnt"',
  '/usr/bin/hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$M" "$DMG" > /dev/null',
  'printf \'%s\\n\' "$M/Applications" "$M/simpleMD.app" > "$RUNNER_TEMP/topo-esperado"',
  '/usr/bin/find "$M" -mindepth 1 -maxdepth 1 | LC_ALL=C /usr/bin/sort > "$RUNNER_TEMP/topo-achado"',
  '/usr/bin/diff -u "$RUNNER_TEMP/topo-esperado" "$RUNNER_TEMP/topo-achado" || { echo "::error::o .dmg não tem exatamente Applications e simpleMD.app"; exit 1; }',
  '[ -L "$M/Applications" ] && [ "$(/usr/bin/readlink "$M/Applications")" = /Applications ] || { echo "::error::Applications não é o atalho para /Applications"; exit 1; }',
  'A="$M/simpleMD.app"',
  '(cd "$M" && /usr/bin/find simpleMD.app | LC_ALL=C /usr/bin/sort) > "$RUNNER_TEMP/app-achado"',
  'printf \'%s\\n\' simpleMD.app simpleMD.app/Contents simpleMD.app/Contents/CodeResources simpleMD.app/Contents/Info.plist simpleMD.app/Contents/MacOS simpleMD.app/Contents/MacOS/simplemd simpleMD.app/Contents/Resources simpleMD.app/Contents/Resources/THIRD-PARTY-LICENSES.txt simpleMD.app/Contents/Resources/THIRD-PARTY-NOTICES.md simpleMD.app/Contents/Resources/icon.icns simpleMD.app/Contents/_CodeSignature simpleMD.app/Contents/_CodeSignature/CodeResources | LC_ALL=C /usr/bin/sort > "$RUNNER_TEMP/app-esperado"',
  '/usr/bin/diff -u "$RUNNER_TEMP/app-esperado" "$RUNNER_TEMP/app-achado" || { echo "::error::o .app do .dmg não tem exatamente os arquivos esperados"; exit 1; }',
  '/usr/bin/codesign --verify --deep --strict --verbose=2 "$A"',
  'info=$(/usr/bin/codesign -dvvv "$A" 2>&1)',
  'echo "$info"',
  'for l in \'Identifier=io.github.devrafaelbrauner.simplemd\' "Authority=$ID" \'Authority=Developer ID Certification Authority\' \'Authority=Apple Root CA\' "TeamIdentifier=$APPLE_TEAM_ID"; do /usr/bin/grep -qxF "$l" <<< "$info" || { echo "::error::assinatura do .app sem a linha: $l"; exit 1; }; done',
  '/usr/bin/grep -q \'^Timestamp=\' <<< "$info" || { echo "::error::.app sem carimbo de tempo seguro"; exit 1; }',
  '/usr/bin/grep -Eq \'^CodeDirectory .*flags=0x[0-9a-f]+\\(runtime\\)\' <<< "$info" || { echo "::error::.app sem hardened runtime"; exit 1; }',
  'if /usr/bin/grep -Eq \'adhoc|^Signed Time=\' <<< "$info"; then echo "::error::assinatura ad-hoc ou sem carimbo de tempo seguro"; exit 1; fi',
  'ent=$(/usr/bin/codesign -d --entitlements - --xml "$A" 2>/dev/null)',
  '[ -z "$ent" ] || [ "$(/usr/bin/plutil -convert json -o - - <<< "$ent")" = \'{}\' ] || { echo "::error::o .app assinado tem entitlements"; exit 1; }',
  'req=$(/usr/bin/codesign -d -r- "$A" 2>&1)',
  'echo "$req"',
  '{ /usr/bin/grep -qF \'designated => identifier "io.github.devrafaelbrauner.simplemd" and anchor apple generic\' <<< "$req" && /usr/bin/grep -qF \'certificate leaf[subject.OU] = \' <<< "$req" && /usr/bin/grep -qF "$APPLE_TEAM_ID" <<< "$req"; } || { echo "::error::requisito designado não é o do Developer ID (identificador + Team ID)"; exit 1; }',
  'if /usr/bin/grep -q cdhash <<< "$req"; then echo "::error::requisito designado preso a um cdhash"; exit 1; fi',
  '/usr/bin/xcrun stapler validate "$A"',
  'agk=$(/usr/sbin/spctl --assess --type execute -vvv "$A" 2>&1)',
  'echo "$agk"',
  '{ /usr/bin/grep -qF \': accepted\' <<< "$agk" && /usr/bin/grep -qxF \'source=Notarized Developer ID\' <<< "$agk" && /usr/bin/grep -qxF "origin=$ID" <<< "$agk"; } || { echo "::error::o Gatekeeper não aceita o .app como Notarized Developer ID"; exit 1; }',
  '[ "$(/usr/bin/lipo -archs "$A/Contents/MacOS/simplemd")" = arm64 ] || { echo "::error::o binário não é só arm64"; exit 1; }',
  '[ "$(/usr/bin/grep \'^CDHash=\' <<< "$info")" = "$(/usr/bin/codesign -dvvv "$RUNNER_TEMP/app/simpleMD.app" 2>&1 | /usr/bin/grep \'^CDHash=\')" ] || { echo "::error::o .app do .dmg não é o que foi assinado"; exit 1; }',
  '/usr/bin/hdiutil detach "$M" > /dev/null',
  'sha=$(/usr/bin/shasum -a 256 "$DMG" | /usr/bin/awk \'{print $1}\')',
  'echo "$sha  ${DMG##*/}"',
  'echo "sha256=$sha" >> "$GITHUB_OUTPUT"',
];
const PUBLISH_INPUTS_RUN = [
  '[[ "$DMG_ID" =~ ^[0-9]+$ ]] && [[ "$EXE_ID" =~ ^[0-9]+$ ]] || { echo "::error::id de artefato inválido"; exit 1; }',
  '[[ "$DMG_SHA" =~ ^[0-9a-f]{64}$ ]] && [[ "$EXE_SHA" =~ ^[0-9a-f]{64}$ ]] || { echo "::error::sha256 inválido"; exit 1; }',
];
/** O passo da lista exata do publish (L-1: um arquivo em cada pasta, sha256 conferido, nomes). */
const PUBLISH_LIST_RUN = [
  '[[ "$DMG_SHA" =~ ^[0-9a-f]{64}$ ]] && [[ "$EXE_SHA" =~ ^[0-9a-f]{64}$ ]] || { echo "::error::sha256 inválido"; exit 1; }',
  'V="${TAG#v}"',
  'DMG="simpleMD_${V}_aarch64.dmg"',
  'EXE="simpleMD_${V}_x64-setup.exe"',
  'printf \'%s\\n\' "release/macos/$DMG" "release/windows/$EXE" > "$RUNNER_TEMP/esperado"',
  'find release ! -type d | LC_ALL=C sort > "$RUNNER_TEMP/achado"',
  'diff -u "$RUNNER_TEMP/esperado" "$RUNNER_TEMP/achado" || { echo "::error::os artefatos não são exatamente o .dmg assinado e o -setup.exe de $TAG"; exit 1; }',
  '[ "$(sha256sum -- "release/macos/$DMG" | cut -d\' \' -f1)" = "$DMG_SHA" ] || { echo "::error::o .dmg baixado não é o que o sign-macos conferiu"; exit 1; }',
  '[ "$(sha256sum -- "release/windows/$EXE" | cut -d\' \' -f1)" = "$EXE_SHA" ] || { echo "::error::o -setup.exe baixado não é o que o bundle-windows conferiu"; exit 1; }',
  'mkdir assets',
  'mv -- "release/macos/$DMG" "release/windows/$EXE" assets/',
  'cd assets || exit 1',
  'sha256sum -- "$DMG" "$EXE" > SHA256SUMS',
  'cat SHA256SUMS',
];
// r6/r18 (R-04, AS-R5-M13): o único `gh release` do publish, exato (rascunho de pré-lançamento,
// sem notas: o dono escreve antes de publicar).
const CREATE_RUN_SIGNED =
  'gh release create "$TAG" --repo "$GITHUB_REPOSITORY" --verify-tag --draft --prerelease ' +
  '--title "simpleMD ${TAG#v} (macOS assinado e notarizado; Windows sem assinatura)" ' +
  '--notes \'\' "simpleMD_${TAG#v}_aarch64.dmg" ' +
  '"simpleMD_${TAG#v}_x64-setup.exe" SHA256SUMS';
/** Os downloads do publish: cada arquivo pelo id da saída do job que o conferiu, na sua pasta. */
const SIGNED_DOWNLOADS = JSON.stringify({
  '${{ needs.bundle-windows.outputs.exe-artifact-id }}': 'release/windows',
  '${{ needs.sign-macos.outputs.signed-dmg-artifact-id }}': 'release/macos',
});
/** Saídas de cada job: dados que o job seguinte valida antes de usar (AS-R6-M09). */
const SIGNED_OUTPUTS = {
  'bundle-macos': {
    'app-tar-artifact-id': '${{ steps.upload-app.outputs.artifact-id }}',
    'app-tar-sha256': '${{ steps.app-tar.outputs.sha256 }}',
  },
  'bundle-windows': {
    'exe-artifact-id': '${{ steps.upload-exe.outputs.artifact-id }}',
    'exe-sha256': '${{ steps.exe.outputs.sha256 }}',
  },
  'sign-macos': {
    'signed-dmg-artifact-id': '${{ steps.upload-dmg.outputs.artifact-id }}',
    'signed-dmg-sha256': '${{ steps.verify.outputs.sha256 }}',
  },
};
const APP_TAR_ID_ENV = '${{ needs.bundle-macos.outputs.app-tar-artifact-id }}';
const APP_TAR_SHA_ENV = '${{ needs.bundle-macos.outputs.app-tar-sha256 }}';
/** Os uploads (UM arquivo cada, sem zip) e o único download do sign-macos (por id). */
const APP_UPLOAD = {
  path: '${{ runner.temp }}/simpleMD.app.tar',
  archive: false,
  'retention-days': 1,
  'if-no-files-found': 'error',
};
const EXE_UPLOAD = {
  path: 'apps/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe',
  archive: false,
  'retention-days': 7,
  'if-no-files-found': 'error',
};
const DMG_UPLOAD = {
  path: '${{ runner.temp }}/out/*.dmg',
  archive: false,
  'retention-days': 1,
  'if-no-files-found': 'error',
};
const SIGN_DOWNLOAD = { 'artifact-ids': APP_TAR_ID_ENV, path: '${{ runner.temp }}/in' };
/** A ordem dos passos do sign-macos: segredos → entrada → assinatura → conferência → upload. */
const SIGN_ORDER = [
  'require-signing-secrets',
  'inputs',
  '(download)',
  'intake',
  'sign',
  'verify',
  'upload-dmg',
];
const PUBLISH_INPUTS_ENV = {
  DMG_ID: '${{ needs.sign-macos.outputs.signed-dmg-artifact-id }}',
  DMG_SHA: '${{ needs.sign-macos.outputs.signed-dmg-sha256 }}',
  EXE_ID: '${{ needs.bundle-windows.outputs.exe-artifact-id }}',
  EXE_SHA: '${{ needs.bundle-windows.outputs.exe-sha256 }}',
};
const PUBLISH_LIST_ENV = {
  TAG: TAG_ENV,
  DMG_SHA: PUBLISH_INPUTS_ENV.DMG_SHA,
  EXE_SHA: PUBLISH_INPUTS_ENV.EXE_SHA,
};
/** D-R18-03: o -setup.exe é conferido como NotSigned (vira `Valid` com a assinatura do Windows). */
const NOT_SIGNED_LINES = EXE_RUN.filter((line) =>
  /Get-AuthenticodeSignature|-ne 'NotSigned'/.test(line),
);
/** O portão da identidade do sign (AS-R5-S08): 1 identidade válida, o nome, o SHA-1. */
const IDENTITY_GATE = SIGN_RUN.filter((line) =>
  /valid identities found|Developer ID Application: @NOME@ \(|\^\[0-9A-F\]\{40\}\$/.test(line),
);
/** As únicas linhas do release.yml que podem citar `xattr`/`spctl` (AS-R6-M08/M15). */
const GATEKEEPER_LINE = /^[ad]gk=\$\(\/usr\/sbin\/spctl --assess /;
const BYPASS_ALLOWED_LINES = [
  ...INTAKE_RUN.filter((line) => line.startsWith('/usr/bin/xattr ')),
  ...VERIFY_RUN.filter((line) => GATEKEEPER_LINE.test(line)),
];
/** Ferramentas que o sign-macos só chama por caminho absoluto (AS-R6-M02). */
const BARE_TOOL =
  /(^|[^\w/.$-])(security|codesign|xcrun|ditto|hdiutil|tar|shasum|xattr|plutil|lipo|openssl|base64|spctl|awk|grep|find|sort|diff|tr|tail|cat|readlink|mkdir|ln|rm|stat)(?![\w-])/;
// r5 (AS-R5-M13): o único `gh release` do publish-unsigned, exato.
const CREATE_RUN =
  'gh release create "$TAG" --repo "$GITHUB_REPOSITORY" --verify-tag --draft --prerelease ' +
  '--title "simpleMD ${TAG#v} (pré-lançamento sem assinatura)" --notes-file "$RUNNER_TEMP/notas.md" ' +
  '"simpleMD_${TAG#v}_aarch64.dmg" "simpleMD_${TAG#v}_x64-setup.exe" SHA256SUMS';
// r5 (AS-R5-M19, CI-R5-12, AS-R5-REV-03): o que as notas geradas no job têm de ter, com a
// conferência que imprime o resultado (OK / True) em vez de comparar a soma de olho.
const NOTES_REQUIRED = [
  'https://github.com/devrafaelbrauner/simpleMD/releases',
  'gh attestation verify',
  '--signer-workflow devrafaelbrauner/simpleMD/.github/workflows/release.yml',
  '--source-ref refs/tags/',
  'gh auth login',
  'shasum -a 256 -c --ignore-missing SHA256SUMS',
  'Get-FileHash',
  ".Hash -eq ((Select-String -SimpleMatch '",
  '.\\SHA256SUMS).Line',
  'Abrir Mesmo Assim',
  'Negar',
  // r5 PR-A2 (CR5-S3, AC-R04.2): textos observados na QA (macOS 27.2, Windows 10), não suposições.
  'O Item simpleMD Não Foi Aberto',
  // N11: o sentido do conselho também (o botão destacado apaga o app).
  'Clique em "OK", **não** em "Mover para o Lixo"',
  'O app simpleMD foi bloqueado para proteger o Mac.',
  'Fornecedor: Fornecedor desconhecido',
  'Delete the application data',
  // r5 Tier 2 (QA no release publicado): segundo aviso do macOS, saída para o travamento sem senha e
  // o que a atestação aceita e mostra.
  'Abrir o Item simpleMD?',
  // N18: o sentido do conselho no segundo aviso também (o botão destacado apaga o app).
  'clique em "Abrir Mesmo Assim" (de novo **não** em "Mover para o Lixo"',
  'reinicie o Mac',
  'Use o `.dmg` ou o `-setup.exe` no lugar de `<arquivo>`',
  '✓ Verification succeeded!',
];
/** Instruções para contornar a proteção do sistema (AppSec R2): nunca no release.yml. */
const BYPASS = /xattr|spctl|unblock-file|set-mppreference|master-disable|global-disable|\bsudo\b/i;
/** Rótulo que a QA não viu (WIN-R5-01): o SmartScreen mostra "Fornecedor", não "Editor". */
const WRONG_LABELS = /editor desconhecido|editor aparece como desconhecido/i;
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
      // ---- r6/r18: o caminho assinado (CR3-S1, CR3-R1, AS-R5-S08, L-1; CI-R6, DV-2…15) ----
      const jobOf = (id) => workflow.jobs?.[id] ?? {};
      const at = (id) => `${where}: jobs.${id}`;
      const usesOf = (step) => String(step?.uses ?? '');
      // DV-2: só estes jobs (um job novo com escrita, segredo ou assinatura não entra sem revisão).
      if (
        Object.keys(workflow.jobs ?? {})
          .sort()
          .join() !== [...RELEASE_JOBS].sort().join()
      )
        fail(`${where}: jobs têm de ser exatamente ${RELEASE_JOBS.join(', ')}`);
      // CR3-R2 + CI-R6-04: `secrets` (em qualquer forma) só em job do Environment release em tag
      // v*, nunca no nível do job, e só no env dos passos require-signing-secrets e sign do
      // sign-macos.
      const SECRET_REF = /(?<![\w-])secrets\b/;
      for (const [id, job] of jobs) {
        if (job === null || typeof job !== 'object') continue;
        if (
          /\bsecrets\b/.test(JSON.stringify(job)) &&
          !(environmentOf(job) === 'release' && normIf(job) === RELEASE_TAG_IF)
        )
          fail(`${where}: jobs.${id} usa secrets.* fora do Environment release em tag v*`);
        if (SECRET_REF.test(JSON.stringify({ ...job, steps: [] })))
          fail(`${where}: jobs.${id}: segredos nunca no nível do job`);
        stepsOf(job).forEach((step, i) => {
          const signing =
            id === 'sign-macos' && ['require-signing-secrets', 'sign'].includes(step?.id);
          if (SECRET_REF.test(JSON.stringify(signing ? { ...step, env: {} } : (step ?? {}))))
            fail(
              `${where}: segredos só no env dos passos require-signing-secrets e sign do ` +
                `sign-macos (achado: jobs.${id} passo ${i + 1})`,
            );
        });
      }
      // CI-R6-04: só os 5 segredos da Apple; nada de Apple ID (senha de app), chave por caminho ou
      // Team ID secreto.
      const workflowJson = JSON.stringify(workflow);
      const secretNames = new Set(
        [...workflowJson.matchAll(/(?<![\w-])secrets\.([A-Za-z_]\w*)/g)].map((m) => m[1]),
      );
      if (secretNames.has('APPLE_ID') || secretNames.has('APPLE_PASSWORD'))
        fail(`${where}: notarização por Apple ID não é aceita (secrets.APPLE_ID/APPLE_PASSWORD)`);
      if (secretNames.has('APPLE_API_KEY_PATH'))
        fail(`${where}: secrets.APPLE_API_KEY_PATH não é aceito (a chave .p8 vem em base64)`);
      for (const name of secretNames)
        if (!SIGN_SECRETS.includes(name))
          fail(`${where}: secrets.${name} não é aceito (só ${SIGN_SECRETS.join(', ')})`);
      // AS-R5-S08 por construção: não há identidade de entrada; o sign-macos assina pelo SHA-1 da
      // única identidade válida do .p12. `APPLE_SIGNING_IDENTITY` só no '-' do bundle-dry-run.
      for (const id of SIGNED_JOBS)
        if (/APPLE_SIGNING_IDENTITY/.test(JSON.stringify(jobOf(id))))
          fail(`${at(id)}: APPLE_SIGNING_IDENTITY não é aceito (identidade derivada do .p12)`);
      // DV-12: `vars` só como vars.APPLE_TEAM_ID, no env dos passos require-signing-secrets, sign e
      // verify do sign-macos.
      for (const [id, job] of jobs) {
        if (job === null || typeof job !== 'object') continue;
        const nodes = [{ ...job, steps: [] }, ...stepsOf(job)];
        nodes.forEach((node, n) => {
          const refs = [...JSON.stringify(node ?? {}).matchAll(/\bvars\.([A-Za-z_]\w*)/g)];
          if (refs.length === 0) return;
          const team = id === 'sign-macos' && n > 0 && node?.env?.APPLE_TEAM_ID === TEAM_VAR;
          const rest = team ? { ...node, env: { ...node.env, APPLE_TEAM_ID: '' } } : node;
          if (
            !team ||
            !['require-signing-secrets', 'sign', 'verify'].includes(node?.id) ||
            /\bvars\./.test(JSON.stringify(rest))
          )
            fail(
              `${where}: vars.APPLE_TEAM_ID só no env dos passos require-signing-secrets, sign e ` +
                `verify do sign-macos (achado: jobs.${id})`,
            );
        });
      }
      // CI-R6-06: nenhum outro job recebe APPLE_* (fora o '-' literal do tauri bundle do dry-run).
      for (const [id, job] of jobs) {
        if (job === null || typeof job !== 'object' || id === 'sign-macos') continue;
        for (const node of [job, ...stepsOf(job)])
          for (const [key, value] of Object.entries(node?.env ?? {}))
            if (
              key.startsWith('APPLE_') &&
              !(id === 'bundle-dry-run' && key === 'APPLE_SIGNING_IDENTITY' && value === '-')
            )
              fail(`${where}: jobs.${id}: env com ${key} (APPLE_* só no sign-macos)`);
      }
      // DV-3, CI-R6-09/10/24, DV-13: forma comum dos quatro jobs do caminho assinado.
      for (const id of SIGNED_JOBS) {
        const job = jobOf(id);
        if (normIf(job) !== RELEASE_TAG_IF)
          fail(`${at(id)}: if do caminho assinado tem de ser ${RELEASE_TAG_IF}`);
        if ('strategy' in job) fail(`${at(id)} não pode ser matriz`);
        if ('env' in job || 'defaults' in job) fail(`${at(id)}: sem env/defaults no nível do job`);
        if (job['runs-on'] !== SIGNED_RUNNERS[id])
          fail(`${at(id)}: runner fixado ${SIGNED_RUNNERS[id]} (achado: ${job['runs-on']})`);
        stepsOf(job).forEach((step, i) => {
          if (step !== null && typeof step === 'object' && 'if' in step)
            fail(`${at(id)}: passo com if: (nenhum passo pode ser pulado) (passo ${i + 1})`);
          if (/\bGITHUB_(ENV|PATH)\b/.test(runOf(step)))
            fail(`${at(id)}: GITHUB_ENV/GITHUB_PATH no caminho assinado (passo ${i + 1})`);
          if (
            runOf(step).includes('GITHUB_OUTPUT') &&
            !['app-tar', 'exe', 'verify'].includes(step?.id)
          )
            fail(`${at(id)}: GITHUB_OUTPUT só nos passos app-tar, exe e verify (passo ${i + 1})`);
        });
      }
      for (const [id, job] of jobs)
        stepsOf(job).forEach((step, i) => {
          if (step?.with !== null && typeof step?.with === 'object' && 'overwrite' in step.with)
            fail(`${where}: jobs.${id}: overwrite não é aceito no upload (passo ${i + 1})`);
        });
      // DV-4: os builds sem Environment (não veem segredo); assinatura e publicação no release.
      for (const id of ['bundle-macos', 'bundle-windows'])
        if ('environment' in jobOf(id))
          fail(`${at(id)}: sem Environment (o build não vê segredos)`);
      for (const id of ['sign-macos', 'publish'])
        if (jobOf(id).environment !== 'release') fail(`${at(id)}: Environment tem de ser release`);
      // CI-R6-01: o assinador sem token, depois só do bundle-macos; o publish depois dos dois.
      if (JSON.stringify(jobOf('sign-macos').permissions ?? null) !== '{}')
        fail(`${at('sign-macos')}: permissions tem de ser {} (nenhum token)`);
      if (JSON.stringify([jobOf('sign-macos').needs].flat()) !== '["bundle-macos"]')
        fail(`${at('sign-macos')}: needs tem de ser só bundle-macos`);
      if (
        JSON.stringify([jobOf('publish').needs].flat().sort()) !== '["bundle-windows","sign-macos"]'
      )
        fail(`${at('publish')}: needs tem de ser exatamente bundle-windows e sign-macos`);
      for (const [id, outputs] of Object.entries(SIGNED_OUTPUTS))
        if (JSON.stringify(jobOf(id).outputs ?? null) !== JSON.stringify(outputs))
          fail(`${at(id)}: saídas têm de ser exatamente ${Object.keys(outputs).join(' e ')}`);

      // DV-5/DV-6, CI-R6-09: os dois builds — guard exato, tauri bundle sem identidade, asserts.
      for (const [id, bundleRun] of [
        ['bundle-macos', MAC_BUNDLE_RUN],
        ['bundle-windows', WIN_BUNDLE_RUN],
      ]) {
        const steps = stepsOf(jobOf(id));
        const find = (match) => steps.findIndex(match);
        const checkoutAt = find((s) => usesOf(s).startsWith('actions/checkout@'));
        if (checkoutAt < 0 || steps[checkoutAt]?.with?.['fetch-depth'] !== 0)
          fail(`${at(id)}: checkout sem fetch-depth: 0`);
        const guardAt = find((s) => s?.id === 'release-guard');
        const guard = steps[guardAt];
        const installAt = find((s) => /\bpnpm install\b/.test(runOf(s)));
        const tauriAt = find((s) => /\btauri (build|bundle)\b/.test(runOf(s)));
        if (
          guardAt < 0 ||
          guard.shell !== 'bash' ||
          JSON.stringify(guard.env ?? null) !== JSON.stringify({ TAG: TAG_ENV }) ||
          JSON.stringify(runLines(guard)) !== JSON.stringify(RELEASE_GUARD_RUN) ||
          !(checkoutAt >= 0 && checkoutAt < guardAt && guardAt < installAt && installAt < tauriAt)
        )
          fail(`${at(id)}: falta o release-guard (tag v*, main, versões) antes do install/build`);
        const bundles = steps.filter((s) => /\btauri bundle\b/.test(runOf(s)));
        const bundleAt = steps.indexOf(bundles[0]);
        if (bundles.length !== 1 || runOf(bundles[0]).trim() !== bundleRun || 'env' in bundles[0])
          fail(`${at(id)}: tauri bundle do caminho assinado tem de ser "${bundleRun}", sem env`);
        const uploadAt = find((s) => usesOf(s).startsWith('actions/upload-artifact@'));
        for (const name of ['assert-no-harness.mjs', 'assert-no-ai-recorder.mjs']) {
          const assertAt = find((s) => runOf(s).startsWith(`node scripts/${name}`));
          if (assertAt < 0 || assertAt < bundleAt || uploadAt < assertAt)
            fail(`${at(id)}: ${name} tem de rodar entre o tauri bundle e o upload`);
        }
      }
      // DV-7 (A1): o .app vai num tar com a lista exata (inclui as licenças do r8) e o sha256.
      {
        const steps = stepsOf(jobOf('bundle-macos'));
        const tarAt = steps.findIndex((s) => s?.id === 'app-tar');
        const tar = steps[tarAt];
        if (
          tarAt < 0 ||
          tar.shell !== 'bash' ||
          tar['working-directory'] !== 'apps/desktop/src-tauri/target/release/bundle/macos' ||
          JSON.stringify(runLines(tar)) !== JSON.stringify(APP_TAR_RUN)
        )
          fail(`${at('bundle-macos')}: tar do .app tem de ser o fixado (lista exata e sha256)`);
        const uploads = steps.filter((s) => usesOf(s).startsWith('actions/upload-artifact@'));
        if (
          uploads.length !== 1 ||
          uploads[0].id !== 'upload-app' ||
          steps.indexOf(uploads[0]) < tarAt ||
          JSON.stringify(uploads[0].with ?? null) !== JSON.stringify(APP_UPLOAD)
        )
          fail(
            `${at('bundle-macos')}: o upload sobe só o tar do .app (archive: false, 1 dia, ` +
              'if-no-files-found: error)',
          );
      }
      // DV-8 (CR3-R1, D-R18-03): o -setup.exe é conferido como NotSigned antes do upload.
      {
        const steps = stepsOf(jobOf('bundle-windows'));
        const exeAt = steps.findIndex((s) => s?.id === 'exe');
        const exe = steps[exeAt];
        const lines = runLines(exe);
        if (exeAt < 0 || exe.shell !== 'pwsh' || !NOT_SIGNED_LINES.every((l) => lines.includes(l)))
          fail(
            `${at('bundle-windows')}: o -setup.exe tem de ser conferido como NotSigned antes do upload`,
          );
        else if (JSON.stringify(lines) !== JSON.stringify(EXE_RUN))
          fail(
            `${at('bundle-windows')}: o passo exe tem de ser o fixado (só o -setup.exe, NotSigned, sha256)`,
          );
        const uploads = steps.filter((s) => usesOf(s).startsWith('actions/upload-artifact@'));
        if (
          uploads.length !== 1 ||
          uploads[0].id !== 'upload-exe' ||
          steps.indexOf(uploads[0]) < exeAt ||
          JSON.stringify(uploads[0].with ?? null) !== JSON.stringify(EXE_UPLOAD)
        )
          fail(
            `${at('bundle-windows')}: o upload sobe só o -setup.exe (archive: false, 7 dias, ` +
              'if-no-files-found: error)',
          );
      }

      // ---- sign-macos (CR3-S1, CR3-R1, AS-R5-S08): runner limpo, nada do projeto ----
      const SM = at('sign-macos');
      const signSteps = stepsOf(jobOf('sign-macos'));
      const signStep = (id) => signSteps.find((s) => s?.id === id);
      let publisher;
      try {
        publisher = JSON.parse(read(`${TAURI_DIR}/tauri.conf.json`) ?? 'null')?.bundle?.publisher;
      } catch {
        publisher = undefined;
      }
      if (typeof publisher !== 'string' || publisher.trim() === '')
        fail(`${TAURI_DIR}/tauri.conf.json: bundle.publisher ausente (nome do Developer ID)`);
      const pin = (lines) => lines.map((line) => line.replaceAll('@NOME@', String(publisher)));
      // CI-R6-02/03: sem checkout, só download/upload-artifact, nada do projeto, bash do sistema,
      // ferramentas por caminho absoluto.
      signSteps.forEach((step, i) => {
        const uses = usesOf(step);
        if (uses.startsWith('actions/checkout@'))
          fail(`${SM} não pode fazer checkout (passo ${i + 1})`);
        else if (uses !== '' && !/^actions\/(download-artifact|upload-artifact)@/.test(uses))
          fail(`${SM}: ação não permitida no job de assinatura: ${uses}`);
        if (step === null || typeof step !== 'object' || !('run' in step)) return;
        if (step.shell !== SIGN_SHELL)
          fail(`${SM}: shell tem de ser ${SIGN_SHELL} (passo ${i + 1})`);
        for (const line of runLines(step)) {
          const code = REPO_CODE.exec(line) ?? SIGNER_FORBIDDEN.exec(line);
          if (code)
            fail(`${SM} não pode executar código do projeto nem ${code[0]} (passo ${i + 1})`);
          if (
            /\bset\s+\+e\b|\bset\s+-[a-z]*[xv]|\bxtrace\b|DEVELOPER_DIR|xcode-select|\bsudo\b|default-keychain|login\.keychain|GITHUB_WORKSPACE/.test(
              line,
            )
          )
            fail(
              `${SM}: sem set +e/-x, xtrace, DEVELOPER_DIR, xcode-select, sudo, keychain do ` +
                `usuário ou GITHUB_WORKSPACE (passo ${i + 1})`,
            );
          const bare = BARE_TOOL.exec(
            line.replace(/'[^']*'/g, "''").replace(/echo "(?:[^"\\]|\\.)*"/g, 'echo ""'),
          );
          if (bare) fail(`${SM}: ${bare[2]} sem caminho absoluto (passo ${i + 1})`);
        }
      });
      // CI-R6-05: o 1º passo para sem qualquer segredo ou a variável, antes de qualquer download.
      if (signSteps[0]?.id !== 'require-signing-secrets')
        fail(`${SM}: o 1º passo tem de ser id: require-signing-secrets (fail-closed)`);
      if (
        JSON.stringify(runLines(signStep('require-signing-secrets'))) !==
        JSON.stringify(REQUIRE_SIGNING_RUN)
      )
        fail(
          `${SM}: o require-signing-secrets tem de falhar sem qualquer um dos 5 segredos e da ` +
            'variável APPLE_TEAM_ID, recusar Apple ID e conferir os formatos (linhas exatas)',
        );
      // CI-R6-16: a ordem dos passos (a conferência antes do único upload).
      const signOrder = signSteps.map(
        (s) => s?.id ?? (usesOf(s).startsWith('actions/download-artifact@') ? '(download)' : '?'),
      );
      if (!signOrder.includes('verify'))
        fail(`${SM}: falta o passo verify (verificação da assinatura antes do upload)`);
      else if (
        signOrder.includes('upload-dmg') &&
        signOrder.indexOf('verify') > signOrder.indexOf('upload-dmg')
      )
        fail(`${SM}: o verify tem de rodar antes do upload`);
      if (signOrder.join() !== SIGN_ORDER.join())
        fail(
          `${SM}: passos fora da ordem fixada (${SIGN_ORDER.join(' → ')}; achado: ${signOrder.join(' → ')})`,
        );
      // Os passos com `run`, linha a linha, e o env de cada um.
      for (const [id, want, env] of [
        ['require-signing-secrets', REQUIRE_SIGNING_RUN, JSON.parse(SIGN_ENV)],
        ['inputs', SIGN_INPUTS_RUN, { APP_TAR_ID: APP_TAR_ID_ENV, APP_TAR_SHA: APP_TAR_SHA_ENV }],
        ['intake', INTAKE_RUN, { APP_TAR_SHA: APP_TAR_SHA_ENV, TAG: TAG_ENV }],
        ['sign', pin(SIGN_RUN), JSON.parse(SIGN_ENV)],
        ['verify', pin(VERIFY_RUN), { APPLE_TEAM_ID: TEAM_VAR }],
      ]) {
        const step = signStep(id);
        if (step === undefined) continue;
        const got = runLines(step);
        const k = want.findIndex((line, n) => got[n] !== line);
        if (k >= 0 || got.length !== want.length) {
          const n = k >= 0 ? k : want.length;
          fail(`${SM}: o passo ${id} não é o fixado (linha ${n + 1}: ${got[n] ?? '(falta)'})`);
        }
        if (JSON.stringify(step.env ?? null) !== JSON.stringify(env))
          fail(`${SM}: env do passo ${id} não é o fixado`);
      }
      // CI-R6-07: um download só, pelo id da saída do bundle-macos, com o digest conferido.
      const signDownloads = signSteps.filter((s) =>
        usesOf(s).startsWith('actions/download-artifact@'),
      );
      if (signDownloads.some((s) => (s.with?.['digest-mismatch'] ?? 'error') !== 'error'))
        fail(`${SM}: digest-mismatch tem de ficar no padrão (error)`);
      if (
        signDownloads.length !== 1 ||
        JSON.stringify(signDownloads[0].with ?? null) !== JSON.stringify(SIGN_DOWNLOAD)
      )
        fail(`${SM}: um download só, por artifact-ids da saída do bundle-macos, em runner.temp/in`);
      // CI-R6-17: um upload só, o dmg conferido.
      const signUploads = signSteps.filter((s) => usesOf(s).startsWith('actions/upload-artifact@'));
      if (
        signUploads.length !== 1 ||
        signUploads[0].id !== 'upload-dmg' ||
        JSON.stringify(signUploads[0].with ?? null) !== JSON.stringify(DMG_UPLOAD)
      )
        fail(`${SM}: o upload sobe só o dmg (archive: false, 1 dia, if-no-files-found: error)`);
      // CI-R6-08: toda listagem/extração do tar é crua e a extração é segura.
      for (const id of ['bundle-macos', 'sign-macos'])
        for (const step of stepsOf(jobOf(id)))
          for (const line of runLines(step)) {
            if (!/\/usr\/bin\/tar\b.*\s-(t|tv|x)f\s/.test(line)) continue;
            if (!line.includes("--options 'tar:!mac-ext'"))
              fail(
                `${at(id)}: toda listagem/extração do tar com --options 'tar:!mac-ext' (listagem crua)`,
              );
            if (
              /\s-xf\s/.test(line) &&
              ![
                '--no-xattrs',
                '--no-acls',
                '--no-fflags',
                '--no-mac-metadata',
                '--no-same-owner',
              ].every((flag) => line.includes(flag))
            )
              fail(`${at(id)}: extração do tar sem as opções da extração segura`);
          }
      const signLines = runLines(signStep('sign'));
      const verifyLines = runLines(signStep('verify'));
      // AS-R5-S08 / CI-R6-05/22: o portão da identidade antes do codesign, com o nome provisório
      // igual ao bundle.publisher.
      const firstSignAt = signLines.findIndex((line) => /\bcodesign\b.*\s--sign\s/.test(line));
      if (
        pin(IDENTITY_GATE).some((line) => {
          const k = signLines.indexOf(line);
          return k < 0 || (firstSignAt >= 0 && k > firstSignAt);
        })
      )
        fail(
          `${SM}: falta o portão da identidade antes do codesign (1 identidade válida, Developer ` +
            `ID Application: ${publisher} com o Team ID, SHA-1)`,
        );
      for (const line of [...signLines, ...verifyLines]) {
        const name = /Developer ID Application: ([^"(]+?) \(\$APPLE_TEAM_ID\)/.exec(line)?.[1];
        if (name !== undefined && name !== publisher)
          fail(
            `${SM}: a identidade Developer ID Application: ${name} tem de usar o bundle.publisher ` +
              `do tauri.conf.json (${publisher})`,
          );
      }
      // CI-R6-11 + regra E: assinatura sempre pela identidade, com carimbo de tempo, sem ad-hoc.
      for (const step of signSteps)
        for (const line of runLines(step)) {
          if (!/\bcodesign\b/.test(line) || !/\s(--sign|-s)\s/.test(line)) continue;
          if (/\s(--sign|-s)\s+(-|"-"|'-')(\s|$)/.test(line))
            fail(`${SM}: codesign nunca com --sign - (ad-hoc, AS-R5-S08)`);
          if (/--deep\b/.test(line)) fail(`${SM}: codesign de assinatura sem --deep`);
          if (/--preserve-metadata\b/.test(line))
            fail(`${SM}: codesign de assinatura sem --preserve-metadata`);
          if (/--entitlements\b/.test(line))
            fail(
              `${SM}: codesign sem --entitlements (Entitlements.plist sem chaves; o job não faz ` +
                'checkout)',
            );
          if (
            !['--force', '--keychain "$KC"', '--sign "$SHA1"'].every((p) => line.includes(p)) ||
            !/--timestamp(?!=)/.test(line) ||
            (line.endsWith('"$APP"') && !line.includes('--options runtime'))
          )
            fail(
              `${SM}: codesign de assinatura com --force --timestamp --keychain "$KC" --sign ` +
                `"$SHA1" (e --options runtime no .app): ${line}`,
            );
        }
      const entitlements = read(`${TAURI_DIR}/Entitlements.plist`);
      if (entitlements === null) fail(`${TAURI_DIR}/Entitlements.plist ausente`);
      else if (/<key>/.test(entitlements.replace(/<!--[\s\S]*?-->/g, '')))
        fail(
          `${TAURI_DIR}/Entitlements.plist com chaves: o sign-macos assina sem --entitlements ` +
            '(não faz checkout); mude o desenho antes (regra E)',
        );
      // CI-R6-13/14: keychain temporário com limpeza armada antes; chaves só em $RUNNER_TEMP e
      // apagadas logo depois do uso.
      const trapAt = signLines.indexOf('trap cleanup EXIT INT TERM');
      const createAt = signLines.findIndex((line) =>
        line.startsWith('/usr/bin/security create-keychain '),
      );
      if (trapAt < 0 || createAt < 0 || trapAt > createAt)
        fail(
          `${SM}: limpeza (trap cleanup EXIT INT TERM) armada antes do security create-keychain`,
        );
      for (const line of signLines.filter((l) => /\bsecurity import\b/.test(l)))
        if (!line.includes('-T /usr/bin/codesign') || /\s-A(\s|$)/.test(line))
          fail(`${SM}: security import só com -T /usr/bin/codesign (nunca -A)`);
      for (const file of ['devid.p12', 'AuthKey.p8']) {
        const decodeAt = signLines.findIndex(
          (l) =>
            l.startsWith('/usr/bin/base64 --decode ') && l.endsWith(`> "$RUNNER_TEMP/${file}"`),
        );
        const rmAt = signLines.findIndex(
          (l, k) => k > decodeAt && l === `/bin/rm -f "$RUNNER_TEMP/${file}"`,
        );
        if (decodeAt < 0 || rmAt < 0)
          fail(`${SM}: o ${file} só em $RUNNER_TEMP e apagado logo depois do uso`);
      }
      // CI-R6-15: notarização só pela chave de API, esperando o resultado e trazendo o log.
      const notary = signLines.filter((line) => /\bnotarytool\b/.test(line));
      if (
        notary.length !== 3 ||
        !notary[0].startsWith(
          '/usr/bin/xcrun notarytool store-credentials simplemd-notary --key ',
        ) ||
        !/^\/usr\/bin\/xcrun notarytool submit .* --keychain-profile simplemd-notary --keychain "\$KC" --wait\b/.test(
          notary[1],
        ) ||
        !notary[2].startsWith(
          '/usr/bin/xcrun notarytool log "$sub" --keychain-profile simplemd-notary',
        ) ||
        notary.some((line) => /--(apple-id|password|team-id|force)\b/.test(line))
      )
        fail(
          `${SM}: notarytool só com a chave de API (store-credentials), submit --wait e o log ` +
            '(sem Apple ID, senha, --team-id ou --force)',
        );
      // CI-R6-16 (CR3-R1 + AS-R5-S08): a conferência completa, antes do upload.
      const verifyHas = (needle) => verifyLines.some((line) => line.includes(needle));
      if (verifyLines[0] !== TEAM_FORMAT_LINE)
        fail(`${SM}: o verify começa conferindo o formato do APPLE_TEAM_ID (AS-R5-S08)`);
      if (!verifyHas(VERIFY_RUN[1]))
        fail(`${SM}: o verify tem de conferir keychain ausente e chaves apagadas`);
      const chainLines = verifyLines.filter(
        (line) =>
          line.startsWith('for l in ') &&
          line.includes(
            "'Authority=Developer ID Certification Authority' 'Authority=Apple Root CA'",
          ),
      );
      if (
        chainLines.length !== 2 ||
        !chainLines.every((line) => line.includes('"TeamIdentifier=$APPLE_TEAM_ID"'))
      )
        fail(
          `${SM}: o verify tem de exigir a cadeia do Developer ID e TeamIdentifier=$APPLE_TEAM_ID ` +
            'no .app e no dmg',
        );
      if (!verifyHas('if /usr/bin/grep -Eq \'adhoc|^Signed Time=\' <<< "$info"; then'))
        fail(`${SM}: o verify tem de recusar assinatura adhoc ou sem carimbo de tempo seguro`);
      if (
        !verifyHas('/usr/bin/codesign --verify --strict --verbose=2 "$DMG"') ||
        !verifyHas('/usr/bin/codesign --verify --deep --strict --verbose=2 "$A"')
      )
        fail(`${SM}: o verify tem de rodar codesign --verify --strict no dmg e --deep no .app`);
      if (
        !verifyHas('/usr/bin/xcrun stapler validate "$DMG"') ||
        !verifyHas('/usr/bin/xcrun stapler validate "$A"')
      )
        fail(`${SM}: o verify tem de rodar stapler validate no .app e no dmg`);
      if (
        verifyLines.filter((line) => GATEKEEPER_LINE.test(line)).length !== 2 ||
        verifyLines.filter((line) =>
          line.includes("/usr/bin/grep -qxF 'source=Notarized Developer ID'"),
        ).length !== 2
      )
        fail(`${SM}: o verify tem de passar o spctl (Notarized Developer ID) no .app e no dmg`);
      if (!verifyHas('if /usr/bin/grep -q cdhash <<< "$req"; then'))
        fail(`${SM}: o verify tem de recusar requisito designado preso a cdhash`);

      // ---- publish (L-1, CR3-R1): só o que foi conferido, por id, com a lista exata ----
      const PB = at('publish');
      const pubSteps = stepsOf(jobOf('publish'));
      pubSteps.forEach((step) => {
        const uses = usesOf(step);
        if (uses.startsWith('actions/checkout@'))
          fail(`${PB} não pode fazer checkout (token de escrita)`);
        else if (
          uses !== '' &&
          !/^actions\/(download-artifact|attest-build-provenance)@/.test(uses)
        )
          fail(
            `${PB} só usa actions/download-artifact e actions/attest-build-provenance (${uses})`,
          );
        if (REPO_CODE.test(runOf(step)))
          fail(`${PB} não pode executar código do repositório: ${step.run}`);
      });
      if (
        JSON.stringify(jobOf('publish').permissions ?? null) !==
        JSON.stringify({ contents: 'write', 'id-token': 'write', attestations: 'write' })
      )
        fail(`${PB}: permissions exatamente contents, id-token e attestations: write`);
      if (
        JSON.stringify(runLines(pubSteps[0])) !== JSON.stringify(PUBLISH_INPUTS_RUN) ||
        JSON.stringify(pubSteps[0]?.env ?? null) !== JSON.stringify(PUBLISH_INPUTS_ENV)
      )
        fail(`${PB}: o 1º passo valida as saídas (ids e sha256) antes de baixar`);
      const pubDownloads = pubSteps.filter((s) =>
        usesOf(s).startsWith('actions/download-artifact@'),
      );
      const pubDownloadPaths = JSON.stringify(
        Object.fromEntries(
          pubDownloads.map((s) => [String(s.with?.['artifact-ids']), String(s.with?.path)]).sort(),
        ),
      );
      if (
        pubDownloads.length !== 2 ||
        pubDownloads.some(
          (s) =>
            Object.keys(s.with ?? {})
              .sort()
              .join() !== 'artifact-ids,path',
        ) ||
        pubDownloadPaths !== SIGNED_DOWNLOADS
      )
        fail(
          `${PB} baixa só pelos artifact-ids das saídas do sign-macos e do bundle-windows, cada um ` +
            'na sua pasta (release/macos, release/windows)',
        );
      const pubListAt = pubSteps.findIndex((s) => s?.name === 'Lista exata e SHA256SUMS');
      const pubList = pubSteps[pubListAt];
      if (
        pubListAt < 0 ||
        pubList.shell !== 'bash' ||
        JSON.stringify(pubList.env ?? null) !== JSON.stringify(PUBLISH_LIST_ENV) ||
        JSON.stringify(runLines(pubList)) !== JSON.stringify(PUBLISH_LIST_RUN)
      )
        fail(
          `${PB}: a lista exata tem de ser a fixada (os 2 arquivos, o sha256 de cada um igual ao ` +
            'conferido, SHA256SUMS com os nomes)',
        );
      if (pubSteps.some((s) => /sha256sum\b[^\n]*\*/.test(runOf(s))))
        fail(`${PB}: SHA256SUMS só com os nomes (sha256sum -- "$DMG" "$EXE"); glob é o L-1`);
      const pubCreates = pubSteps.filter((s) => /\bgh release\b/.test(runOf(s)));
      const pubCreate = pubCreates[0];
      const pubCreateAt = pubSteps.indexOf(pubCreate);
      const pubAttestAt = pubSteps.findIndex(
        (s) =>
          usesOf(s).startsWith('actions/attest-build-provenance@') &&
          s.with?.['subject-checksums'] === 'assets/SHA256SUMS',
      );
      if (pubAttestAt < 0 || pubAttestAt < pubListAt || pubCreateAt < pubAttestAt)
        fail(`${PB}: falta a atestação antes do gh release create`);
      if (
        pubCreates.length !== 1 ||
        runOf(pubCreate).trim() !== CREATE_RUN_SIGNED ||
        pubCreate['working-directory'] !== 'assets' ||
        JSON.stringify(pubCreate.env ?? null) !==
          JSON.stringify({ GH_TOKEN: '${{ github.token }}', TAG: TAG_ENV })
      )
        fail(
          `${PB}: gh release create com --verify-tag --draft --prerelease, sem notas, e só o .dmg, ` +
            'o -setup.exe e SHA256SUMS',
        );
      if (
        pubSteps.some(
          (s) => s !== pubCreate && /GH_TOKEN|GITHUB_TOKEN|github\.token/.test(JSON.stringify(s)),
        )
      )
        fail(`${PB}: o token só no env do passo gh release create`);
      if (/APPLE_SIGNING_IDENTITY/.test(JSON.stringify(workflow.env ?? {})))
        fail(`${where}: env do workflow com APPLE_SIGNING_IDENTITY`);

      // ---- r5: pré-lançamento sem assinatura (AS-R5-M01…M19, CI-R5-01…12) ----
      // CI-R5-02 (C1): o opt-in é um input booleano tipado (nunca string: 'false' é verdadeiro).
      if (!dispatchOk(workflow.on?.workflow_dispatch))
        fail(
          `${where}: workflow_dispatch só aceita o input booleano unsigned_prerelease (default false)`,
        );
      // CI-R5-12 (R2): nada que ensine a contornar a proteção do sistema; CI-R5-06: nada de mexer
      // em release já criado. DV-11: as únicas exceções são o `xattr -cr` do intake e os dois
      // `spctl --assess` do verify do sign-macos (linhas exatas, uma vez cada); `--no-xattrs` é a
      // opção do tar que descarta atributos, não instrução.
      let scrubbed = text.replaceAll(' --no-xattrs', '');
      for (const line of BYPASS_ALLOWED_LINES)
        scrubbed = scrubbed.replace(`\n          ${line}\n`, '\n');
      const bypass = BYPASS.exec(scrubbed);
      if (bypass)
        fail(`${where}: instrução para contornar a proteção do sistema (achado: ${bypass[0]})`);
      const wrongLabel = WRONG_LABELS.exec(text);
      if (wrongLabel)
        fail(`${where}: rótulo que a QA não observou nas notas (achado: ${wrongLabel[0]})`);
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
        // CR5 N2: um assert com `if:` poderia ser pulado.
        else if ('if' in drySteps[at]) fail(`${D}: ${name} não pode ter if:`);
      }

      const unsigned = workflow.jobs?.['publish-unsigned'];
      if (unsigned !== undefined) {
        const P = `${where}: jobs.publish-unsigned`;
        const unsignedSteps = stepsOf(unsigned);
        const usesOf = (step) => String(step?.uses ?? '');
        // C2 (AS-R5-M03): só depois de TODAS as pernas do dry-run (que passaram pelo guard).
        if (JSON.stringify([unsigned?.needs].flat()) !== '["bundle-dry-run"]')
          fail(`${P} tem de ter needs: bundle-dry-run`);
        // C3 (AS-R5-M04): o publish-unsigned não lê secrets (nem tem por quê).
        if (/\bsecrets\b/.test(JSON.stringify(unsigned))) fail(`${P} não pode ler secrets`);
        // CR5-S2: nada no nível do job chega a todos os passos (token, shell, diretório), e o job
        // roda num runner do GitHub (as notas mandam conferir com --deny-self-hosted-runners).
        if ('env' in unsigned || 'defaults' in unsigned)
          fail(`${P}: sem env/defaults no nível do job (o token só no passo do gh release create)`);
        if (/GH_TOKEN|GITHUB_TOKEN|github\.token/.test(JSON.stringify({ ...unsigned, steps: [] })))
          fail(`${P}: o token só no env do passo gh release create`);
        if (unsigned['runs-on'] !== 'ubuntu-latest') fail(`${P}: runs-on tem de ser ubuntu-latest`);
        // CR5-S1: nenhum passo do publish-unsigned pode ser pulado (a atestação seria a única
        // falha aberta: o rascunho sairia sem proveniência).
        unsignedSteps.forEach((step, i) => {
          if (step !== null && typeof step === 'object' && 'if' in step)
            fail(`${P}: passo com if: (nenhum passo pode ser pulado) (passo ${i + 1})`);
        });
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
        // C7 (AS-R5-M10, AS-R5-REV-01): os dois artefatos desta execução, por nome exato, cada um
        // na sua pasta.
        const downloads = unsignedSteps.filter((s) =>
          usesOf(s).startsWith('actions/download-artifact@'),
        );
        const downloadPaths = JSON.stringify(
          Object.fromEntries(
            downloads.map((s) => [String(s.with?.name), String(s.with?.path)]).sort(),
          ),
        );
        if (
          downloads.length !== 2 ||
          downloads.some(
            (s) =>
              Object.keys(s.with ?? {})
                .sort()
                .join() !== 'name,path',
          ) ||
          downloadPaths !== DOWNLOAD_PATHS
        )
          fail(
            `${P} baixa só bundle-dry-run-macos e bundle-dry-run-windows, por nome, cada um na sua ` +
              'pasta (release/macos, release/windows)',
          );
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
if (releaseAge < 10080)
  fail(`pnpm-workspace.yaml: minimumReleaseAge ausente ou < 10080 (achado: ${releaseAge})`);
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
