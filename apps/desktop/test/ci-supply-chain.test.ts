// Etapa 12a (R-12.4, AC-12.8): o portão `scripts/check-ci-supply-chain.mjs` (parte de
// `pnpm check:security`) aprova o CI do repositório e reprova cada regressão da cadeia de
// suprimentos: ação por tag, checkout com credencial persistida, permissão de escrita, toolchain
// flutuante, job de gitleaks/trufflehog/auditoria/osv-scanner/Semgrep fixado ausente, download sem
// sha256 e política do pnpm. r5 (pré-lançamento sem assinatura, CI-R5-01…12 / C1–C19): o caminho
// `bundle-dry-run` → `publish-unsigned` do release.yml e o `-- --locked` de todo `tauri build`.
// B-01 (Windows pelo SignPath Foundation): `build-windows` → `sign-windows-exe` → `bundle-windows` →
// `sign-windows-installer` e o `publish` que baixa pelos IDs só os bundles assinados.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const ROOT = join(__dirname, '../../..');
const SCRIPT = join(ROOT, 'scripts/check-ci-supply-chain.mjs');
const FILES = [
  '.github',
  '.node-version',
  'rust-toolchain.toml',
  'pnpm-workspace.yaml',
  'osv-scanner.toml',
  'apps/desktop/src-tauri/tauri.conf.json',
  'apps/desktop/src-tauri/tauri.release.conf.json',
];
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';

const RELEASE = '.github/workflows/release.yml';

/** Troca a última ocorrência de `from` por `to`. */
function replaceLast(text: string, from: string, to: string): string {
  const at = text.lastIndexOf(from);
  return at < 0 ? text : text.slice(0, at) + to + text.slice(at + from.length);
}

/** Início (linha `      - …`) e fim do passo do workflow que contém `needle`. */
function stepRange(text: string, needle: string): [number, number] {
  const at = text.indexOf(needle);
  const start = text.lastIndexOf('\n      - ', at) + 1;
  const next = text.indexOf('\n      - ', at);
  const blank = text.indexOf('\n\n', at);
  const ends = [next, blank].filter((i) => i >= 0).map((i) => i + 1);
  return [start, ends.length > 0 ? Math.min(...ends) : text.length];
}

/** Tira o passo que contém `needle` e o insere antes do índice que `where` devolve. */
function moveStep(text: string, needle: string, where: (rest: string) => number): string {
  const [start, end] = stepRange(text, needle);
  const step = text.slice(start, end);
  const rest = text.slice(0, start) + text.slice(end);
  const at = where(rest);
  return rest.slice(0, at) + step + rest.slice(at);
}

/** Insere `extra` antes do passo que contém `needle`. */
function beforeStep(text: string, needle: string, extra: string): string {
  const [start] = stepRange(text, needle);
  return text.slice(0, start) + extra + text.slice(start);
}

/** Fim do job bundle-dry-run (a linha em branco que o separa do job seguinte). */
const endOfDryRun = (t: string) => t.indexOf('\n\n', t.indexOf('\n  bundle-dry-run:\n')) + 1;

/** Troca a 1ª ocorrência de `from` dentro do job `id` do workflow (até o job seguinte). */
const inJob =
  (id: string, from: string | RegExp, to: string) =>
  (t: string): string => {
    const start = t.indexOf(`\n  ${id}:\n`);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = /\n {2}[\w-]+:\n/g;
    next.lastIndex = start + 1;
    const end = next.exec(t)?.index ?? t.length;
    return t.slice(0, start) + t.slice(start, end).replace(from, to) + t.slice(end);
  };
const run = (root?: string) =>
  spawnSync(process.execPath, root ? [SCRIPT, root] : [SCRIPT], { encoding: 'utf8' });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Cópia dos arquivos conferidos com uma alteração em `file`. */
function mutated(file: string, change: (text: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), 'smd-ci-gate-'));
  dirs.push(dir);
  for (const name of FILES) cpSync(join(ROOT, name), join(dir, name), { recursive: true });
  const target = join(dir, file);
  const before = readFileSync(target, 'utf8');
  const after = change(before);
  expect(after).not.toBe(before);
  writeFileSync(target, after);
  return dir;
}

describe('check:ci — cadeia de suprimentos do CI (AC-12.8)', () => {
  test('o CI do repositório passa: SHAs, persist-credentials, toolchains, jobs e pnpm', () => {
    const r = run();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('check:ci — OK');
    expect(r.stdout).toMatch(
      /jobs: gitleaks ci\.yml#secrets, auditoria ci\.yml#audit, semgrep ci\.yml#semgrep/,
    );
    // AC-B01.8 + r5: as escritas aceitas são só as dos jobs publish e publish-unsigned.
    expect(r.stdout).toContain(
      'exceções de escrita release.yml#publish, release.yml#publish-unsigned',
    );
  });

  test('a cópia sem alteração também passa (o portão lê a raiz recebida)', () => {
    const dir = mutated('.node-version', (t) => `${t}\n`);
    expect(run(dir).status).toBe(0);
  });

  test.each([
    {
      name: 'ação por tag mutável (AS-05/Secrets F-2)',
      file: '.github/workflows/ci.yml',
      change: (t: string) => t.replace(CHECKOUT, 'actions/checkout@v7'),
      message: 'ação não fixada por SHA de 40 hex: actions/checkout@v7',
    },
    {
      name: 'SHA sem a versão no comentário',
      file: '.github/workflows/ci.yml',
      change: (t: string) => t.replace(CHECKOUT, CHECKOUT.replace(' # v7.0.1', '')),
      message: 'ação fixada sem a versão no comentário',
    },
    {
      name: 'checkout com credencial persistida (Secrets F-3)',
      file: '.github/workflows/ci.yml',
      // Só a chave YAML (o comentário do topo do ci.yml também cita a opção).
      change: (t: string) =>
        t.replace(/^(\s+)persist-credentials: false$/m, '$1persist-credentials: true'),
      message: 'actions/checkout sem persist-credentials: false',
    },
    {
      name: 'permissão de escrita',
      file: '.github/workflows/ci.yml',
      change: (t: string) => t.replace('contents: read', 'contents: write'),
      message: 'permissão de escrita no CI: contents: write',
    },
    {
      name: 'CR2-05: sem o bloco permissions no topo (o token volta ao padrão do repositório)',
      file: '.github/workflows/ci.yml',
      change: (t: string) => t.replace(/^permissions:\n {2}contents: read\n/m, ''),
      message: 'jobs.lint sem bloco permissions',
    },
    {
      name: 'CR2-05: escrita em forma de fluxo no topo',
      file: '.github/workflows/ci.yml',
      change: (t: string) =>
        t.replace(/^permissions:\n {2}contents: read\n/m, 'permissions: { contents: write }\n'),
      message: 'permissão de escrita no CI: contents: write',
    },
    {
      name: 'CR2-05: escrita entre aspas num job',
      file: '.github/workflows/ci.yml',
      change: (t: string) =>
        t.replace(/^( {2}lint:\n)/m, "$1    permissions:\n      id-token: 'write'\n"),
      message: 'jobs.lint: permissão de escrita no CI: id-token: write',
    },
    {
      name: 'CR2-05: write-all',
      file: '.github/workflows/ci.yml',
      change: (t: string) =>
        t.replace(/^permissions:\n {2}contents: read\n/m, 'permissions: "write-all"\n'),
      message: 'permissão de escrita no CI: write-all',
    },
    {
      name: 'Node fixo no workflow em vez de .node-version (DO-1)',
      file: '.github/workflows/ci.yml',
      change: (t: string) => t.replace('node-version-file: .node-version', 'node-version: 22'),
      message: 'actions/setup-node sem node-version-file: .node-version',
    },
    {
      name: 'imagem do Semgrep sem digest',
      file: '.github/workflows/ci.yml',
      change: (t: string) => t.replace(/(semgrep\/semgrep:[\d.]+)@sha256:[0-9a-f]{64}/, '$1'),
      message: 'imagem de contêiner sem digest sha256',
    },
    {
      name: 'gitleaks sem o histórico inteiro (Secrets F-1)',
      file: '.github/workflows/ci.yml',
      change: (t: string) => t.replace('fetch-depth: 0', 'fetch-depth: 1'),
      message: 'falta o job do gitleaks no histórico inteiro',
    },
    {
      name: 'auditoria sem o limite alto (DO-4)',
      file: '.github/workflows/ci.yml',
      change: (t: string) => t.replace('pnpm audit --prod --audit-level high', 'pnpm audit --prod'),
      message: 'falta o job de auditoria',
    },
    {
      // RG-R3-2 / DEC-A8 (B-18, AC-B18.5): substitui 'Semgrep sem um dos conjuntos de regras da
      // AppSec'; o job obrigatório agora usa regras fixadas e reprova as do registro.
      name: 'Semgrep obrigatório com regras flutuantes do registro (B-18)',
      file: '.github/workflows/ci.yml',
      change: (t: string) => t.replace('--config "$RUNNER_TEMP/semgrep-pinned"', '--config auto'),
      message: 'ci.yml#semgrep usa regras flutuantes do registro',
    },
    {
      name: 'regras do Semgrep sem conferência do sha256 (B-18)',
      file: '.github/workflows/ci.yml',
      change: (t: string) => t.replace(/^.*\$\{SEMGREP_RULES_SHA256\}.*\n/m, ''),
      message: 'o job ci.yml#semgrep baixa com curl sem conferir o sha256',
    },
    {
      name: 'regras do Semgrep por branch em vez de commit (B-18)',
      file: '.github/workflows/ci.yml',
      change: (t: string) =>
        t.replace(/SEMGREP_RULES_COMMIT: [0-9a-f]{40}/, 'SEMGREP_RULES_COMMIT: develop'),
      message: 'falta o job ci.yml#semgrep com --error, --metrics=off e as regras fixadas',
    },
    {
      name: 'lista de regras do Semgrep fora do repositório de regras (B-18)',
      file: '.github/semgrep-rules.txt',
      change: (t: string) => `${t}../../etc/x.yaml\n`,
      message: 'caminho de regra inválido: ../../etc/x.yaml',
    },
    {
      name: 'trufflehog removido (B-05)',
      file: '.github/workflows/ci.yml',
      change: (t: string) => t.replace(/^.*trufflehog" git file:.*\n/m, ''),
      message: 'falta o job do trufflehog fixado',
    },
    {
      name: 'trufflehog sem --no-update (B-05)',
      file: '.github/workflows/ci.yml',
      change: (t: string) => t.replace(' --fail --no-update', ' --fail'),
      message: 'falta o job do trufflehog fixado',
    },
    {
      name: 'download do trufflehog sem conferência do sha256, o do gitleaks mantido (B-05)',
      file: '.github/workflows/ci.yml',
      change: (t: string) => t.replace(/^.*\$\{TRUFFLEHOG_SHA256\}.*\n/m, ''),
      message: 'o job ci.yml#secrets baixa com curl sem conferir o sha256 (2 curl, 1 sha256sum',
    },
    {
      name: 'osv-scanner sem o Cargo.lock (B-05)',
      file: '.github/workflows/ci.yml',
      change: (t: string) => t.replace(' --lockfile apps/desktop/src-tauri/Cargo.lock', ''),
      message: 'falta o osv-scanner fixado',
    },
    {
      name: 'osv-scanner baixado da versão mais recente (B-05)',
      file: '.github/workflows/ci.yml',
      change: (t: string) =>
        t.replace('releases/download/v${OSV_SCANNER_VERSION}/', 'releases/latest/download/'),
      message: 'falta o osv-scanner fixado',
    },
    {
      name: 'download sem conferência do sha256',
      file: '.github/workflows/ci.yml',
      change: (t: string) => t.replaceAll('sha256sum --check --strict', 'true'),
      message: 'baixa com curl sem conferir o sha256',
    },
    {
      name: 'Rust flutuante (DO-1)',
      file: 'rust-toolchain.toml',
      change: (t: string) => t.replace(/channel = "[^"]+"/, 'channel = "stable"'),
      message: 'rust-toolchain.toml: channel deve ser uma versão exata (achado: stable)',
    },
    {
      name: 'Node sem versão exata (DO-1)',
      file: '.node-version',
      change: () => '22\n',
      message: '.node-version: versão exata do Node ausente (achado: 22)',
    },
    {
      name: 'pnpm sem trustPolicy (AS-06)',
      file: 'pnpm-workspace.yaml',
      change: (t: string) => t.replace('trustPolicy: no-downgrade', 'trustPolicy: off'),
      message: 'trustPolicy: no-downgrade ausente',
    },
    {
      name: 'pnpm com minimumReleaseAge baixo (AS-06)',
      file: 'pnpm-workspace.yaml',
      change: (t: string) => t.replace(/^minimumReleaseAge: \d+$/m, 'minimumReleaseAge: 60'),
      message: 'minimumReleaseAge ausente ou < 1440 (achado: 60)',
    },
    {
      name: 'CR3-A1: -c com regras do registro além do diretório fixado',
      file: '.github/workflows/ci.yml',
      change: (t: string) =>
        t.replace(
          '--config "$RUNNER_TEMP/semgrep-pinned"',
          '--config "$RUNNER_TEMP/semgrep-pinned" -c p/rust',
        ),
      message: 'ci.yml#semgrep tem de rodar só com --config "$RUNNER_TEMP/semgrep-pinned"',
    },
    {
      name: 'CR3-A1: --config com URL do registro',
      file: '.github/workflows/ci.yml',
      change: (t: string) =>
        t.replace(
          '--config "$RUNNER_TEMP/semgrep-pinned"',
          '--config "$RUNNER_TEMP/semgrep-pinned" --config https://semgrep.dev/c/p/rust',
        ),
      message: 'ci.yml#semgrep tem de rodar só com --config "$RUNNER_TEMP/semgrep-pinned"',
    },
    {
      name: 'CR3-A1: variável SEMGREP_RULES no job',
      file: '.github/workflows/ci.yml',
      change: (t: string) =>
        t.replace(/^( +)(SEMGREP_RULES_SHA256: .*\n)/m, '$1$2$1SEMGREP_RULES: p/rust\n'),
      message: 'ci.yml#semgrep tem de rodar só com --config "$RUNNER_TEMP/semgrep-pinned"',
    },
    {
      name: 'CR3-A1: diretório de regras do repositório no lugar do fixado',
      file: '.github/workflows/ci.yml',
      change: (t: string) =>
        t.replace('--config "$RUNNER_TEMP/semgrep-pinned"', '--config .semgrep'),
      message: 'ci.yml#semgrep tem de rodar só com --config "$RUNNER_TEMP/semgrep-pinned"',
    },
    {
      name: 'AC-B01.8 (b): pull_request no release.yml',
      file: '.github/workflows/release.yml',
      change: (t: string) =>
        t.replace('  workflow_dispatch:\n', '  pull_request:\n  workflow_dispatch:\n'),
      message: "release.yml: gatilhos só push.tags ['v*'] e workflow_dispatch",
    },
    {
      name: 'AC-B01.8 (c): publish sem environment: release',
      file: '.github/workflows/release.yml',
      change: (t: string) =>
        t.replace(
          '    environment: release\n    runs-on: ubuntu-latest\n',
          '    runs-on: ubuntu-latest\n',
        ),
      message: 'jobs.publish: permissão de escrita no CI: contents: write',
    },
    {
      name: 'AC-B01.8 (d): escopo de escrita fora da lista no publish',
      file: '.github/workflows/release.yml',
      change: (t: string) =>
        t.replace(/^( +)attestations: write/m, '$1attestations: write\n$1packages: write'),
      message: 'jobs.publish: permissão de escrita no CI: packages: write',
    },
    {
      name: 'AC-B01.8: escrita copiada para o bundle-dry-run',
      file: '.github/workflows/release.yml',
      change: (t: string) =>
        t.replace(
          '  bundle-dry-run:\n',
          '  bundle-dry-run:\n    permissions:\n      contents: write\n',
        ),
      message: 'jobs.bundle-dry-run: permissão de escrita no CI: contents: write',
    },
    {
      name: 'AC-B01.7: segredo no caminho do dry-run',
      file: '.github/workflows/release.yml',
      change: (t: string) =>
        t.replace(
          '  bundle-dry-run:\n',
          '  bundle-dry-run:\n    env:\n      APPLE_ID: ${{ secrets.APPLE_ID }}\n',
        ),
      message: 'jobs.bundle-dry-run usa secrets.* fora do Environment release em tag v*',
    },
    {
      name: 'AC-B01.7: passo antes do require-signing-secrets (fail-closed)',
      file: '.github/workflows/release.yml',
      change: inJob(
        'bundle-release',
        '      - id: require-signing-secrets\n',
        '      - run: echo antes\n      - id: require-signing-secrets\n',
      ),
      message: 'jobs.bundle-release: o 1º passo tem de ser id: require-signing-secrets',
    },
    {
      name: 'CR3-R2: publish sem needs: bundle-release',
      file: '.github/workflows/release.yml',
      change: inJob(
        'publish',
        'needs: [bundle-release, sign-windows-installer]',
        'needs: sign-windows-installer',
      ),
      message: 'jobs.publish tem de ter needs: bundle-release e sign-windows-installer',
    },
    {
      name: 'B-01: publish sem needs: sign-windows-installer',
      file: '.github/workflows/release.yml',
      change: inJob(
        'publish',
        'needs: [bundle-release, sign-windows-installer]',
        'needs: bundle-release',
      ),
      message: 'jobs.publish tem de ter needs: bundle-release e sign-windows-installer',
    },
    {
      name: 'CR3-R2: checkout no publish (token de escrita)',
      file: '.github/workflows/release.yml',
      change: inJob(
        'publish',
        '      - uses: actions/download-artifact@',
        `      - uses: ${CHECKOUT}\n        with:\n          persist-credentials: false\n      - uses: actions/download-artifact@`,
      ),
      message: 'jobs.publish não pode fazer checkout',
    },
    {
      name: 'CR3-R2: script do repositório no publish',
      file: '.github/workflows/release.yml',
      change: inJob(
        'publish',
        '          cd release\n',
        '          cd release\n          node scripts/x.mjs\n',
      ),
      message: 'jobs.publish não pode executar código do repositório',
    },
    {
      name: 'CR3-R2: toJSON(secrets) no dry-run',
      file: '.github/workflows/release.yml',
      change: (t: string) =>
        t.replace(
          '  bundle-dry-run:\n',
          '  bundle-dry-run:\n    env:\n      ALL: ${{ toJSON(secrets) }}\n',
        ),
      message: 'jobs.bundle-dry-run usa secrets.* fora do Environment release em tag v*',
    },
    {
      name: "CR3-R2: secrets['X'] no dry-run",
      file: '.github/workflows/release.yml',
      change: (t: string) =>
        t.replace(
          '  bundle-dry-run:\n',
          "  bundle-dry-run:\n    env:\n      X: ${{ secrets['APPLE_ID'] }}\n",
        ),
      message: 'jobs.bundle-dry-run usa secrets.* fora do Environment release em tag v*',
    },
    {
      name: 'CR3-R2: secrets no env do workflow',
      file: '.github/workflows/release.yml',
      change: (t: string) =>
        t.replace(/^permissions:\n/m, 'env:\n  APPLE_ID: ${{ secrets.APPLE_ID }}\npermissions:\n'),
      message: 'env do workflow lê secrets',
    },
    {
      name: 'APPSEC-R3-01: segredos de assinatura no passo do tauri build',
      file: '.github/workflows/release.yml',
      // A última ocorrência é a do bundle-release (o dry-run vem antes).
      change: (t: string) => {
        const step = '      - run: pnpm --filter @simplemd/desktop tauri build --no-bundle';
        const at = t.lastIndexOf(step);
        const end = t.indexOf('\n', at) + 1;
        return `${t.slice(0, end)}        env:\n          APPLE_ID: \${{ secrets.APPLE_ID }}\n${t.slice(end)}`;
      },
      message:
        'jobs.bundle-release: segredos só no require-signing-secrets e no passo tauri bundle',
    },
    {
      name: 'APPSEC-R3-05: segredo no passo do pnpm install',
      file: '.github/workflows/release.yml',
      change: (t: string) => {
        const step = '      - run: pnpm install --frozen-lockfile\n';
        const end = t.lastIndexOf(step) + step.length;
        return `${t.slice(0, end)}        env:\n          APPLE_ID: \${{ secrets.APPLE_ID }}\n${t.slice(end)}`;
      },
      message:
        'jobs.bundle-release: segredos só no require-signing-secrets e no passo tauri bundle',
    },
    {
      name: 'CR3-S2: comando encadeado no passo do tauri bundle que recebe os segredos da Apple',
      file: '.github/workflows/release.yml',
      change: inJob(
        'bundle-release',
        'tauri.release.conf.json\n        env:',
        'tauri.release.conf.json && node scripts/x.mjs\n        env:',
      ),
      message:
        'jobs.bundle-release: segredos só no require-signing-secrets e no passo tauri bundle',
    },
    {
      name: 'APPSEC-R3-05: sem a conferência de que o commit da tag está na main',
      file: '.github/workflows/release.yml',
      // r5: a primeira ocorrência agora é a do unsigned-prerelease-guard do dry-run.
      change: (t: string) =>
        replaceLast(
          t,
          '          git merge-base --is-ancestor "$GITHUB_SHA" origin/main || { echo "::error::o commit da tag não está na main"; exit 1; }\n',
          '          true\n',
        ),
      message: 'jobs.bundle-release: falta a conferência de que o commit da tag está na main',
    },
    {
      name: 'CR3-R6/B-01: bundle-release no Windows (o Windows só é assinado pelo SignPath)',
      file: '.github/workflows/release.yml',
      change: inJob(
        'bundle-release',
        '    runs-on: macos-latest\n',
        '    runs-on: windows-latest\n',
      ),
      message: 'jobs.bundle-release: só macOS (runs-on: macos-latest, sem matrix)',
    },
    {
      name: 'CR3-R6/B-01: bundle-release com matrix',
      file: '.github/workflows/release.yml',
      change: inJob(
        'bundle-release',
        '    runs-on: macos-latest\n',
        '    strategy:\n      matrix:\n        os: [macos-latest]\n    runs-on: macos-latest\n',
      ),
      message: 'jobs.bundle-release: só macOS (runs-on: macos-latest, sem matrix)',
    },
    {
      name: 'CR3-R6: checkout do bundle-release sem fetch-depth: 0',
      file: '.github/workflows/release.yml',
      // r5: o primeiro `fetch-depth: 0` agora é o do checkout do dry-run.
      change: (t: string) => replaceLast(t, '          fetch-depth: 0\n', ''),
      message: 'jobs.bundle-release: checkout sem fetch-depth: 0',
    },
  ])('reprova: $name', ({ file, change, message }) => {
    const r = run(mutated(file, change));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });

  test('reprova: osv-scanner.toml ausente (B-05)', () => {
    const dir = mutated('.node-version', (t) => `${t}\n`);
    rmSync(join(dir, 'osv-scanner.toml'));
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('osv-scanner.toml ausente');
  });

  // r5: cada regra nova (C1–C19 / CI-R5-01…12) reprova a sua mutação.
  const DISPATCH =
    'release.yml: workflow_dispatch só aceita o input booleano unsigned_prerelease (default false)';
  const UNSIGNED_WRITE = 'jobs.publish-unsigned: permissão de escrita no CI';
  const GUARD =
    'jobs.bundle-dry-run: falta o unsigned-prerelease-guard (tag v*, main, versões) antes do install/build';
  const ADHOC =
    "jobs.bundle-dry-run: o tauri bundle só assina ad-hoc (APPLE_SIGNING_IDENTITY: '-')";
  const CODESIGN =
    'jobs.bundle-dry-run: falta conferir a assinatura ad-hoc do .app antes do upload';
  const DOWNLOADS =
    'jobs.publish-unsigned baixa só bundle-dry-run-macos e bundle-dry-run-windows, por nome';
  const LIST = 'jobs.publish-unsigned: falta a lista exata dos pacotes';
  const ATTEST = 'jobs.publish-unsigned: falta a atestação antes do gh release create';
  const CREATE = 'jobs.publish-unsigned: gh release create com --verify-tag --draft --prerelease';
  const NOTES = 'jobs.publish-unsigned: as notas geradas no job não têm:';
  const BYPASS = 'release.yml: instrução para contornar a proteção do sistema';
  const MACOS_DOWNLOAD = '          name: bundle-dry-run-macos\n';
  const DIFF_LINE =
    '          diff -u "$RUNNER_TEMP/esperado" "$RUNNER_TEMP/achado" || { echo "::error::os artefatos não são exatamente os pacotes de $TAG de cada perna"; exit 1; }\n';
  const SUMS_LINE = '          sha256sum -- "$DMG" "$EXE" > SHA256SUMS\n';
  const ADHOC_ENV = "        env:\n          APPLE_SIGNING_IDENTITY: '-'\n";
  const INSTALL = '      - run: pnpm install --frozen-lockfile\n';
  const UNSIGNED_HEAD =
    "    if: github.event_name == 'workflow_dispatch' && inputs.unsigned_prerelease == true";

  test.each([
    {
      name: 'C1/CI-R5-02: input unsigned_prerelease como string',
      file: RELEASE,
      change: (t: string) => t.replace('        type: boolean\n', '        type: string\n'),
      message: DISPATCH,
    },
    {
      name: 'C1/CI-R5-02: input com default true',
      file: RELEASE,
      change: (t: string) => t.replace('        default: false\n', '        default: true\n'),
      message: DISPATCH,
    },
    {
      name: 'C1: segundo input no workflow_dispatch',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '    inputs:\n',
          "    inputs:\n      ref:\n        description: 'ref'\n        type: string\n",
        ),
      message: DISPATCH,
    },
    {
      name: 'C1: input obrigatório',
      file: RELEASE,
      change: (t: string) =>
        t.replace('        default: false\n', '        default: false\n        required: true\n'),
      message: DISPATCH,
    },
    {
      name: 'CI-R5-01 (a): publish-unsigned sem environment: release',
      file: RELEASE,
      change: (t: string) => replaceLast(t, '    environment: release\n', ''),
      message: 'jobs.publish-unsigned: permissão de escrita no CI: contents: write',
    },
    {
      name: 'CI-R5-01 (b): packages: write no publish-unsigned',
      file: RELEASE,
      change: (t: string) =>
        replaceLast(
          t,
          '      attestations: write # grava a atestação\n',
          '      attestations: write # grava a atestação\n      packages: write\n',
        ),
      message: 'jobs.publish-unsigned: permissão de escrita no CI: packages: write',
    },
    {
      name: 'CI-R5-01 (c): id-token: write no bundle-dry-run',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '  bundle-dry-run:\n',
          '  bundle-dry-run:\n    permissions:\n      id-token: write\n',
        ),
      message: 'jobs.bundle-dry-run: permissão de escrita no CI: id-token: write',
    },
    {
      name: 'CI-R5-01 (d): terceiro job com escrita',
      file: RELEASE,
      change: (t: string) =>
        `${t}\n  publish-x:\n    if: startsWith(github.ref, 'refs/tags/v')\n    environment: release\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n    steps:\n      - run: echo x\n`,
      message: 'jobs.publish-x: permissão de escrita no CI: contents: write',
    },
    {
      name: 'CI-R5-02 (a): if com github.event.inputs (string: "false" é verdadeiro)',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '&& inputs.unsigned_prerelease == true && startsWith',
          '&& github.event.inputs.unsigned_prerelease && startsWith',
        ),
      message: UNSIGNED_WRITE,
    },
    {
      name: 'CI-R5-02 (b): if do publish-unsigned sem a condição de tag',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          "inputs.unsigned_prerelease == true && startsWith(github.ref, 'refs/tags/v')",
          'inputs.unsigned_prerelease == true',
        ),
      message: UNSIGNED_WRITE,
    },
    {
      name: 'CI-R5-03 (a): always() no publish-unsigned',
      file: RELEASE,
      change: (t: string) =>
        t.replace(UNSIGNED_HEAD, UNSIGNED_HEAD.replace('if: ', 'if: always() && ')),
      message: 'jobs.publish-unsigned: always()/cancelled()/failure() no release.yml',
    },
    {
      name: 'CI-R5-03 (b): continue-on-error no passo do codesign',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          "        if: runner.os == 'macOS'\n",
          "        if: runner.os == 'macOS'\n        continue-on-error: true\n",
        ),
      message: 'jobs.bundle-dry-run: continue-on-error no release.yml',
    },
    {
      name: 'C2: publish-unsigned depende também do bundle-release',
      file: RELEASE,
      change: (t: string) =>
        t.replace('    needs: bundle-dry-run\n', '    needs: [bundle-dry-run, bundle-release]\n'),
      message: 'jobs.publish-unsigned tem de ter needs: bundle-dry-run',
    },
    {
      name: 'C3/AS-R5-M04: segredo no passo do gh release create',
      file: RELEASE,
      change: (t: string) =>
        replaceLast(
          t,
          '          GH_TOKEN: ${{ github.token }}\n',
          '          GH_TOKEN: ${{ github.token }}\n          APPLE_ID: ${{ secrets.APPLE_ID }}\n',
        ),
      message: 'jobs.publish-unsigned não pode ler secrets',
    },
    {
      name: 'C4: checkout no publish-unsigned',
      file: RELEASE,
      change: (t: string) =>
        beforeStep(
          t,
          MACOS_DOWNLOAD,
          `      - uses: ${CHECKOUT}\n        with:\n          persist-credentials: false\n`,
        ),
      message: 'jobs.publish-unsigned não pode fazer checkout',
    },
    {
      name: 'C5: ação de terceiros no publish-unsigned',
      file: RELEASE,
      change: (t: string) =>
        beforeStep(
          t,
          MACOS_DOWNLOAD,
          '      - uses: actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd # v8.0.0\n',
        ),
      message:
        'jobs.publish-unsigned só usa actions/download-artifact e actions/attest-build-provenance',
    },
    {
      name: 'C6: script do repositório no publish-unsigned',
      file: RELEASE,
      change: inJob('publish-unsigned', SUMS_LINE, `          node scripts/x.mjs\n${SUMS_LINE}`),
      message: 'jobs.publish-unsigned não pode executar código do repositório',
    },
    {
      name: 'C6: shell rodando outro comando no publish-unsigned',
      file: RELEASE,
      change: inJob(
        'publish-unsigned',
        '          cat SHA256SUMS\n',
        '          bash -c "cat SHA256SUMS"\n',
      ),
      message: 'jobs.publish-unsigned não pode executar código do repositório',
    },
    {
      name: 'C7/CI-R5-06 (a): download por pattern + merge-multiple',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          MACOS_DOWNLOAD,
          '          pattern: bundle-dry-run-*\n          merge-multiple: true\n',
        ),
      message: DOWNLOADS,
    },
    {
      name: 'C7/CI-R5-06 (b): download de outra execução (run-id)',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '          name: bundle-dry-run-windows\n',
          '          name: bundle-dry-run-windows\n          run-id: 123\n',
        ),
      message: DOWNLOADS,
    },
    {
      name: 'C7: download de outro artefato',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '          name: bundle-dry-run-windows\n',
          '          name: bundle-release-windows\n',
        ),
      message: DOWNLOADS,
    },
    {
      name: 'C8/CI-R5-06 (c): sem a lista exata esperada',
      file: RELEASE,
      change: inJob('publish-unsigned', /^.*"\$RUNNER_TEMP\/esperado"\n/m, ''),
      message: LIST,
    },
    {
      name: 'C8: diferença da lista engolida (|| true)',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          DIFF_LINE,
          DIFF_LINE.replace('"$RUNNER_TEMP/achado" ||', '"$RUNNER_TEMP/achado" || true ||'),
        ),
      message: LIST,
    },
    {
      name: 'C8/AS-R5-M11: SHA256SUMS de tudo (*) em vez dos dois nomes',
      file: RELEASE,
      change: inJob('publish-unsigned', SUMS_LINE, '          sha256sum -- * > SHA256SUMS\n'),
      message: LIST,
    },
    {
      name: 'C8: lista conferida depois do SHA256SUMS',
      file: RELEASE,
      change: (t: string) =>
        inJob('publish-unsigned', SUMS_LINE, SUMS_LINE + DIFF_LINE)(t.replace(DIFF_LINE, '')),
      message: LIST,
    },
    {
      name: 'C9: sem a atestação',
      file: RELEASE,
      change: (t: string) => {
        const [start, end] = stepRange(t, 'subject-checksums: assets/SHA256SUMS');
        return t.slice(0, start) + t.slice(end);
      },
      message: ATTEST,
    },
    {
      name: 'C9: atestação depois do gh release create',
      file: RELEASE,
      change: (t: string) =>
        moveStep(t, 'subject-checksums: assets/SHA256SUMS', (rest) => rest.length),
      message: ATTEST,
    },
    {
      name: 'C10/CI-R5-06 (e): release publicado direto (sem --draft)',
      file: RELEASE,
      change: (t: string) =>
        t.replace('--verify-tag --draft --prerelease --title', '--verify-tag --prerelease --title'),
      message: CREATE,
    },
    {
      name: 'C10: sem --verify-tag (criaria a tag)',
      file: RELEASE,
      change: (t: string) => t.replace('--verify-tag --draft --prerelease', '--draft --prerelease'),
      message: CREATE,
    },
    {
      name: 'C10/CI-R5-06 (d): sem --prerelease',
      file: RELEASE,
      change: (t: string) => t.replace('--draft --prerelease --title', '--draft --title'),
      message: CREATE,
    },
    {
      name: 'C10: notas por --notes em vez do arquivo gerado',
      file: RELEASE,
      change: (t: string) => t.replace('--notes-file "$RUNNER_TEMP/notas.md"', '--notes "x"'),
      message: CREATE,
    },
    {
      name: 'C10: o .msi também sobe (são exatamente 2 pacotes)',
      file: RELEASE,
      change: inJob(
        'publish-unsigned',
        '"simpleMD_${TAG#v}_x64-setup.exe" SHA256SUMS',
        '"simpleMD_${TAG#v}_x64-setup.exe" "simpleMD_${TAG#v}_x64_en-US.msi" SHA256SUMS',
      ),
      message: CREATE,
    },
    {
      name: 'CI-R5-06 (f): gh release upload',
      file: RELEASE,
      change: (t: string) =>
        `${t}      - env:\n          GH_TOKEN: \${{ github.token }}\n          TAG: \${{ github.ref_name }}\n        run: gh release upload "$TAG" x\n`,
      message: 'release.yml: gh release upload/edit/delete no workflow',
    },
    {
      name: 'AS-R5-M04b: token fora do passo do gh release create',
      file: RELEASE,
      change: inJob(
        'publish-unsigned',
        '        env:\n          TAG: ${{ github.ref_name }}\n        run: |\n          V=',
        '        env:\n          GH_TOKEN: ${{ github.token }}\n          TAG: ${{ github.ref_name }}\n        run: |\n          V=',
      ),
      message: 'jobs.publish-unsigned: o token só no env do passo gh release create',
    },
    {
      name: 'C11: bundle-dry-run no Environment release',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          "  bundle-dry-run:\n    if: github.event_name == 'workflow_dispatch'\n",
          "  bundle-dry-run:\n    if: github.event_name == 'workflow_dispatch'\n    environment: release\n",
        ),
      message: 'jobs.bundle-dry-run: só em workflow_dispatch, sem Environment',
    },
    {
      name: 'C11: bundle-dry-run também no push',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          "  bundle-dry-run:\n    if: github.event_name == 'workflow_dispatch'\n",
          "  bundle-dry-run:\n    if: github.event_name == 'workflow_dispatch' || github.event_name == 'push'\n",
        ),
      message: 'jobs.bundle-dry-run: só em workflow_dispatch, sem Environment',
    },
    {
      name: 'C12/CI-R5-04 (d): checkout do dry-run sem fetch-depth: 0',
      file: RELEASE,
      change: (t: string) => t.replace('          fetch-depth: 0\n', ''),
      message: 'jobs.bundle-dry-run: checkout sem fetch-depth: 0',
    },
    {
      name: 'C13/CI-R5-04 (b): conferência da main engolida (|| true) no guard',
      file: RELEASE,
      change: (t: string) =>
        t.replace('não está na main"; exit 1; }\n', 'não está na main"; exit 1; } || true\n'),
      message: GUARD,
    },
    {
      name: 'C13: if do guard sem o == true tipado',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          "if: inputs.unsigned_prerelease == true || github.ref_type == 'tag'",
          "if: inputs.unsigned_prerelease || github.ref_type == 'tag'",
        ),
      message: GUARD,
    },
    {
      name: 'C13/CI-R5-04 (a): guard depois do pnpm install',
      file: RELEASE,
      change: (t: string) =>
        moveStep(
          t,
          '- id: unsigned-prerelease-guard',
          (rest) => rest.indexOf(INSTALL) + INSTALL.length,
        ),
      message: GUARD,
    },
    {
      name: 'C13/CI-R5-04 (c): guard sem a falha fora de tag v*',
      file: RELEASE,
      change: (t: string) => t.replace(/^.*unsigned_prerelease só numa tag v\*.*\n/m, ''),
      message: GUARD,
    },
    {
      name: 'C13: guard sem shell: bash (pwsh no Windows)',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '        shell: bash\n        env:\n          TAG: ${{ github.ref_name }}\n        run: |\n          [ "$GITHUB_REF_TYPE"',
          '        env:\n          TAG: ${{ github.ref_name }}\n        run: |\n          [ "$GITHUB_REF_TYPE"',
        ),
      message: GUARD,
    },
    {
      name: 'C14/CI-R5-09 (a): identidade de desenvolvedor no dry-run',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          "          APPLE_SIGNING_IDENTITY: '-'\n",
          "          APPLE_SIGNING_IDENTITY: 'Developer ID Application: X'\n",
        ),
      message: ADHOC,
    },
    {
      name: "CI-R5-09 (b): '-' no passo do pnpm install",
      file: RELEASE,
      change: (t: string) => t.replace(ADHOC_ENV, '').replace(INSTALL, INSTALL + ADHOC_ENV),
      message: 'jobs.bundle-dry-run: APPLE_SIGNING_IDENTITY só no env do passo tauri bundle',
    },
    {
      name: "C16/CI-R5-09 (c): '-' no build do bundle-release",
      file: RELEASE,
      change: (t: string) => {
        const step =
          '      - run: pnpm --filter @simplemd/desktop tauri build --no-bundle --config src-tauri/tauri.release.conf.json -- --locked\n';
        return replaceLast(t, step, step + ADHOC_ENV);
      },
      message:
        "jobs.bundle-release: APPLE_SIGNING_IDENTITY '-' só no tauri bundle do bundle-dry-run",
    },
    {
      name: 'CI-R5-09 (d): signingIdentity no overlay de release',
      file: 'apps/desktop/src-tauri/tauri.release.conf.json',
      change: (t: string) =>
        t.replace('"hardenedRuntime": true', '"hardenedRuntime": true, "signingIdentity": "-"'),
      message: 'tauri.release.conf.json: assinatura/updater na config do Tauri (signingIdentity)',
    },
    {
      name: 'CI-R5-09: createUpdaterArtifacts no overlay de release',
      file: 'apps/desktop/src-tauri/tauri.release.conf.json',
      change: (t: string) =>
        t.replace('"active": true,', '"active": true, "createUpdaterArtifacts": true,'),
      message:
        'tauri.release.conf.json: assinatura/updater na config do Tauri (createUpdaterArtifacts)',
    },
    {
      name: 'CI-R5-09: plugin updater na config base',
      file: 'apps/desktop/src-tauri/tauri.conf.json',
      change: (t: string) =>
        t.replace(
          '  "identifier": "io.github.devrafaelbrauner.simplemd",\n',
          '  "identifier": "io.github.devrafaelbrauner.simplemd",\n  "plugins": { "updater": {} },\n',
        ),
      message: 'tauri.conf.json: assinatura/updater na config do Tauri (plugins.updater)',
    },
    {
      name: 'C15/CI-R5-10 (a): sem a conferência da assinatura ad-hoc',
      file: RELEASE,
      change: (t: string) => {
        const [start, end] = stepRange(t, 'name: Assinatura ad-hoc do .app (macOS)');
        return t.slice(0, start) + t.slice(end);
      },
      message: CODESIGN,
    },
    {
      name: 'C15/CI-R5-10 (b): conferência da assinatura depois do upload',
      file: RELEASE,
      change: (t: string) => moveStep(t, 'name: Assinatura ad-hoc do .app (macOS)', endOfDryRun),
      message: CODESIGN,
    },
    {
      name: 'C15/CI-R5-10 (c): codesign sem --strict',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          'codesign --verify --deep --strict --verbose=2',
          'codesign --verify --deep --verbose=2',
        ),
      message: CODESIGN,
    },
    {
      name: 'C15: sem conferir Signature=adhoc',
      file: RELEASE,
      change: (t: string) => t.replace(/^.*grep -qx 'Signature=adhoc'.*\n/m, ''),
      message: CODESIGN,
    },
    {
      name: 'CI-R5-10: assert-no-harness depois do upload',
      file: RELEASE,
      change: (t: string) =>
        moveStep(t, 'run: node scripts/assert-no-harness.mjs apps/desktop/dist', endOfDryRun),
      message:
        'jobs.bundle-dry-run: assert-no-harness.mjs tem de rodar entre o tauri bundle e o upload',
    },
    {
      name: 'CI-R5-10: assert-no-ai-recorder depois do upload',
      file: RELEASE,
      change: (t: string) =>
        moveStep(t, 'run: node scripts/assert-no-ai-recorder.mjs', endOfDryRun),
      message:
        'jobs.bundle-dry-run: assert-no-ai-recorder.mjs tem de rodar entre o tauri bundle e o upload',
    },
    {
      name: 'C17/CI-R5-11: ${{ }} dentro do run do publish-unsigned',
      file: RELEASE,
      change: inJob(
        'publish-unsigned',
        '          V="${TAG#v}"\n',
        '          V="${{ github.ref_name }}"\n',
      ),
      message: 'release.yml: jobs.publish-unsigned: ${{ }} dentro de run (use env)',
    },
    {
      name: 'CI-R5-11 (a): echo ${{ github.ref_name }} no publish-unsigned',
      file: RELEASE,
      change: (t: string) =>
        beforeStep(t, MACOS_DOWNLOAD, '      - run: echo ${{ github.ref_name }}\n'),
      message: 'release.yml: jobs.publish-unsigned: ${{ }} dentro de run (use env)',
    },
    {
      name: 'C18/CI-R5-08 (a): cache: pnpm no setup-node do dry-run',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '          node-version-file: .node-version\n',
          '          node-version-file: .node-version\n          cache: pnpm\n',
        ),
      message: 'jobs.bundle-dry-run: cache no workflow de release',
    },
    {
      name: 'C18/CI-R5-08 (b): rust-cache no bundle-release',
      file: RELEASE,
      change: (t: string) =>
        replaceLast(
          t,
          '      - run: rustup toolchain install\n',
          '      - run: rustup toolchain install\n      - uses: Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2\n',
        ),
      message: 'jobs.bundle-release: cache no workflow de release',
    },
    {
      name: 'C19/CI-R5-07 (c): desktop-build sem -- --locked',
      file: '.github/workflows/ci.yml',
      change: (t: string) =>
        t.replace('tauri build --no-bundle -- --locked', 'tauri build --no-bundle'),
      message: 'ci.yml: jobs.desktop-build: tauri build sem -- --locked (APPSEC-R3-04)',
    },
    {
      name: 'C19: desktop-build com -- --locked || true',
      file: '.github/workflows/ci.yml',
      change: (t: string) =>
        t.replace(
          'tauri build --no-bundle -- --locked',
          'tauri build --no-bundle -- --locked || true',
        ),
      message: 'ci.yml: jobs.desktop-build: tauri build sem -- --locked (APPSEC-R3-04)',
    },
    {
      name: 'C19/CI-R5-07 (a): dry-run sem -- --locked',
      file: RELEASE,
      change: (t: string) =>
        t.replace('tauri.release.conf.json -- --locked', 'tauri.release.conf.json'),
      message: 'release.yml: jobs.bundle-dry-run: tauri build sem -- --locked (APPSEC-R3-04)',
    },
    {
      name: 'C19/CI-R5-07 (b): bundle-release sem -- --locked',
      file: RELEASE,
      change: (t: string) =>
        replaceLast(t, 'tauri.release.conf.json -- --locked', 'tauri.release.conf.json'),
      message: 'release.yml: jobs.bundle-release: tauri build sem -- --locked (APPSEC-R3-04)',
    },
    {
      name: 'CI-R5-05 (a): conferência da main do bundle-release engolida (|| true)',
      file: RELEASE,
      change: (t: string) =>
        replaceLast(t, 'não está na main"; exit 1; }\n', 'não está na main"; exit 1; } || true\n'),
      message: 'jobs.bundle-release: a conferência da main tem de ser a linha exata',
    },
    {
      name: 'CI-R5-12 (a): xattr nas notas',
      file: RELEASE,
      change: (t: string) =>
        t.replace('o simpleMD não precisa disso.', 'se travar, use xattr -cr no app.'),
      message: `${BYPASS} (achado: xattr)`,
    },
    {
      name: 'CI-R5-12 (c): spctl --master-disable nas notas',
      file: RELEASE,
      change: (t: string) =>
        t.replace('o simpleMD não precisa disso.', 'ou rode spctl --master-disable.'),
      message: `${BYPASS} (achado: spctl`,
    },
    {
      name: 'CI-R5-12: sudo nas notas',
      file: RELEASE,
      change: (t: string) =>
        t.replace('o simpleMD não precisa disso.', 'o simpleMD não precisa de sudo.'),
      message: `${BYPASS} (achado: sudo)`,
    },
    {
      name: 'CI-R5-12 (b): notas sem a conferência da atestação',
      file: RELEASE,
      change: (t: string) => t.replace(/^.*gh attestation verify <arquivo>.*\n/m, ''),
      message: `${NOTES} gh attestation verify`,
    },
    {
      name: 'CI-R5-12: notas sem o Negar do Keychain',
      file: RELEASE,
      change: (t: string) => t.replace('clique em **Negar**', 'clique em **Cancelar**'),
      message: `${NOTES} Negar`,
    },
  ])('reprova (r5): $name', ({ file, change, message }) => {
    const r = run(mutated(file, change));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });

  // Revisão do PR #18 (CR5-S1/S2, N2, AS-R5-REV-01…03, N4): cada regra nova reprova a sua mutação.
  const ATTEST_USES =
    '      - uses: actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4.2.2\n';
  const STEP_IF = 'jobs.publish-unsigned: passo com if: (nenhum passo pode ser pulado)';
  const JOB_LEVEL = 'jobs.publish-unsigned: sem env/defaults no nível do job';
  const MACOS_SECRETS =
    'jobs.bundle-release: o require-signing-secrets tem de falhar no macOS sem qualquer um dos 6 segredos';
  test.each([
    {
      name: 'CR5-S1: if: false na atestação do publish-unsigned',
      file: RELEASE,
      change: (t: string) => replaceLast(t, ATTEST_USES, `${ATTEST_USES}        if: false\n`),
      message: `${STEP_IF} (passo 4)`,
    },
    {
      name: 'CR5-S1: if no download do artefato do macOS',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          `        with:\n${MACOS_DOWNLOAD}`,
          `        if: github.event_name == 'workflow_dispatch'\n        with:\n${MACOS_DOWNLOAD}`,
        ),
      message: `${STEP_IF} (passo 1)`,
    },
    {
      name: 'CR5-S2: GH_TOKEN no env do job publish-unsigned',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '    needs: bundle-dry-run\n',
          '    needs: bundle-dry-run\n    env:\n      GH_TOKEN: ${{ github.token }}\n',
        ),
      message: JOB_LEVEL,
    },
    {
      name: 'CR5-S2: defaults no job publish-unsigned',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '    needs: bundle-dry-run\n',
          '    needs: bundle-dry-run\n    defaults:\n      run:\n        working-directory: assets\n',
        ),
      message: JOB_LEVEL,
    },
    {
      name: 'CR5-S2: publish-unsigned num runner self-hosted',
      file: RELEASE,
      change: (t: string) =>
        replaceLast(t, '    runs-on: ubuntu-latest\n', '    runs-on: self-hosted\n'),
      message: 'jobs.publish-unsigned: runs-on tem de ser ubuntu-latest',
    },
    {
      name: 'AS-R5-REV-01: os dois artefatos na mesma pasta',
      file: RELEASE,
      change: (t: string) =>
        t.replace('          path: release/windows\n', '          path: release/macos\n'),
      message: `${DOWNLOADS}, cada um na sua pasta`,
    },
    {
      name: 'AS-R5-REV-01: os dois artefatos de volta em release/',
      file: RELEASE,
      change: (t: string) =>
        t
          .replace('          path: release/macos\n', '          path: release\n')
          .replace('          path: release/windows\n', '          path: release\n'),
      message: `${DOWNLOADS}, cada um na sua pasta`,
    },
    {
      name: 'AS-R5-REV-01: lista aceita o .dmg vindo do artefato do Windows',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          `printf '%s\\n' "release/macos/dmg/$DMG"`,
          `printf '%s\\n' "release/windows/dmg/$DMG"`,
        ),
      message: LIST,
    },
    {
      name: 'AS-R5-REV-02: macOS sem segredos deixa de falhar',
      file: RELEASE,
      change: inJob(
        'bundle-release',
        'Environment release:$missing"; exit 1; }\n',
        'Environment release:$missing"; }\n',
      ),
      message: MACOS_SECRETS,
    },
    {
      name: 'AS-R5-REV-02: um segredo a menos na conferência do macOS',
      file: RELEASE,
      change: (t: string) =>
        t.replace(' APPLE_PASSWORD APPLE_TEAM_ID; do\n', ' APPLE_PASSWORD; do\n'),
      message: MACOS_SECRETS,
    },
    {
      name: 'CR5 N2: if: false no assert-no-harness do dry-run',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '      - run: node scripts/assert-no-harness.mjs apps/desktop/dist\n',
          '      - run: node scripts/assert-no-harness.mjs apps/desktop/dist\n        if: false\n',
        ),
      message: 'jobs.bundle-dry-run: assert-no-harness.mjs não pode ter if:',
    },
    {
      name: 'AS-R5-REV-03: macOS sem a conferência pelo SHA256SUMS (só a soma de olho)',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          'shasum -a 256 -c --ignore-missing SHA256SUMS',
          'shasum -a 256 simpleMD_@V@_aarch64.dmg',
        ),
      message: `${NOTES} shasum -a 256 -c --ignore-missing SHA256SUMS`,
    },
    {
      name: 'AS-R5-REV-03: Windows sem a comparação -eq com o SHA256SUMS',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          /^( +)\(Get-FileHash .*\n/m,
          '$1Get-FileHash .\\simpleMD_@V@_x64-setup.exe -Algorithm SHA256\n',
        ),
      message: `${NOTES} .Hash -eq ((Select-String -SimpleMatch '`,
    },
    {
      name: 'CR5 N4: notas sem o gh auth login da atestação',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '(com o GitHub CLI autenticado, depois de `gh auth login`)',
          '(com o GitHub CLI)',
        ),
      message: `${NOTES} gh auth login`,
    },
  ])('reprova (r5 revisão): $name', ({ file, change, message }) => {
    const r = run(mutated(file, change));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });

  // r5 PR-A2 (CR5-S3, WIN-R5-01): as notas citam os rótulos que a QA observou.
  test.each([
    {
      name: 'título do aviso do macOS trocado por um não observado',
      change: (t: string) =>
        t.replace('"O Item simpleMD Não Foi Aberto"', '"simpleMD não pode ser aberto"'),
      message: `${NOTES} O Item simpleMD Não Foi Aberto`,
    },
    {
      name: 'sem o alerta sobre o botão "Mover para o Lixo"',
      change: (t: string) =>
        t.replace(
          'Clique em "OK", **não** em "Mover para o Lixo" (é o botão destacado: a tecla Return o aciona).',
          'Feche o aviso.',
        ),
      message: `${NOTES} Clique em "OK", **não** em "Mover para o Lixo"`,
    },
    {
      name: 'N11: conselho invertido (clicar em "Mover para o Lixo", não em "OK")',
      change: (t: string) =>
        t.replace(
          'Clique em "OK", **não** em "Mover para o Lixo"',
          'Clique em "Mover para o Lixo", **não** em "OK"',
        ),
      message: `${NOTES} Clique em "OK", **não** em "Mover para o Lixo"`,
    },
    {
      name: 'sem a linha da seção "Segurança" dos Ajustes',
      change: (t: string) =>
        t.replace(', onde aparece "O app simpleMD foi bloqueado para proteger o Mac."', ''),
      message: `${NOTES} O app simpleMD foi bloqueado para proteger o Mac.`,
    },
    {
      name: 'SmartScreen sem "Fornecedor: Fornecedor desconhecido"',
      change: (t: string) =>
        t.replace(
          '"Fornecedor: Fornecedor desconhecido" (esperado nesta versão)',
          'o fornecedor (esperado nesta versão)',
        ),
      message: `${NOTES} Fornecedor: Fornecedor desconhecido`,
    },
    {
      name: 'desinstalação do Windows sem "Delete the application data"',
      change: (t: string) =>
        t.replace('a opção "Delete the application data", desmarcada', 'uma opção, desmarcada'),
      message: `${NOTES} Delete the application data`,
    },
    {
      name: 'WIN-R5-01: "editor aparece como desconhecido" de volta',
      change: (t: string) =>
        t.replace(
          'e "Fornecedor: Fornecedor desconhecido" (esperado nesta versão)',
          'e "Fornecedor: Fornecedor desconhecido" e que o editor aparece como desconhecido (esperado nesta versão)',
        ),
      message:
        'release.yml: rótulo que a QA não observou nas notas (achado: editor aparece como desconhecido)',
    },
    {
      name: 'WIN-R5-01: «Editor desconhecido» citado',
      change: (t: string) =>
        t.replace(
          'Na última página,',
          'O SmartScreen diz "Editor desconhecido". Na última página,',
        ),
      message: 'release.yml: rótulo que a QA não observou nas notas (achado: Editor desconhecido)',
    },
  ])('reprova (r5 rótulos da QA): $name', ({ change, message }) => {
    const r = run(mutated(RELEASE, change));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });

  // r5 Tier 2 (QA no release publicado: macOS O-4/F-1, O-1; Windows F-1): cada texto novo das notas.
  test.each([
    {
      name: 'macOS O-4: sem o segundo aviso "Abrir o Item simpleMD?"',
      change: (t: string) =>
        t.replace(
          ' Pode aparecer um segundo aviso, "Abrir o Item simpleMD?": clique em "Abrir Mesmo Assim" (de novo **não** em "Mover para o Lixo", que é o botão destacado).',
          '',
        ),
      message: `${NOTES} Abrir o Item simpleMD?`,
    },
    {
      name: 'N18: conselho invertido no segundo aviso',
      change: (t: string) =>
        t.replace(
          'clique em "Abrir Mesmo Assim" (de novo **não** em "Mover para o Lixo"',
          'clique em "Mover para o Lixo" (de novo **não** em "Abrir Mesmo Assim"',
        ),
      message: `${NOTES} clique em "Abrir Mesmo Assim" (de novo **não** em "Mover para o Lixo"`,
    },
    {
      name: 'macOS F-1: sem a saída para o pedido de senha que não aparece',
      change: (t: string) => t.replace(/^.*\*\*macOS, se travar:\*\*.*\n/m, ''),
      message: `${NOTES} reinicie o Mac`,
    },
    {
      name: 'O-1: atestação sem dizer que vale para o .dmg ou o .exe',
      change: (t: string) =>
        t.replace(
          ' Use o `.dmg` ou o `-setup.exe` no lugar de `<arquivo>` (o `SHA256SUMS` não tem atestação própria: ele é conferido pelo passo acima).',
          '',
        ),
      message: `${NOTES} Use o \`.dmg\` ou o \`-setup.exe\` no lugar de \`<arquivo>\``,
    },
    {
      name: 'Windows F-1: atestação sem a saída esperada',
      change: (t: string) =>
        t.replace(
          ' Rodado num terminal, o comando tem de mostrar `✓ Verification succeeded!`:',
          ':',
        ),
      message: `${NOTES} ✓ Verification succeeded!`,
    },
  ])('reprova (r5 Tier 2): $name', ({ change, message }) => {
    const r = run(mutated(RELEASE, change));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });

  // B-01 (Windows pelo SignPath Foundation, só o instalador nsis): cada regra nova reprova a sua
  // mutação. Os dois jobs do SignPath têm passos iguais: cada mutação vale só dentro do seu job.
  const SIGNPATH_STEP = '      - uses: signpath/';
  const UPLOAD = 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1';
  const EMBED = 'run: node scripts/assert-installer-embeds-exe.mjs';
  const PUBLISH_DOWNLOAD =
    'jobs.publish: um só download, pelos artifact-ids do bundle-release e do sign-windows-installer';
  const SIGNED_LIST =
    'jobs.publish: falta a lista exata do .dmg e do -setup.exe antes do SHA256SUMS (L-1)';
  test.each([
    {
      name: 'APPSEC-R3-05: build-windows sem a conferência de que o commit da tag está na main',
      change: inJob('build-windows', /^.*git merge-base --is-ancestor .*\n/m, '          true\n'),
      message: 'jobs.build-windows: falta a conferência de que o commit da tag está na main',
    },
    {
      name: 'CR3-R6: checkout do build-windows sem fetch-depth: 0',
      change: inJob('build-windows', /^ +fetch-depth: 0\n/m, ''),
      message: 'jobs.build-windows: checkout sem fetch-depth: 0',
    },
    {
      name: 'AC-B01.7: passo antes do require-signing-secrets num job do SignPath',
      change: inJob(
        'sign-windows-installer',
        '      - id: require-signing-secrets\n',
        '      - run: echo antes\n      - id: require-signing-secrets\n',
      ),
      message: 'jobs.sign-windows-installer: o 1º passo tem de ser id: require-signing-secrets',
    },
    {
      name: 'CR3-S1: checkout no sign-windows-exe',
      change: inJob(
        'sign-windows-exe',
        SIGNPATH_STEP,
        `      - uses: ${CHECKOUT}\n        with:\n          persist-credentials: false\n${SIGNPATH_STEP}`,
      ),
      message: 'jobs.sign-windows-exe não pode fazer checkout',
    },
    {
      name: 'CR3-S1: script do repositório no sign-windows-installer',
      change: inJob(
        'sign-windows-installer',
        SIGNPATH_STEP,
        `      - run: node scripts/x.mjs\n${SIGNPATH_STEP}`,
      ),
      message: 'jobs.sign-windows-installer não pode executar código do repositório',
    },
    {
      name: 'CR3-S1: executável do build num job do SignPath',
      change: inJob(
        'sign-windows-installer',
        SIGNPATH_STEP,
        `      - run: .\\signed\\simpleMD_0.0.0_x64-setup.exe /S\n${SIGNPATH_STEP}`,
      ),
      message: 'jobs.sign-windows-installer não pode executar código do repositório',
    },
    {
      name: 'CR3-S1: pwsh -File num job do SignPath',
      change: inJob(
        'sign-windows-exe',
        SIGNPATH_STEP,
        `      - run: pwsh -File signed\\smoke.ps1\n${SIGNPATH_STEP}`,
      ),
      message: 'jobs.sign-windows-exe não pode executar código do repositório',
    },
    {
      name: 'B-01: segredo fora do passo do SignPath',
      change: inJob(
        'sign-windows-exe',
        SIGNPATH_STEP,
        '      - run: echo antes\n        env:\n          T: ${{ secrets.SIGNPATH_API_TOKEN }}\n' +
          SIGNPATH_STEP,
      ),
      message:
        'jobs.sign-windows-exe: segredos só no require-signing-secrets e no passo do SignPath',
    },
    {
      name: 'B-01: sign-windows-exe sem o passo do SignPath',
      change: inJob(
        'sign-windows-exe',
        /signpath\/github-action-submit-signing-request@[0-9a-f]{40} # v3\.0/,
        UPLOAD,
      ),
      message: 'jobs.sign-windows-exe: falta o passo do SignPath',
    },
    {
      name: 'CR3-R1: sign-windows-installer sem reprovar assinatura diferente de Valid',
      change: inJob('sign-windows-installer', "-ne 'Valid'", "-eq 'NotSigned'"),
      message: 'jobs.sign-windows-installer: falta conferir a assinatura Authenticode (Valid)',
    },
    {
      name: 'CR3-R1: upload antes da conferência no sign-windows-exe',
      change: inJob(
        'sign-windows-exe',
        '      - name: Assinatura Authenticode válida (CR3-R1)\n',
        `      - uses: ${UPLOAD}\n        with:\n          name: cedo\n          path: signed/\n      - name: Assinatura Authenticode válida (CR3-R1)\n`,
      ),
      message:
        'jobs.sign-windows-exe: falta conferir a assinatura Authenticode (Valid) depois do SignPath e antes do upload',
    },
    {
      name: 'B-01: outputs.exe-sha256 do sign-windows-exe fora da conferência',
      change: inJob(
        'sign-windows-exe',
        'exe-sha256: ${{ steps.verify.outputs.exe-sha256 }}',
        'exe-sha256: ${{ steps.other.outputs.exe-sha256 }}',
      ),
      message: 'jobs.sign-windows-exe: outputs.exe-sha256 tem de vir da conferência Authenticode',
    },
    {
      name: 'B-01: bundle-windows sem --no-binary-patching (o Tauri alteraria o exe assinado)',
      change: inJob('bundle-windows', ' --no-sign --no-binary-patching\n', ' --no-sign\n'),
      message:
        'jobs.bundle-windows: um só tauri bundle, o do nsis com --no-sign --no-binary-patching',
    },
    {
      name: 'B-01: bundle-windows sem conferir o exe assinado',
      change: inJob('bundle-windows', "-ne 'Valid'", "-eq 'NotSigned'"),
      message:
        'jobs.bundle-windows: falta conferir a assinatura Authenticode (Valid) do exe antes do tauri bundle',
    },
    {
      name: 'B-01: conferência do exe depois do tauri bundle',
      change: (t: string) =>
        moveStep(
          t,
          'name: Exe assinado antes do bundle (CR3-R1)',
          (rest) => stepRange(rest, EMBED)[0],
        ),
      message:
        'jobs.bundle-windows: falta conferir a assinatura Authenticode (Valid) do exe antes do tauri bundle',
    },
    {
      name: 'B-01: bundle-windows sem provar que o instalador leva o exe assinado',
      change: (t: string) => {
        const [start, end] = stepRange(t, EMBED);
        return t.slice(0, start) + t.slice(end);
      },
      message:
        'jobs.bundle-windows: falta node scripts/assert-installer-embeds-exe.mjs depois do tauri bundle e antes do upload',
    },
    {
      name: 'B-01: upload antes do assert no bundle-windows',
      change: (t: string) =>
        moveStep(
          t,
          EMBED,
          (rest) => rest.indexOf('\n\n', rest.indexOf('\n  bundle-windows:\n')) + 1,
        ),
      message:
        'jobs.bundle-windows: falta node scripts/assert-installer-embeds-exe.mjs depois do tauri bundle e antes do upload',
    },
    {
      name: 'B-01: assert do bundle-windows sem o sha256 do sign-windows-exe',
      change: inJob('bundle-windows', /\n +env:\n +SIMPLEMD_SIGNED_EXE_SHA256: [^\n]*/, ''),
      message:
        'jobs.bundle-windows: o node scripts/assert-installer-embeds-exe.mjs tem de comparar',
    },
    {
      name: 'B-01: instalador sem assinatura publicado como bundle-release-*',
      change: inJob(
        'bundle-windows',
        'name: windows-installer-unsigned',
        'name: bundle-release-windows',
      ),
      message:
        'jobs.bundle-windows: artefato bundle-release-* só no bundle-release e no sign-windows-installer',
    },
    {
      name: 'B-01: outputs.artifact-id do sign-windows-installer fora do upload assinado',
      change: inJob(
        'sign-windows-installer',
        'artifact-id: ${{ steps.signed.outputs.artifact-id }}',
        'artifact-id: ${{ steps.other.outputs.artifact-id }}',
      ),
      message:
        'jobs.sign-windows-installer: outputs.artifact-id tem de vir do upload bundle-release-*',
    },
    {
      name: 'B-01/L-1: publish baixando por padrão de nome',
      change: inJob('publish', /artifact-ids: .*\n/, 'pattern: bundle-release-*\n'),
      message: PUBLISH_DOWNLOAD,
    },
    {
      name: 'B-01: publish baixando também o instalador sem assinatura',
      change: inJob(
        'publish',
        '      - name: Lista exata e SHA256SUMS\n',
        '      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1\n        with:\n          name: windows-installer-unsigned\n          path: release\n      - name: Lista exata e SHA256SUMS\n',
      ),
      message: PUBLISH_DOWNLOAD,
    },
    {
      name: 'L-1: publish sem a lista exata',
      change: inJob('publish', /^.*"\$RUNNER_TEMP\/achado" \|\|.*\n/m, ''),
      message: SIGNED_LIST,
    },
    {
      name: 'L-1: SHA256SUMS de tudo (*) no publish',
      change: inJob('publish', SUMS_LINE, '          sha256sum -- * > SHA256SUMS\n'),
      message: SIGNED_LIST,
    },
    {
      name: 'L-1: lista conferida depois do SHA256SUMS no publish',
      change: inJob('publish', /^( +diff -u .*\n)( +cd release\n)( +sha256sum .*\n)/m, '$2$3$1'),
      message: SIGNED_LIST,
    },
  ])('reprova (B-01 Windows): $name', ({ change, message }) => {
    const r = run(mutated(RELEASE, change));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });

  test('reprova (r5, CI-R5-09 e): tauri.macos.conf.json (o Tauri o mescla sozinho)', () => {
    const dir = mutated('.node-version', (t) => `${t}\n`);
    writeFileSync(join(dir, 'apps/desktop/src-tauri/tauri.macos.conf.json'), '{}\n');
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'tauri.macos.conf.json: config de plataforma do Tauri não é permitida',
    );
  });
});
