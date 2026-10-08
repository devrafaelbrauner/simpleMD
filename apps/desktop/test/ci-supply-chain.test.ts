// Etapa 12a (R-12.4, AC-12.8): o portão `scripts/check-ci-supply-chain.mjs` (parte de
// `pnpm check:security`) aprova o CI do repositório e reprova cada regressão da cadeia de
// suprimentos: ação por tag, checkout com credencial persistida, permissão de escrita, toolchain
// flutuante, job de gitleaks/trufflehog/auditoria/osv-scanner/Semgrep fixado ausente, download sem
// sha256 e política do pnpm.
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
];
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';

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
    // AC-B01.8: a única escrita aceita é a do job publish do release.yml.
    expect(r.stdout).toContain('exceção de escrita release.yml#publish');
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
        t.replace('  workflow_dispatch: {}\n', '  workflow_dispatch: {}\n  pull_request:\n'),
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
      change: (t: string) =>
        t.replace(
          '      - id: require-signing-secrets\n',
          '      - run: echo antes\n      - id: require-signing-secrets\n',
        ),
      message: 'jobs.bundle-release: o 1º passo tem de ser id: require-signing-secrets',
    },
    {
      name: 'CR3-R2: publish sem needs: bundle-release',
      file: '.github/workflows/release.yml',
      change: (t: string) => t.replace('  publish:\n    needs: bundle-release\n', '  publish:\n'),
      message: 'jobs.publish tem de ter needs: bundle-release',
    },
    {
      name: 'CR3-R2: checkout no publish (token de escrita)',
      file: '.github/workflows/release.yml',
      change: (t: string) =>
        t.replace(
          '      - uses: actions/download-artifact@',
          `      - uses: ${CHECKOUT}\n        with:\n          persist-credentials: false\n      - uses: actions/download-artifact@`,
        ),
      message: 'jobs.publish não pode fazer checkout',
    },
    {
      name: 'CR3-R2: script do repositório no publish',
      file: '.github/workflows/release.yml',
      change: (t: string) =>
        t.replace(
          'run: sha256sum -- * > SHA256SUMS',
          'run: node scripts/x.mjs && sha256sum -- * > SHA256SUMS',
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
});
