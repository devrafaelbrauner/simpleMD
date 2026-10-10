// r7 S0 (AC-X7.8, AC-X7.9; product r7 §7 L-2…L-4): os portões `scripts/check-licenses.mjs` e
// `scripts/check-single-codemirror.mjs` (os dois dentro de `pnpm lint`) aprovam o repositório e
// reprovam cada regressão: licença proibida, ausente ou desconhecida, dependência sem entrada no
// THIRD-PARTY-NOTICES.md, entrada sobrando, exceção nominal com outra versão, arquivo portado sem
// o cabeçalho L-3 e lockfile com duas versões de um pacote do CodeMirror.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const ROOT = join(__dirname, '../../..');
const LICENSES = join(ROOT, 'scripts/check-licenses.mjs');
const SINGLE = join(ROOT, 'scripts/check-single-codemirror.mjs');
const NOTICES = 'THIRD-PARTY-NOTICES.md';

type Licenses = Record<string, Array<{ name: string; versions: string[]; author?: string }>>;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'simplemd-licenses-'));
  dirs.push(dir);
  return dir;
}

function run(script: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

let real: Licenses;
beforeAll(() => {
  const listed = spawnSync('pnpm', ['-r', 'licenses', 'list', '--prod', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  expect(listed.status).toBe(0);
  real = JSON.parse(listed.stdout) as Licenses;
});

/** Raiz temporária com o NOTICES do repositório (opcionalmente alterado) e a lista de licenças. */
function fixture(
  licenses: Licenses,
  options: { notices?: (text: string) => string; files?: Record<string, string> } = {},
) {
  const root = tempDir();
  const notices = readFileSync(join(ROOT, NOTICES), 'utf8');
  writeFileSync(join(root, NOTICES), options.notices ? options.notices(notices) : notices);
  for (const [path, text] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const json = join(root, 'licenses.json');
  writeFileSync(json, JSON.stringify(licenses));
  return run(LICENSES, root, '--licenses', json);
}

/** Acrescenta uma linha à tabela "Dependências npm de produção" (depois do separador). */
function addRow(notices: string, row: string): string {
  const header = notices.indexOf('\n| Pacote ');
  const separatorEnd = notices.indexOf('\n', notices.indexOf('\n', header + 1) + 1);
  return `${notices.slice(0, separatorEnd + 1)}${row}\n${notices.slice(separatorEnd + 1)}`;
}

const withPackage = (license: string, name: string, version = '1.0.0'): Licenses => ({
  ...real,
  [license]: [...(real[license] ?? []), { name, versions: [version], author: 'Prova' }],
});

describe('check-licenses (AC-X7.9)', () => {
  test('o repositório passa: toda dependência de produção tem licença permitida e entrada', () => {
    const { status, out } = run(LICENSES);
    expect(out).toMatch(/^check-licenses: \d+ dependências de produção com licença permitida/);
    expect(status).toBe(0);
  });

  test('a lista real cobre as dependências novas do r7 (inclui katex 0.16.47 e commander)', () => {
    const ids = Object.values(real).flatMap((pkgs) =>
      pkgs.flatMap((p) => p.versions.map((v) => `${p.name}@${v}`)),
    );
    for (const id of [
      '@replit/codemirror-vim@6.4.0',
      'markdownlint@0.41.1',
      '@tgrosinger/md-advanced-tables@3.11.0',
      'dompurify@3.4.16',
      '@codemirror/search@6.7.2',
      'katex@0.16.47',
      'commander@8.3.0',
    ])
      expect(ids).toContain(id);
    expect(fixture(real).status).toBe(0);
  });

  test.each(['GPL-3.0', 'AGPL-3.0-only', 'LGPL-2.1-or-later', 'SSPL-1.0', '(MIT OR GPL-2.0)'])(
    'dependência %s de prova reprova, mesmo com entrada no NOTICES',
    (license) => {
      const { status, out } = fixture(withPackage(license, 'prova-copyleft'), {
        notices: (t) => addRow(t, `| \`prova-copyleft\` | ${license} | Prova | — |`),
      });
      expect(status).toBe(1);
      expect(out).toContain(`prova-copyleft@1.0.0: licença proibida em produção (${license}`);
      expect(out).not.toContain('sem entrada');
    },
  );

  test.each(['Unknown', '', 'UNLICENSED', 'WTFPL'])(
    'licença ausente, desconhecida ou fora da lista ("%s") reprova',
    (license) => {
      const { status, out } = fixture(withPackage(license, 'prova-sem-licenca'));
      expect(status).toBe(1);
      expect(out).toContain('prova-sem-licenca@1.0.0: licença ausente, desconhecida ou fora');
    },
  );

  test('dependência nova MIT sem entrada no NOTICES reprova e sugere a linha', () => {
    const { status, out } = fixture(withPackage('MIT', 'prova-sem-entrada'));
    expect(status).toBe(1);
    expect(out).toContain(
      'prova-sem-entrada (MIT): dependência de produção sem entrada no THIRD-PARTY-NOTICES.md (L-2). Linha: | `prova-sem-entrada` | MIT | Prova | — |',
    );
  });

  test('entrada com licença diferente da instalada reprova; entrada sobrando reprova', () => {
    const wrong = fixture(real, {
      notices: (t) =>
        t.replace(/^\| `dompurify` +\| \(MPL-2\.0 OR Apache-2\.0\)/m, '| `dompurify` | MIT'),
    });
    expect(wrong.status).toBe(1);
    expect(wrong.out).toContain(
      'dompurify ((MPL-2.0 OR Apache-2.0)): dependência de produção sem entrada',
    );
    const stale = fixture(real, {
      notices: (t) => addRow(t, '| `pacote-removido` | MIT | X | — |'),
    });
    expect(stale.status).toBe(1);
    expect(stale.out).toContain(
      'pacote-removido (MIT): está no THIRD-PARTY-NOTICES.md mas não é mais',
    );
  });

  test('exceção nominal vale só para a versão revisada (elkjs 0.9.3 EPL-2.0)', () => {
    const bumped = structuredClone(real);
    const elk = bumped['EPL-2.0']?.find((p) => p.name === 'elkjs');
    expect(elk?.versions).toEqual(['0.9.3']);
    elk!.versions = ['0.10.0'];
    const { status, out } = fixture(bumped);
    expect(status).toBe(1);
    expect(out).toContain(
      'elkjs@0.10.0: licença ausente, desconhecida ou fora da lista permitida (EPL-2.0)',
    );
  });

  test('cabeçalho L-3: arquivo portado sem o cabeçalho reprova; com ele passa; fora dos destinos é livre', () => {
    const header =
      '// Portado de silverbulletmd/silverbullet@70e58486e5e9d47dbfb13971e8576212896993c8 (MIT), © 2022 Zef Hemel. Modificado para o simpleMD.\n';
    const missing = fixture(real, {
      files: {
        'packages/core/src/wikilinks/syntax.ts': 'export const x = 1;\n',
        'packages/plugins-internal/src/outliner/operations/move.ts': 'export {};\n',
        'packages/plugins-internal/test/outliner.specs.test.ts':
          '// outro comentário\nexport {};\n',
        'packages/plugins-internal/src/outliner/cm-editor.ts': 'export {};\n',
        'packages/plugins-internal/src/latex-snippets/data/snippets.json': '[]\n',
      },
    });
    expect(missing.status).toBe(1);
    expect(missing.out).toContain('packages/core/src/wikilinks/syntax.ts: falta o cabeçalho L-3');
    expect(missing.out).toContain('outliner/operations/move.ts: falta o cabeçalho L-3');
    expect(missing.out).toContain('test/outliner.specs.test.ts: falta o cabeçalho L-3');
    expect(missing.out).not.toContain('cm-editor.ts');
    expect(missing.out).not.toContain('snippets.json');

    const wrongCommit = fixture(real, {
      files: { 'packages/core/src/wikilinks/syntax.ts': header.replace('70e5', '0000') + 'x;\n' },
    });
    expect(wrongCommit.status).toBe(1);

    const ok = fixture(real, {
      files: {
        'packages/core/src/wikilinks/syntax.ts': `${header}// Outra linha de comentário.\nexport const x = 1;\n`,
        'packages/plugins-internal/src/outliner/operations/move.ts':
          '// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.\nexport {};\n',
      },
    });
    expect(ok.out).toMatch(/^check-licenses: \d+ dependências/);
    expect(ok.status).toBe(0);
  });
});

describe('check-single-codemirror (AC-X7.8, D-R7-F21)', () => {
  const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
  function withLock(text: string) {
    const dir = tempDir();
    writeFileSync(join(dir, 'pnpm-lock.yaml'), text);
    return run(SINGLE, join(dir, 'pnpm-lock.yaml'));
  }

  test('o lockfile do repositório tem uma versão de cada @codemirror/* e @lezer/common|highlight|lr|markdown', () => {
    const { status, out } = run(SINGLE);
    expect(out).toMatch(/^check-single-codemirror: \d+ pacotes, uma versão de cada\./);
    expect(status).toBe(0);
  });

  test.each([
    ['@codemirror/state@6.7.6', '@codemirror/state@6.7.5'],
    ['@codemirror/commands@6.11.1', '@codemirror/commands@6.10.0'],
    ['@lezer/lr@1.4.10', '@lezer/lr@1.4.9'],
  ])('segunda cópia de %s reprova', (present, extra) => {
    expect(lock).toContain(`\n  '${present}':\n`);
    const { status, out } = withLock(
      lock.replace(
        `\n  '${present}':\n`,
        `\n  '${extra}':\n    resolution: {integrity: sha512-AAAA}\n\n  '${present}':\n`,
      ),
    );
    expect(status).toBe(1);
    const [name, version] = [
      extra.slice(0, extra.lastIndexOf('@')),
      extra.slice(extra.lastIndexOf('@') + 1),
    ];
    expect(out).toContain(`- ${name}: `);
    expect(out).toContain(version);
  });

  test('outros pacotes @lezer/* podem ter duas versões (só os 4 do núcleo contam)', () => {
    const { status } = withLock(
      lock.replace(
        "\n  '@lezer/css@1.3.8':\n",
        "\n  '@lezer/css@1.3.7':\n    resolution: {integrity: sha512-AAAA}\n\n  '@lezer/css@1.3.8':\n",
      ),
    );
    expect(status).toBe(0);
  });
});
