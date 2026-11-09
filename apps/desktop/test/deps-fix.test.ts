// r23 (R21-DEPENDABOT, AC-R23-1): `scripts/deps-fix.mjs` numa raiz temporária, sem rede. O pnpm é
// um script do Node (`DEPS_FIX_PNPM`) que registra cada chamada e simula o install; o resto roda de
// verdade: alinhamento dos overrides, constante do markdownlint, `check-licenses.mjs --fix` com a
// lista de licenças do teste, prettier, conferências internas e a leitura do audit e do Vitest.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

const ROOT = join(__dirname, '../../..');
const FIX = join(ROOT, 'scripts/deps-fix.mjs');
const RULES = 'packages/plugins-internal/src/lint/rules.ts';
const MARKDOWNLINT = 'packages/plugins-internal/node_modules/markdownlint/package.json';
const WORKSPACE = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
const KATEX = /^\s+mermaid>katex:\s*(\S+)/m.exec(WORKSPACE)?.[1] ?? '';
const OLD = '0.0.1';
const OFFLINE = ['--no-build', '--no-verify'];

type Licenses = Record<string, Array<{ name: string; versions: string[]; author?: string }>>;
type Direct = Record<string, Record<string, string>>;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'simplemd-deps-fix-'));
  dirs.push(dir);
  return dir;
}

// pnpm falso: registra a chamada em `pnpm-calls.txt` (na raiz, que é o cwd) e simula o pnpm.
// `FAKE_PNPM_FAIL` reprova a chamada sempre ou só a n-ésima (`<chamada> #n`), depois de o
// `--no-frozen-lockfile` mexer no lock; `FAKE_PNPM_GARBLED` deixa ilegível a saída do audit e do Vitest.
const FAKE_PNPM = join(tempDir(), 'pnpm.mjs');
writeFileSync(
  FAKE_PNPM,
  `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const line = args.join(' ');
appendFileSync('pnpm-calls.txt', line + '\\n');
const nth = readFileSync('pnpm-calls.txt', 'utf8').split('\\n').filter((l) => l === line).length;
if (line === 'install --no-frozen-lockfile') {
  const lock = readFileSync('pnpm-lock.yaml', 'utf8');
  writeFileSync('pnpm-lock.yaml', lock.replace(/\\n  katex@${OLD.replace(/\./g, '\\.')}:\\n[^\\n]*\\n/, '\\n'));
}
if ([line, line + ' #' + nth].includes(process.env.FAKE_PNPM_FAIL)) process.exit(1);
if (process.env.FAKE_PNPM_GARBLED && (args[0] === 'audit' || args[1] === 'vitest')) {
  console.log('<html>502 Bad Gateway</html>');
  process.exit(args[0] === 'audit' ? 0 : 1);
}
if (args[0] === 'exec' && args[1] === 'vitest') {
  const file = args.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length);
  const name = (path) => process.cwd() + '/' + path;
  writeFileSync(file, JSON.stringify({ testResults: [
    { name: name('apps/desktop/test/explorer-style-app.test.tsx'), status: 'failed' },
    { name: name('apps/desktop/test/sync.test.ts'), status: 'passed' },
  ] }));
  process.exit(1);
} else if (args[0] === 'audit') {
  console.log(JSON.stringify({ advisories: { 1: { module_name: 're2js', severity: 'high',
    github_advisory_id: 'GHSA-gg6h-894w-4m9c',
    findings: [{ version: '2.8.6', paths: ['packages__plugins-internal>markdownlint>re2js'] }] } } }));
  process.exit(1);
}
`,
);

const okLicenses = (markdownlint: string): Licenses => ({
  MIT: [
    { name: 'katex', versions: [KATEX], author: 'K' },
    { name: 'markdownlint', versions: [markdownlint], author: 'M' },
  ],
});

/** Raiz mínima do simpleMD: workspace real (katex trocável), lock, NOTICES, licenças, lint. */
function miniRepo(
  o: {
    overrides?: string;
    direct?: Direct;
    packages?: string[];
    markdownlint?: string;
    cited?: string;
    licenses?: Licenses;
  } = {},
): string {
  const root = tempDir();
  const md = o.markdownlint ?? '0.42.0';
  const direct = o.direct ?? {
    'apps/desktop': { katex: KATEX },
    'packages/plugins-internal': { katex: KATEX, markdownlint: md },
  };
  const importers = Object.entries(direct)
    .map(
      ([importer, deps]) =>
        `  ${importer}:\n    dependencies:\n${Object.entries(deps)
          .map(([name, v]) => `      ${name}:\n        specifier: ${v}\n        version: ${v}\n`)
          .join('')}`,
    )
    .join('\n');
  const packages = (o.packages ?? [`katex@${KATEX}`, `markdownlint@${md}`])
    .map((key) => `  ${key}:\n    resolution: {integrity: sha512-AAAA}\n`)
    .join('\n');
  const files: Record<string, string> = {
    'pnpm-workspace.yaml': WORKSPACE.replace(/(>katex:[ \t]*)\S+/g, `$1${o.overrides ?? KATEX}`),
    'pnpm-lock.yaml': `lockfileVersion: '9.0'\n\nimporters:\n\n${importers}\npackages:\n\n${packages}`,
    'THIRD-PARTY-NOTICES.md': [
      '# Avisos',
      '## Destinos dos portes',
      '| Destino | Origem | Licença | Autor |\n| --- | --- | --- | --- |',
      '## Dependências npm novas de produção do r7',
      `- \`markdownlint\` ${o.cited ?? md} (MIT) — tag \`v${o.cited ?? md}\`.`,
      '## Dependências npm de produção',
      '| Pacote | Licença | Autor | Página |\n| --- | --- | --- | --- |\n| `katex` | MIT | K | — |\n| `markdownlint` | MIT | M | — |',
      '## Textos das licenças\n',
    ].join('\n\n'),
    'licenses.json': JSON.stringify(o.licenses ?? okLicenses(md)),
    [MARKDOWNLINT]: JSON.stringify({ name: 'markdownlint', version: md }),
    [RULES]:
      "/** Regras. */\nexport const MARKDOWNLINT_VERSION = '0.42.0';\nexport const OUTRA = 1;\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function fix(root: string, args = OFFLINE, env: Record<string, string> = {}) {
  const calls = join(root, 'pnpm-calls.txt');
  rmSync(calls, { force: true });
  const result = spawnSync(
    process.execPath,
    [FIX, '--root', root, '--licenses', join(root, 'licenses.json'), ...args],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        DEPS_FIX_PNPM: FAKE_PNPM,
        DEPS_FIX_OSV: join(root, 'sem-osv'),
        ...env,
      },
    },
  );
  return {
    status: result.status,
    out: `${result.stdout}${result.stderr}`,
    calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [],
  };
}
const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8');

describe('pnpm deps:fix (r23)', () => {
  test('AC-R23-1 (katex): overrides atrasados vão para a versão direta, lock re-resolvido; 2ª rodada sem mudança', () => {
    const root = miniRepo({
      overrides: OLD,
      direct: {
        'apps/desktop': { katex: KATEX, lodash: '4.18.2' },
        'packages/plugins-internal': { katex: KATEX, markdownlint: '0.42.0' },
      },
      packages: [`katex@${OLD}`, `katex@${KATEX}`, 'lodash@4.18.2', 'markdownlint@0.42.0'],
    });
    const first = fix(root);
    expect(first.out).toContain(`pnpm-workspace.yaml: mermaid>katex ${OLD} → ${KATEX}`);
    expect(first.out).toContain(
      `pnpm-workspace.yaml: micromark-extension-math>katex ${OLD} → ${KATEX}`,
    );
    expect(first.out).toContain('pnpm-lock.yaml: re-resolvido; --frozen-lockfile ok');
    expect(first.calls).toEqual([
      'install --frozen-lockfile',
      'install --no-frozen-lockfile',
      'install --frozen-lockfile',
    ]);
    // Só os dois overrides do katex mudam: o arquivo volta a ser o do repositório, com comentários,
    // aspas e os overrides de segurança (o de lodash fica, mesmo com o app noutra versão).
    expect(read(root, 'pnpm-workspace.yaml')).toBe(WORKSPACE);
    expect(read(root, 'pnpm-lock.yaml')).not.toContain(`katex@${OLD}`);
    expect(first.out).toContain('deps:fix: 3 mudança(s), 0 pendência(s).');
    expect(first.status).toBe(0);

    const second = fix(root);
    expect(second.out).toContain('deps:fix: 0 mudança(s), 0 pendência(s).');
    expect(second.calls).toEqual(['install --frozen-lockfile']);
    expect(second.status).toBe(0);
  });

  test.each([
    [
      'versões diretas diferentes',
      { 'apps/desktop': { katex: '0.19.1' }, 'packages/plugins-internal': { katex: '0.19.2' } },
      '0.19.0',
      'o app usa katex em versões diferentes (apps/desktop 0.19.1, packages/plugins-internal 0.19.2)',
    ],
    [
      'rebaixamento',
      { 'apps/desktop': { katex: '0.19.1' }, 'packages/plugins-internal': { katex: '0.19.1' } },
      '0.19.2',
      '`mermaid>katex`: 0.19.2 → 0.19.1 seria rebaixamento',
    ],
  ])('recusa (%s): nada escrito, pendência, saída 1', (_, direct, overrides, message) => {
    const root = miniRepo({ direct, overrides, packages: ['katex@0.19.1', 'markdownlint@0.42.0'] });
    const before = read(root, 'pnpm-workspace.yaml');
    const { status, out, calls } = fix(root);
    expect(out).toContain(message);
    expect(read(root, 'pnpm-workspace.yaml')).toBe(before);
    expect(calls).toEqual(['install --frozen-lockfile']);
    expect(status).toBe(1);
  });

  test.each([
    ['install --frozen-lockfile', 'install --frozen-lockfile', ['install --frozen-lockfile']],
    [
      'install --no-frozen-lockfile',
      'install --no-frozen-lockfile',
      ['install --frozen-lockfile', 'install --no-frozen-lockfile', 'install --frozen-lockfile'],
    ],
    [
      'install --frozen-lockfile #2',
      'install --frozen-lockfile',
      [
        'install --frozen-lockfile',
        'install --no-frozen-lockfile',
        'install --frozen-lockfile',
        'install --frozen-lockfile',
      ],
    ],
  ])(
    'pnpm recusa (%s, ex.: idade mínima): pendência, workspace e lock como estavam, node_modules de volta',
    (failing, name, expected) => {
      const root = miniRepo({ overrides: OLD, packages: [`katex@${OLD}`, `katex@${KATEX}`] });
      const [workspace, lock] = [read(root, 'pnpm-workspace.yaml'), read(root, 'pnpm-lock.yaml')];
      const { status, out, calls } = fix(root, OFFLINE, { FAKE_PNPM_FAIL: failing });
      expect(out).toContain(`\`pnpm ${name}\` reprovou`);
      expect(out).not.toContain('Exclude');
      expect(read(root, 'pnpm-workspace.yaml')).toBe(workspace);
      expect(read(root, 'pnpm-lock.yaml')).toBe(lock);
      expect(calls).toEqual(expected);
      expect(status).toBe(1);
    },
  );

  test('MARKDOWNLINT_VERSION segue o markdownlint instalado; item da seção do r7 com versão velha vira pendência', () => {
    const root = miniRepo({ markdownlint: '0.42.1', cited: '0.42.0' });
    const { status, out } = fix(root);
    expect(read(root, RULES)).toBe(
      "/** Regras. */\nexport const MARKDOWNLINT_VERSION = '0.42.1';\nexport const OUTRA = 1;\n",
    );
    expect(out).toContain(`${RULES}: MARKDOWNLINT_VERSION 0.42.0 → 0.42.1`);
    expect(out).toContain(
      'THIRD-PARTY-NOTICES.md (seção do r7): `markdownlint` cita 0.42.0, o lock tem 0.42.1',
    );
    expect(status).toBe(1);
    expect(fix(root).out).toContain('deps:fix: 0 mudança(s), 1 pendência(s).');
  });

  test('NOTICES: linha de licença permitida entra alinhada; proibida nunca; segunda cópia vira pendência', () => {
    const licenses = okLicenses('0.42.0');
    licenses.MIT?.push({ name: 'prova-nova', versions: ['1.0.0'], author: 'Prova' });
    licenses['GPL-3.0'] = [{ name: 'prova-gpl', versions: ['1.0.0'], author: 'Prova' }];
    const root = miniRepo({ licenses, packages: [`katex@${OLD}`, `katex@${KATEX}`] });
    const { status, out } = fix(root);
    const notices = read(root, 'THIRD-PARTY-NOTICES.md');
    expect(notices).toMatch(/^\| `prova-nova` +\| MIT +\| Prova +\| — +\|$/m);
    expect(notices).not.toContain('prova-gpl');
    expect(out).toContain('THIRD-PARTY-NOTICES.md: +1 linha(s) (prova-nova)');
    expect(out).toContain('check-licenses: prova-gpl@1.0.0: licença proibida em produção (GPL-3.0');
    expect(out).toContain(`cópia única: katex com 2 cópias (katex@${OLD}, katex@${KATEX})`);
    expect(status).toBe(1);
  });

  test('conferência: aviso alto do audit e teste reprovando viram pendência; nada é corrigido', () => {
    const root = miniRepo();
    const { status, out, calls } = fix(root, ['--no-build']);
    expect(out).toContain(
      'vitest: 1 arquivo(s) reprovando: apps/desktop/test/explorer-style-app.test.tsx',
    );
    expect(out).toContain(
      'audit: high GHSA-gg6h-894w-4m9c re2js 2.8.6 (packages__plugins-internal>markdownlint>re2js)',
    );
    expect(out).toContain(
      'conferido: cópia única, versões do NOTICES (r7), check-licenses --require-destinations, eslint, prettier, typecheck',
    );
    expect(out).toContain('osv-scanner: não rodou');
    expect(out).toContain(`aviso: DEPS_FIX_PNPM definida (${FAKE_PNPM}); só para testes`);
    expect(out).toContain('aviso: DEPS_FIX_OSV definida');
    expect(out).toContain('deps:fix: 0 mudança(s), 2 pendência(s).');
    expect(calls.map((call) => call.replace(/--outputFile=.*/, '--outputFile=…'))).toEqual([
      'install --frozen-lockfile',
      'exec eslint . --max-warnings=0',
      'exec prettier --check .',
      'typecheck',
      'exec vitest run --reporter=json --outputFile=…',
      'audit --prod --audit-level high --json',
    ]);
    expect(status).toBe(1);
  });

  test('conferência: saída ilegível do audit e do Vitest vira pendência, nunca "conferido"', () => {
    const { status, out } = fix(miniRepo(), ['--no-build'], { FAKE_PNPM_GARBLED: '1' });
    expect(out).toContain('vitest: reprovou (saída acima)');
    expect(out).toContain(
      'audit: `pnpm audit --prod --audit-level high` reprovou sem aviso legível',
    );
    expect(out).toContain(
      'conferido: cópia única, versões do NOTICES (r7), check-licenses --require-destinations, eslint, prettier, typecheck\n',
    );
    expect(status).toBe(1);
  });

  test('erro de uso, de ambiente ou inesperado: saída 2, uma linha (pilha só com --verbose)', () => {
    const root = miniRepo();
    expect(fix(root, [...OFFLINE, '--sem-essa']).status).toBe(2);
    expect(fix(root, ['--no-verify']).status).toBe(2);
    const outside = fix(root, OFFLINE, { DEPS_FIX_PNPM: '', npm_execpath: '' });
    expect(outside.out).toContain('rode via `pnpm deps:fix`');
    expect(outside.calls).toEqual([]);
    expect(outside.status).toBe(2);
    writeFileSync(join(root, MARKDOWNLINT), '{');
    const broken = fix(root);
    expect(broken.out.trim().split('\n')).toHaveLength(1);
    expect(broken.out).toContain('deps:fix: erro inesperado');
    expect(broken.status).toBe(2);
    const verbose = fix(root, [...OFFLINE, '--verbose']);
    expect(verbose.out).toContain('    at ');
    expect(verbose.status).toBe(2);
    rmSync(join(root, 'pnpm-workspace.yaml'));
    expect(fix(root).status).toBe(2);
  });
});
