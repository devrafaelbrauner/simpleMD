// Etapa 12a (R-12.4, AC-12.8): o portão `scripts/check-ci-supply-chain.mjs` (parte de
// `pnpm check:security`) aprova o CI do repositório e reprova cada regressão da cadeia de
// suprimentos: ação por tag, checkout com credencial persistida, permissão de escrita, toolchain
// flutuante, job de gitleaks/trufflehog/auditoria/osv-scanner/Semgrep fixado ausente, download sem
// sha256 e política do pnpm. r5 (pré-lançamento sem assinatura, CI-R5-01…12 / C1–C19): o caminho
// `bundle-dry-run` → `publish-unsigned` do release.yml e o `-- --locked` de todo `tauri build`.
// r6/r18 (portões do release assinado: CR3-S1, CR3-R1, AS-R5-S08, L-1; CI-R6, DV-2…15): os jobs
// `bundle-macos`, `bundle-windows`, `sign-macos` e `publish` (linhas S-/W-/G-/P- do desenho).
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
  'apps/desktop/src-tauri/Entitlements.plist',
];
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';

const RELEASE = '.github/workflows/release.yml';

/** Troca a última ocorrência de `from` por `to`. */
function replaceLast(text: string, from: string, to: string): string {
  const at = text.lastIndexOf(from);
  return at < 0 ? text : text.slice(0, at) + to + text.slice(at + from.length);
}

/** Início (linha `      - …`) e fim do passo que contém `needle` (a última ocorrência, com `last`). */
function stepRange(text: string, needle: string, last = false): [number, number] {
  const at = last ? text.lastIndexOf(needle) : text.indexOf(needle);
  const start = text.lastIndexOf('\n      - ', at) + 1;
  const next = text.indexOf('\n      - ', at);
  const blank = text.indexOf('\n\n', at);
  const ends = [next, blank].filter((i) => i >= 0).map((i) => i + 1);
  return [start, ends.length > 0 ? Math.min(...ends) : text.length];
}

/** Tira o passo que contém `needle` (a última, com `last`) e o põe antes do índice de `where`. */
function moveStep(
  text: string,
  needle: string,
  where: (rest: string) => number,
  last = false,
): string {
  const [start, end] = stepRange(text, needle, last);
  const step = text.slice(start, end);
  const rest = text.slice(0, start) + text.slice(end);
  const at = where(rest);
  return rest.slice(0, at) + step + rest.slice(at);
}

/** Troca a n-ésima ocorrência (1 = a primeira) de `from` por `to`. */
function replaceNth(text: string, from: string, to: string, n: number): string {
  let at = -1;
  for (let k = 0; k < n; k += 1) {
    at = text.indexOf(from, at + 1);
    if (at < 0) return text;
  }
  return text.slice(0, at) + to + text.slice(at + from.length);
}

/** Tira a linha inteira da primeira (ou, com `last`, da última) ocorrência de `needle`. */
function dropLine(text: string, needle: string, last = false): string {
  const at = last ? text.lastIndexOf(needle) : text.indexOf(needle);
  if (at < 0) return text;
  return text.slice(0, text.lastIndexOf('\n', at) + 1) + text.slice(text.indexOf('\n', at) + 1);
}

/** Insere `extra` antes do passo que contém `needle`. */
function beforeStep(text: string, needle: string, extra: string): string {
  const [start] = stepRange(text, needle);
  return text.slice(0, start) + extra + text.slice(start);
}

/** Fim do job bundle-dry-run (a linha em branco que o separa do caminho assinado). */
const endOfDryRun = (t: string) => t.indexOf('\n\n', t.indexOf('\n  bundle-dry-run:\n')) + 1;
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
      name: 'pnpm com minimumReleaseAge baixo (AS-06, AC-B09)',
      file: 'pnpm-workspace.yaml',
      change: (t: string) => t.replace(/^minimumReleaseAge: \d+$/m, 'minimumReleaseAge: 60'),
      message: 'minimumReleaseAge ausente ou < 10080 (achado: 60)',
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
      name: 'AC-B01.7 → S-2: passo antes do require-signing-secrets do sign-macos (fail-closed)',
      file: '.github/workflows/release.yml',
      change: (t: string) =>
        t.replace(
          '      - id: require-signing-secrets\n',
          '      - run: echo antes\n      - id: require-signing-secrets\n',
        ),
      message: 'jobs.sign-macos: o 1º passo tem de ser id: require-signing-secrets',
    },
    {
      name: 'CR3-R2 → P-1: publish sem esperar o sign-macos',
      file: '.github/workflows/release.yml',
      change: (t: string) =>
        t.replace(
          '  publish:\n    needs: [bundle-windows, sign-macos]\n',
          '  publish:\n    needs: bundle-windows\n',
        ),
      message: 'jobs.publish: needs tem de ser exatamente bundle-windows e sign-macos',
    },
    {
      name: 'CR3-R2 → P-11: checkout no publish (token de escrita)',
      file: '.github/workflows/release.yml',
      change: (t: string) =>
        beforeStep(
          t,
          'artifact-ids: ${{ needs.sign-macos.outputs.signed-dmg-artifact-id }}',
          `      - uses: ${CHECKOUT}\n        with:\n          persist-credentials: false\n`,
        ),
      message: 'jobs.publish não pode fazer checkout',
    },
    {
      name: 'CR3-R2 → P-12: script do repositório no publish',
      file: '.github/workflows/release.yml',
      change: (t: string) =>
        t.replace(
          'run: gh release create "$TAG"',
          'run: node scripts/x.mjs && gh release create "$TAG"',
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
      name: 'APPSEC-R3-01 → S-7: segredo no tauri build do bundle-windows',
      file: '.github/workflows/release.yml',
      // A última ocorrência é a do bundle-windows (o dry-run e o bundle-macos vêm antes).
      change: (t: string) => {
        const step = '      - run: pnpm --filter @simplemd/desktop tauri build --no-bundle';
        const at = t.lastIndexOf(step);
        const end = t.indexOf('\n', at) + 1;
        return `${t.slice(0, end)}        env:\n          APPLE_ID: \${{ secrets.APPLE_ID }}\n${t.slice(end)}`;
      },
      message:
        'segredos só no env dos passos require-signing-secrets e sign do sign-macos (achado: jobs.bundle-windows',
    },
    {
      name: 'APPSEC-R3-05 → S-7: segredo no pnpm install do bundle-windows',
      file: '.github/workflows/release.yml',
      change: (t: string) => {
        const step = '      - run: pnpm install --frozen-lockfile\n';
        const end = t.lastIndexOf(step) + step.length;
        return `${t.slice(0, end)}        env:\n          APPLE_ID: \${{ secrets.APPLE_ID }}\n${t.slice(end)}`;
      },
      message:
        'segredos só no env dos passos require-signing-secrets e sign do sign-macos (achado: jobs.bundle-windows',
    },
    {
      name: 'APPSEC-R3-05 → G-1: sem a conferência da main no release-guard do bundle-windows',
      file: '.github/workflows/release.yml',
      // r5/r18: a última ocorrência é a do release-guard do bundle-windows.
      change: (t: string) =>
        replaceLast(
          t,
          '          git merge-base --is-ancestor "$GITHUB_SHA" origin/main || { echo "::error::o commit da tag não está na main"; exit 1; }\n',
          '          true\n',
        ),
      message: 'jobs.bundle-windows: falta o release-guard (tag v*, main, versões)',
    },
    {
      name: 'CR3-R6 → W-2: o -setup.exe deixa de ser conferido como NotSigned',
      file: '.github/workflows/release.yml',
      change: (t: string) => dropLine(t, "-ne 'NotSigned'"),
      message:
        'jobs.bundle-windows: o -setup.exe tem de ser conferido como NotSigned antes do upload',
    },
    {
      name: 'CR3-R6 → G-2: checkout do bundle-windows sem fetch-depth: 0',
      file: '.github/workflows/release.yml',
      // r5/r18: o último `fetch-depth: 0` é o do checkout do bundle-windows.
      change: (t: string) => replaceLast(t, '          fetch-depth: 0\n', ''),
      message: 'jobs.bundle-windows: checkout sem fetch-depth: 0',
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
      change: (t: string) =>
        replaceLast(t, SUMS_LINE, `          node scripts/x.mjs\n${SUMS_LINE}`),
      message: 'jobs.publish-unsigned não pode executar código do repositório',
    },
    {
      name: 'C6: shell rodando outro comando no publish-unsigned',
      file: RELEASE,
      change: (t: string) =>
        replaceLast(t, '          cat SHA256SUMS\n', '          bash -c "cat SHA256SUMS"\n'),
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
      change: (t: string) => t.replace(/^.*"release\/macos\/dmg\/\$DMG".*\n/m, ''),
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
      change: (t: string) => replaceLast(t, SUMS_LINE, '          sha256sum -- * > SHA256SUMS\n'),
      message: LIST,
    },
    {
      name: 'C8: lista conferida depois do SHA256SUMS',
      file: RELEASE,
      change: (t: string) =>
        replaceLast(t.replace(DIFF_LINE, ''), SUMS_LINE, SUMS_LINE + DIFF_LINE),
      message: LIST,
    },
    {
      name: 'C9: sem a atestação',
      file: RELEASE,
      change: (t: string) => {
        const [start, end] = stepRange(t, 'subject-checksums: assets/SHA256SUMS', true);
        return t.slice(0, start) + t.slice(end);
      },
      message: ATTEST,
    },
    {
      name: 'C9: atestação depois do gh release create',
      file: RELEASE,
      change: (t: string) =>
        moveStep(t, 'subject-checksums: assets/SHA256SUMS', (rest) => rest.length, true),
      message: ATTEST,
    },
    {
      name: 'C10/CI-R5-06 (e): release publicado direto (sem --draft)',
      file: RELEASE,
      change: (t: string) =>
        replaceLast(
          t,
          '--verify-tag --draft --prerelease --title',
          '--verify-tag --prerelease --title',
        ),
      message: CREATE,
    },
    {
      name: 'C10: sem --verify-tag (criaria a tag)',
      file: RELEASE,
      change: (t: string) =>
        replaceLast(t, '--verify-tag --draft --prerelease', '--draft --prerelease'),
      message: CREATE,
    },
    {
      name: 'C10/CI-R5-06 (d): sem --prerelease',
      file: RELEASE,
      change: (t: string) => replaceLast(t, '--draft --prerelease --title', '--draft --title'),
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
      change: (t: string) =>
        replaceLast(
          t,
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
      change: (t: string) =>
        t.replace(
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
      name: "C16/CI-R5-09 (c): '-' no tauri build do bundle-windows",
      file: RELEASE,
      change: (t: string) => {
        const step =
          '      - run: pnpm --filter @simplemd/desktop tauri build --no-bundle --config src-tauri/tauri.release.conf.json -- --locked\n';
        return replaceLast(t, step, step + ADHOC_ENV);
      },
      message:
        "jobs.bundle-windows: APPLE_SIGNING_IDENTITY '-' só no tauri bundle do bundle-dry-run",
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
      change: (t: string) =>
        replaceLast(t, '          V="${TAG#v}"\n', '          V="${{ github.ref_name }}"\n'),
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
      name: 'C18/CI-R5-08 (b) → G-3: rust-cache no bundle-windows',
      file: RELEASE,
      change: (t: string) =>
        replaceLast(
          t,
          '      - run: rustup toolchain install\n',
          '      - run: rustup toolchain install\n      - uses: Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2\n',
        ),
      message: 'jobs.bundle-windows: cache no workflow de release',
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
      name: 'C19/CI-R5-07 (b) → G-4: bundle-windows sem -- --locked',
      file: RELEASE,
      change: (t: string) =>
        replaceLast(t, 'tauri.release.conf.json -- --locked', 'tauri.release.conf.json'),
      message: 'release.yml: jobs.bundle-windows: tauri build sem -- --locked (APPSEC-R3-04)',
    },
    {
      name: 'CI-R5-05 (a) → G-1: conferência da main do release-guard engolida (|| true)',
      file: RELEASE,
      change: (t: string) =>
        replaceLast(t, 'não está na main"; exit 1; }\n', 'não está na main"; exit 1; } || true\n'),
      message: 'jobs.bundle-windows: falta o release-guard (tag v*, main, versões)',
    },
    {
      name: 'CI-R5-05 (b) → W-2: NotSigned sem exit 1',
      file: RELEASE,
      change: (t: string) =>
        t.replace('achado: $($sig.Status)"; exit 1 }', 'achado: $($sig.Status)" }'),
      message:
        'jobs.bundle-windows: o -setup.exe tem de ser conferido como NotSigned antes do upload',
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
        replaceLast(t, '          path: release/windows\n', '          path: release/macos\n'),
      message: `${DOWNLOADS}, cada um na sua pasta`,
    },
    {
      name: 'AS-R5-REV-01: os dois artefatos de volta em release/',
      file: RELEASE,
      change: (t: string) =>
        replaceLast(
          replaceLast(t, '          path: release/macos\n', '          path: release\n'),
          '          path: release/windows\n',
          '          path: release\n',
        ),
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

  // r6/r18 (CR3-S1, CR3-R1, AS-R5-S08, L-1): cada regra do caminho assinado reprova a sua mutação.
  // Números do desenho do r6 (diag-release §7.1) com os acréscimos do r18; as linhas do r3/r5 que
  // perderam o assunto foram reescritas acima com o número que as substitui.
  const SIGN = 'release.yml: jobs.sign-macos';
  const PUB = 'release.yml: jobs.publish';
  const SIGN_SHELL_LINE = '        shell: /bin/bash --noprofile --norc -euo pipefail {0}\n';
  const STEP_HEAD = (id: string) => `      - id: ${id}\n${SIGN_SHELL_LINE}        env:\n`;
  const BUILD =
    '      - run: pnpm --filter @simplemd/desktop tauri build --no-bundle --config src-tauri/tauri.release.conf.json -- --locked\n';
  const MAC_BUNDLE =
    '      - run: pnpm --filter @simplemd/desktop tauri bundle --bundles app --config src-tauri/tauri.release.conf.json\n';
  const APP_SIGN =
    '/usr/bin/codesign --force --options runtime --timestamp --keychain "$KC" --sign "$SHA1" "$APP"';
  const COPYFILE =
    '          COPYFILE_DISABLE=1 /usr/bin/tar --no-mac-metadata --no-xattrs --no-acls --no-fflags -cf "$RUNNER_TEMP/simpleMD.app.tar" simpleMD.app\n';
  const SIGN_HEAD =
    "  sign-macos:\n    needs: bundle-macos\n    if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')\n    environment: release\n    runs-on: macos-26\n";
  const DMG_UPLOAD =
    '          path: ${{ runner.temp }}/out/*.dmg\n          archive: false\n          retention-days: 1\n';
  const PUB_HEAD =
    "  publish:\n    needs: [bundle-windows, sign-macos]\n    if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')\n";
  const PUB_DMG =
    '          artifact-ids: ${{ needs.sign-macos.outputs.signed-dmg-artifact-id }}\n';
  const SECRETS_ONLY =
    'segredos só no env dos passos require-signing-secrets e sign do sign-macos (achado: jobs.';
  const GATE = `${SIGN}: falta o portão da identidade antes do codesign`;
  const NOTARY = `${SIGN}: notarytool só com a chave de API`;
  test.each([
    {
      name: 'S-1: checkout no sign-macos',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '      - id: inputs\n',
          `      - uses: ${CHECKOUT}\n        with:\n          persist-credentials: false\n      - id: inputs\n`,
        ),
      message: `${SIGN} não pode fazer checkout`,
    },
    {
      name: 'S-3 (ex AS-R5-REV-02): um segredo a menos na conferência do passo 1',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          ' APPLE_API_KEY APPLE_API_PRIVATE_KEY APPLE_TEAM_ID; do\n',
          ' APPLE_API_KEY APPLE_TEAM_ID; do\n',
        ),
      message: `${SIGN}: o require-signing-secrets tem de falhar sem qualquer um`,
    },
    {
      name: 'S-4 (ex AS-R5-REV-02): a falta de segredos engolida (|| true)',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          'ausentes no Environment:$missing"; exit 1; }\n',
          'ausentes no Environment:$missing"; exit 1; } || true\n',
        ),
      message: `${SIGN}: o require-signing-secrets tem de falhar sem qualquer um`,
    },
    {
      name: 'S-4b: sem a recusa da notarização por Apple ID no passo 1',
      file: RELEASE,
      change: (t: string) => dropLine(t, 'notarização por Apple ID não é aceita'),
      message: `${SIGN}: o require-signing-secrets tem de falhar sem qualquer um`,
    },
    {
      name: 'S-5: pnpm no intake (código do projeto no job de assinatura)',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '          T="$RUNNER_TEMP/in/simpleMD.app.tar"\n',
          '          T="$RUNNER_TEMP/in/simpleMD.app.tar"\n          pnpm --version\n',
        ),
      message: `${SIGN} não pode executar código do projeto nem pnpm`,
    },
    {
      name: 'S-6: segredo no env do verify',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          STEP_HEAD('verify'),
          `${STEP_HEAD('verify')}          APPLE_API_KEY: \${{ secrets.APPLE_API_KEY }}\n`,
        ),
      message: `${SECRETS_ONLY}sign-macos`,
    },
    {
      name: 'S-7 (CI-R6-06): APPLE_* no tauri build do bundle-macos',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          BUILD + MAC_BUNDLE,
          `${BUILD}        env:\n          APPLE_API_KEY: \${{ secrets.APPLE_API_KEY }}\n${MAC_BUNDLE}`,
        ),
      message: 'release.yml: jobs.bundle-macos: env com APPLE_API_KEY (APPLE_* só no sign-macos)',
    },
    {
      name: 'S-8: APPLE_ID no env do sign (notarização por Apple ID)',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          STEP_HEAD('sign'),
          `${STEP_HEAD('sign')}          APPLE_ID: \${{ secrets.APPLE_ID }}\n`,
        ),
      message: 'release.yml: notarização por Apple ID não é aceita',
    },
    {
      name: 'S-9: APPLE_API_KEY_PATH no env do sign',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          STEP_HEAD('sign'),
          `${STEP_HEAD('sign')}          APPLE_API_KEY_PATH: \${{ secrets.APPLE_API_KEY_PATH }}\n`,
        ),
      message: 'release.yml: secrets.APPLE_API_KEY_PATH não é aceito',
    },
    {
      name: 'S-10 (AS-R5-S08): identidade de entrada no sign',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          STEP_HEAD('sign'),
          `${STEP_HEAD('sign')}          APPLE_SIGNING_IDENTITY: \${{ vars.APPLE_SIGNING_IDENTITY }}\n`,
        ),
      message: `${SIGN}: APPLE_SIGNING_IDENTITY não é aceito (identidade derivada do .p12)`,
    },
    {
      name: 'S-11 (AS-R5-S08): codesign ad-hoc (--sign -) no .app',
      file: RELEASE,
      change: (t: string) =>
        t.replace(APP_SIGN, APP_SIGN.replace('--keychain "$KC" --sign "$SHA1"', '--sign -')),
      message: `${SIGN}: codesign nunca com --sign - (ad-hoc, AS-R5-S08)`,
    },
    {
      name: 'S-12 (AS-R5-S08): sem conferir o nome Developer ID Application e o Team ID',
      file: RELEASE,
      change: (t: string) => dropLine(t, '/usr/bin/grep -qF "\\"Developer ID Application: '),
      message: GATE,
    },
    {
      name: 'S-12b (AS-R5-S08): sem exigir exatamente 1 identidade válida',
      file: RELEASE,
      change: (t: string) => dropLine(t, '     1 valid identities found'),
      message: GATE,
    },
    {
      name: 'S-12c (AS-R5-S08): sem a regex do SHA-1 (o `-` passaria)',
      file: RELEASE,
      change: (t: string) => dropLine(t, '[[ "$SHA1" =~ ^[0-9A-F]{40}$ ]]'),
      message: GATE,
    },
    {
      name: 'S-13 (CR3-R1): sem o passo verify',
      file: RELEASE,
      change: (t: string) => {
        const [start, end] = stepRange(t, '      - id: verify\n');
        return t.slice(0, start) + t.slice(end);
      },
      message: `${SIGN}: falta o passo verify`,
    },
    {
      name: 'S-14 (CR3-R1): verify depois do upload do dmg',
      file: RELEASE,
      change: (t: string) =>
        moveStep(t, '      - id: verify\n', (rest) => rest.indexOf('\n\n  # r6/r18 (R-04') + 1),
      message: `${SIGN}: o verify tem de rodar antes do upload`,
    },
    {
      name: 'S-15 (CR3-R1): if: false no verify',
      file: RELEASE,
      change: (t: string) =>
        t.replace('      - id: verify\n', '      - id: verify\n        if: false\n'),
      message: `${SIGN}: passo com if: (nenhum passo pode ser pulado)`,
    },
    {
      name: 'S-16: continue-on-error no sign',
      file: RELEASE,
      change: (t: string) =>
        t.replace('      - id: sign\n', '      - id: sign\n        continue-on-error: true\n'),
      message: `${SIGN}: continue-on-error no release.yml`,
    },
    {
      name: 'S-17 (AS-R5-S08): verify do .app sem TeamIdentifier',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          `'Authority=Apple Root CA' "TeamIdentifier=$APPLE_TEAM_ID"; do /usr/bin/grep -qxF "$l" <<< "$info"`,
          `'Authority=Apple Root CA'; do /usr/bin/grep -qxF "$l" <<< "$info"`,
        ),
      message: `${SIGN}: o verify tem de exigir a cadeia do Developer ID e TeamIdentifier=$APPLE_TEAM_ID`,
    },
    {
      name: 'S-17b (AS-R5-S08): verify do dmg sem TeamIdentifier',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          `'Authority=Apple Root CA' "TeamIdentifier=$APPLE_TEAM_ID"; do /usr/bin/grep -qxF "$l" <<< "$dinfo"`,
          `'Authority=Apple Root CA'; do /usr/bin/grep -qxF "$l" <<< "$dinfo"`,
        ),
      message: `${SIGN}: o verify tem de exigir a cadeia do Developer ID e TeamIdentifier=$APPLE_TEAM_ID`,
    },
    {
      name: 'S-18 (CR3-R1): verify sem o spctl do dmg',
      file: RELEASE,
      change: (t: string) => dropLine(t, 'dgk=$(/usr/sbin/spctl --assess'),
      message: `${SIGN}: o verify tem de passar o spctl`,
    },
    {
      name: 'S-19 (CR3-R1): verify sem o stapler validate do .app',
      file: RELEASE,
      change: (t: string) => dropLine(t, '/usr/bin/xcrun stapler validate "$A"'),
      message: `${SIGN}: o verify tem de rodar stapler validate no .app e no dmg`,
    },
    {
      name: 'S-19b (CR3-R1): verify sem o stapler validate do dmg',
      file: RELEASE,
      change: (t: string) => dropLine(t, '/usr/bin/xcrun stapler validate "$DMG"'),
      message: `${SIGN}: o verify tem de rodar stapler validate no .app e no dmg`,
    },
    {
      name: 'S-19c (CR3-R1): verify sem o --deep --strict do .app',
      file: RELEASE,
      change: (t: string) =>
        dropLine(t, '/usr/bin/codesign --verify --deep --strict --verbose=2 "$A"'),
      message: `${SIGN}: o verify tem de rodar codesign --verify --strict no dmg e --deep no .app`,
    },
    {
      name: 'S-20: notarytool submit sem --wait',
      file: RELEASE,
      change: (t: string) => t.replace(' --wait --timeout 45m', ' --timeout 45m'),
      message: NOTARY,
    },
    {
      name: 'S-21: sem o log da notarização',
      file: RELEASE,
      change: (t: string) => dropLine(t, '/usr/bin/xcrun notarytool log "$sub"'),
      message: NOTARY,
    },
    {
      name: 'S-22: sem o trap da limpeza',
      file: RELEASE,
      change: (t: string) => dropLine(t, 'trap cleanup EXIT INT TERM'),
      message: `${SIGN}: limpeza (trap cleanup EXIT INT TERM) armada antes do security create-keychain`,
    },
    {
      name: 'S-22b: trap armado depois do create-keychain',
      file: RELEASE,
      change: (t: string) =>
        dropLine(t, 'trap cleanup EXIT INT TERM').replace(
          '          /usr/bin/security create-keychain -p "$KC_PASS" "$KC"\n',
          '          /usr/bin/security create-keychain -p "$KC_PASS" "$KC"\n          trap cleanup EXIT INT TERM\n',
        ),
      message: `${SIGN}: limpeza (trap cleanup EXIT INT TERM) armada antes do security create-keychain`,
    },
    {
      name: 'S-23: verify sem conferir que o keychain e as chaves sumiram',
      file: RELEASE,
      change: (t: string) => dropLine(t, '[ ! -e "$RUNNER_TEMP/simplemd-signing.keychain-db" ]'),
      message: `${SIGN}: o verify tem de conferir keychain ausente`,
    },
    {
      name: 'S-24: security import com -A (qualquer app usa a chave)',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '-P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign',
          '-P "$APPLE_CERTIFICATE_PASSWORD" -A',
        ),
      message: `${SIGN}: security import só com -T /usr/bin/codesign (nunca -A)`,
    },
    {
      name: 'S-24b: o .p8 não é apagado logo depois do uso',
      file: RELEASE,
      change: (t: string) => dropLine(t, '/bin/rm -f "$RUNNER_TEMP/AuthKey.p8"'),
      message: `${SIGN}: o AuthKey.p8 só em $RUNNER_TEMP e apagado logo depois do uso`,
    },
    {
      name: 'S-25: codesign sem caminho absoluto',
      file: RELEASE,
      change: (t: string) => t.replace(APP_SIGN, APP_SIGN.replace('/usr/bin/codesign', 'codesign')),
      message: `${SIGN}: codesign sem caminho absoluto`,
    },
    {
      name: 'S-26: sign no bash do runner (com profile/rc)',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          `      - id: sign\n${SIGN_SHELL_LINE}`,
          '      - id: sign\n        shell: bash\n',
        ),
      message: `${SIGN}: shell tem de ser /bin/bash --noprofile --norc`,
    },
    {
      name: 'S-27: --deep na assinatura do .app',
      file: RELEASE,
      change: (t: string) => t.replace(APP_SIGN, APP_SIGN.replace('--force', '--force --deep')),
      message: `${SIGN}: codesign de assinatura sem --deep`,
    },
    {
      name: 'S-28: --preserve-metadata na assinatura do .app',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          APP_SIGN,
          APP_SIGN.replace('--force', '--force --preserve-metadata=entitlements'),
        ),
      message: `${SIGN}: codesign de assinatura sem --preserve-metadata`,
    },
    {
      name: "S-29: listagem do tar sem --options 'tar:!mac-ext' (esconde os ._*)",
      file: RELEASE,
      change: (t: string) =>
        t.replace(`/usr/bin/tar --options 'tar:!mac-ext' -tf "$T"`, '/usr/bin/tar -tf "$T"'),
      message: "jobs.sign-macos: toda listagem/extração do tar com --options 'tar:!mac-ext'",
    },
    {
      name: 'S-29b: extração do tar sem --no-same-owner',
      file: RELEASE,
      change: (t: string) =>
        t.replace(' --no-mac-metadata --no-same-owner -xf', ' --no-mac-metadata -xf'),
      message: `${SIGN}: extração do tar sem as opções da extração segura`,
    },
    {
      name: 'S-30 (DV-11): xattr -cr copiado para o bundle-macos',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          COPYFILE,
          `${COPYFILE}          /usr/bin/xattr -cr "$RUNNER_TEMP/app/simpleMD.app"\n`,
        ),
      message: 'release.yml: instrução para contornar a proteção do sistema (achado: xattr)',
    },
    {
      name: 'S-31: download do .app por nome em vez do id da saída',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '          artifact-ids: ${{ needs.bundle-macos.outputs.app-tar-artifact-id }}\n',
          '          name: simpleMD.app.tar\n',
        ),
      message: `${SIGN}: um download só, por artifact-ids da saída do bundle-macos`,
    },
    {
      name: 'S-32: digest-mismatch: ignore no download do .app',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '          path: ${{ runner.temp }}/in\n',
          '          path: ${{ runner.temp }}/in\n          digest-mismatch: ignore\n',
        ),
      message: `${SIGN}: digest-mismatch tem de ficar no padrão (error)`,
    },
    {
      name: 'S-33 (CI-R6-24): sign-macos em macos-latest',
      file: RELEASE,
      change: (t: string) => t.replace(SIGN_HEAD, SIGN_HEAD.replace('macos-26', 'macos-latest')),
      message: `${SIGN}: runner fixado macos-26`,
    },
    {
      name: 'S-34: sign-macos com token de escrita',
      file: RELEASE,
      change: (t: string) =>
        t.replace('    permissions: {}\n', '    permissions:\n      contents: write\n'),
      message: `${SIGN}: permissão de escrita no CI: contents: write`,
    },
    {
      name: 'S-35: sign-macos fora do Environment release',
      file: RELEASE,
      change: (t: string) =>
        t.replace(SIGN_HEAD, SIGN_HEAD.replace('environment: release', 'environment: release-x')),
      message: `${SIGN}: Environment tem de ser release`,
    },
    {
      name: 'S-36 (D-R18-01): input rehearse_signing de volta',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '    inputs:\n',
          "    inputs:\n      rehearse_signing:\n        description: 'ensaio'\n        type: boolean\n        default: false\n",
        ),
      message: DISPATCH,
    },
    {
      name: 'S-37: sign-macos também no workflow_dispatch',
      file: RELEASE,
      change: (t: string) =>
        t.replace(SIGN_HEAD, SIGN_HEAD.replace("github.event_name == 'push' && ", '')),
      message: `${SIGN}: if do caminho assinado`,
    },
    {
      name: 'S-38: overwrite: true no upload do dmg',
      file: RELEASE,
      change: (t: string) => t.replace(DMG_UPLOAD, `${DMG_UPLOAD}          overwrite: true\n`),
      message: `${SIGN}: overwrite não é aceito no upload`,
    },
    {
      name: 'S-39: dmg retido 7 dias',
      file: RELEASE,
      change: (t: string) =>
        t.replace(DMG_UPLOAD, DMG_UPLOAD.replace('retention-days: 1', 'retention-days: 7')),
      message: `${SIGN}: o upload sobe só o dmg`,
    },
    {
      name: 'S-40 (regra E): Entitlements.plist com chave',
      file: 'apps/desktop/src-tauri/Entitlements.plist',
      change: (t: string) =>
        t.replace(
          '<dict/>',
          '<dict>\n  <key>com.apple.security.cs.allow-jit</key>\n  <true/>\n</dict>',
        ),
      message: 'Entitlements.plist com chaves: o sign-macos assina sem --entitlements',
    },
    {
      name: 'S-40b (regra E): --entitlements na assinatura do .app',
      file: RELEASE,
      change: (t: string) =>
        t.replace(APP_SIGN, APP_SIGN.replace('--timestamp', '--timestamp --entitlements x.plist')),
      message: `${SIGN}: codesign sem --entitlements`,
    },
    {
      name: 'S-41 (linha T, AS-R5-S08): verify sem conferir o formato do Team ID',
      file: RELEASE,
      change: (t: string) => dropLine(t, 'APPLE_TEAM_ID com formato inválido', true),
      message: `${SIGN}: o verify começa conferindo o formato do APPLE_TEAM_ID`,
    },
    {
      name: 'S-42 (CI-R6-22): bundle.publisher diferente do nome da identidade',
      file: 'apps/desktop/src-tauri/tauri.conf.json',
      change: (t: string) => t.replace('"publisher": "Rafael Brauner"', '"publisher": "Rafael B."'),
      message: 'tem de usar o bundle.publisher do tauri.conf.json (Rafael B.)',
    },
    {
      name: 'S-43 (A1): tar do .app sem a licença do r8',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          'simpleMD.app/Contents/Resources/ simpleMD.app/Contents/Resources/THIRD-PARTY-LICENSES.txt ',
          'simpleMD.app/Contents/Resources/ ',
        ),
      message: 'release.yml: jobs.bundle-macos: tar do .app tem de ser o fixado',
    },
    {
      name: 'S-43b (A1): intake sem a licença do r8',
      file: RELEASE,
      change: (t: string) =>
        replaceNth(
          t,
          'simpleMD.app/Contents/Resources/ simpleMD.app/Contents/Resources/THIRD-PARTY-LICENSES.txt ',
          'simpleMD.app/Contents/Resources/ ',
          2,
        ),
      message: `${SIGN}: o passo intake não é o fixado`,
    },
    {
      name: 'S-44 (DV-13): GITHUB_ENV no sign',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '          umask 077\n',
          '          umask 077\n          echo "X=1" >> "$GITHUB_ENV"\n',
        ),
      message: `${SIGN}: GITHUB_ENV/GITHUB_PATH no caminho assinado`,
    },
    {
      name: 'S-45 (DV-12): vars.APPLE_TEAM_ID no publish',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '          TAG: ${{ github.ref_name }}\n          DMG_SHA: ',
          '          TAG: ${{ github.ref_name }}\n          APPLE_TEAM_ID: ${{ vars.APPLE_TEAM_ID }}\n          DMG_SHA: ',
        ),
      message: 'vars.APPLE_TEAM_ID só no env dos passos require-signing-secrets, sign e verify',
    },
    {
      name: 'S-46: ação de terceiros no sign-macos',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '      - id: inputs\n',
          '      - uses: apple-actions/import-codesign-certs@0000000000000000000000000000000000000000 # v3.0.0\n      - id: inputs\n',
        ),
      message: `${SIGN}: ação não permitida no job de assinatura`,
    },
    {
      name: 'S-47: GITHUB_WORKSPACE no sign',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '          umask 077\n',
          '          umask 077\n          cd "$GITHUB_WORKSPACE"\n',
        ),
      message: `${SIGN}: sem set +e/-x, xtrace, DEVELOPER_DIR, xcode-select, sudo`,
    },
    {
      name: 'S-48: sign-macos esperando também o bundle-windows',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          SIGN_HEAD,
          SIGN_HEAD.replace('needs: bundle-macos', 'needs: [bundle-macos, bundle-windows]'),
        ),
      message: `${SIGN}: needs tem de ser só bundle-macos`,
    },
    {
      name: 'W-1: bundle-windows no Environment release',
      file: RELEASE,
      change: (t: string) =>
        t.replace('  bundle-windows:\n', '  bundle-windows:\n    environment: release\n'),
      message: 'release.yml: jobs.bundle-windows: sem Environment (o build não vê segredos)',
    },
    {
      name: 'W-3: segredo no passo exe do bundle-windows',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '        name: Instalador declarado sem assinatura (NotSigned) e SHA-256\n        shell: pwsh\n',
          '        name: Instalador declarado sem assinatura (NotSigned) e SHA-256\n        shell: pwsh\n        env:\n          X: ${{ secrets.APPLE_API_KEY }}\n',
        ),
      message: `${SECRETS_ONLY}bundle-windows`,
    },
    {
      name: 'W-4: -setup.exe zipado no upload',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '          path: apps/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe\n          archive: false\n',
          '          path: apps/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe\n          archive: true\n',
        ),
      message: 'release.yml: jobs.bundle-windows: o upload sobe só o -setup.exe',
    },
    {
      name: 'W-5: bundle-windows gera todos os pacotes (o .msi também)',
      file: RELEASE,
      change: (t: string) =>
        t.replace('tauri bundle --bundles nsis --config', 'tauri bundle --config'),
      message: 'release.yml: jobs.bundle-windows: tauri bundle do caminho assinado tem de ser',
    },
    {
      name: 'G-1: conferência da main engolida no release-guard do bundle-macos',
      file: RELEASE,
      change: (t: string) =>
        replaceNth(
          t,
          'não está na main"; exit 1; }\n',
          'não está na main"; exit 1; } || true\n',
          2,
        ),
      message: 'release.yml: jobs.bundle-macos: falta o release-guard (tag v*, main, versões)',
    },
    {
      name: 'G-2: checkout do bundle-macos sem fetch-depth: 0',
      file: RELEASE,
      change: (t: string) => replaceNth(t, '          fetch-depth: 0\n', '', 2),
      message: 'release.yml: jobs.bundle-macos: checkout sem fetch-depth: 0',
    },
    {
      name: 'G-3: rust-cache no bundle-macos',
      file: RELEASE,
      change: (t: string) =>
        replaceNth(
          t,
          '      - run: rustup toolchain install\n',
          '      - run: rustup toolchain install\n      - uses: Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2\n',
          2,
        ),
      message: 'release.yml: jobs.bundle-macos: cache no workflow de release',
    },
    {
      name: 'G-5: bundle-macos em matriz',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '  bundle-macos:\n',
          '  bundle-macos:\n    strategy:\n      matrix:\n        os: [macos-26]\n',
        ),
      message: 'release.yml: jobs.bundle-macos não pode ser matriz',
    },
    {
      name: 'G-6: tar do .app zipado no upload',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '          path: ${{ runner.temp }}/simpleMD.app.tar\n          archive: false\n',
          '          path: ${{ runner.temp }}/simpleMD.app.tar\n          archive: true\n',
        ),
      message: 'release.yml: jobs.bundle-macos: o upload sobe só o tar do .app (archive: false',
    },
    {
      name: 'G-7 (AS-R5-S08): identidade no tauri bundle do bundle-macos',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          MAC_BUNDLE,
          `${MAC_BUNDLE}        env:\n          APPLE_SIGNING_IDENTITY: 'Developer ID Application: X'\n`,
        ),
      message:
        'release.yml: jobs.bundle-macos: APPLE_SIGNING_IDENTITY não é aceito (identidade derivada',
    },
    {
      name: 'P-2 (L-1): download do publish por pattern + merge-multiple',
      file: RELEASE,
      change: (t: string) =>
        t.replace(PUB_DMG, "          pattern: '*'\n          merge-multiple: true\n"),
      message: `${PUB} baixa só pelos artifact-ids`,
    },
    {
      name: 'P-3 (L-1): SHA256SUMS de tudo (*) no publish',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '          sha256sum -- "$DMG" "$EXE" > SHA256SUMS\n',
          '          sha256sum -- * > SHA256SUMS\n',
        ),
      message: `${PUB}: SHA256SUMS só com os nomes (sha256sum -- "$DMG" "$EXE"); glob é o L-1`,
    },
    {
      name: 'P-4 (CR3-R1): publish sem conferir o sha256 do dmg',
      file: RELEASE,
      change: (t: string) => dropLine(t, '= "$DMG_SHA" ]'),
      message: `${PUB}: a lista exata tem de ser a fixada`,
    },
    {
      name: 'P-5: atestação depois do gh release create no publish',
      file: RELEASE,
      change: (t: string) =>
        moveStep(
          t,
          'subject-checksums: assets/SHA256SUMS',
          (rest) => rest.indexOf('\n\n  # r5: pré-lançamento SEM assinatura.') + 1,
        ),
      message: `${PUB}: falta a atestação antes do gh release create`,
    },
    {
      name: 'P-6: release assinado publicado direto (sem --draft)',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '--verify-tag --draft --prerelease --title "simpleMD ${TAG#v} (macOS',
          '--verify-tag --prerelease --title "simpleMD ${TAG#v} (macOS',
        ),
      message: `${PUB}: gh release create com --verify-tag --draft --prerelease, sem notas`,
    },
    {
      name: 'P-7: publish também no workflow_dispatch',
      file: RELEASE,
      change: (t: string) =>
        t.replace(PUB_HEAD, PUB_HEAD.replace("github.event_name == 'push' && ", '')),
      message: `${PUB}: if do caminho assinado`,
    },
    {
      name: 'P-9 (DV-2): sétimo job no release.yml',
      file: RELEASE,
      change: (t: string) =>
        `${t}\n  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo x\n`,
      message: 'release.yml: jobs têm de ser exatamente bundle-dry-run, bundle-macos',
    },
    {
      name: 'P-10: notas por --notes-file no publish (o r18 cria o rascunho sem notas)',
      file: RELEASE,
      change: (t: string) => t.replace("--notes '' ", '--notes-file "$RUNNER_TEMP/notas.md" '),
      message: `${PUB}: gh release create com --verify-tag --draft --prerelease, sem notas`,
    },
    {
      name: 'P-13: token no passo da lista do publish',
      file: RELEASE,
      change: (t: string) =>
        t.replace(
          '          TAG: ${{ github.ref_name }}\n          DMG_SHA: ',
          '          TAG: ${{ github.ref_name }}\n          GH_TOKEN: ${{ github.token }}\n          DMG_SHA: ',
        ),
      message: `${PUB}: o token só no env do passo gh release create`,
    },
    {
      name: 'P-14 (AS-R6-M09): publish sem validar as saídas antes de baixar',
      file: RELEASE,
      change: (t: string) => {
        const [start, end] = stepRange(t, 'name: Saídas dos jobs anteriores (dados, não código)');
        return t.slice(0, start) + t.slice(end);
      },
      message: `${PUB}: o 1º passo valida as saídas (ids e sha256) antes de baixar`,
    },
    {
      name: 'P-16 (L-1): os dois arquivos do publish na mesma pasta',
      file: RELEASE,
      change: (t: string) =>
        t.replace('          path: release/windows\n', '          path: release/macos\n'),
      message: `${PUB} baixa só pelos artifact-ids`,
    },
  ])('reprova (r18): $name', ({ file, change, message }) => {
    const r = run(mutated(file, change));
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
