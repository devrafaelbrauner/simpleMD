// r7 S0 (AC-X7.8, AC-X7.9; product r7 §7 L-2…L-4): os portões `scripts/check-licenses.mjs` e
// `scripts/check-single-version.mjs` (os dois dentro de `pnpm lint`) aprovam o repositório e
// reprovam cada regressão: licença proibida, ausente ou desconhecida, dependência sem entrada no
// THIRD-PARTY-NOTICES.md, entrada sobrando, exceção nominal com outra versão, arquivo portado sem
// o cabeçalho L-3 e lockfile com duas cópias de um pacote marcado (CodeMirror, katex, React). r23:
// o `--fix` do check-licenses escreve só linhas de licença aprovada, com células saneadas; versões
// vêm do lockfile e do `pnpm-workspace.yaml`, não de pinos aqui (só um piso de segurança).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const ROOT = join(__dirname, '../../..');
const LICENSES = join(ROOT, 'scripts/check-licenses.mjs');
const SINGLE = join(ROOT, 'scripts/check-single-version.mjs');
const NOTICES = 'THIRD-PARTY-NOTICES.md';

type Licenses = Record<
  string,
  Array<{ name: string; versions: string[]; author?: string; homepage?: string }>
>;

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
  options: {
    notices?: (text: string) => string;
    files?: Record<string, string>;
    args?: string[];
  } = {},
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
  return { ...run(LICENSES, root, '--licenses', json, ...(options.args ?? [])), root };
}

/** Acrescenta uma linha à tabela "Dependências npm de produção" (depois do separador). */
function addRow(notices: string, row: string): string {
  const header = notices.indexOf('\n| Pacote ');
  const separatorEnd = notices.indexOf('\n', notices.indexOf('\n', header + 1) + 1);
  return `${notices.slice(0, separatorEnd + 1)}${row}\n${notices.slice(separatorEnd + 1)}`;
}

/** Nomes da tabela "Dependências npm de produção", na ordem do arquivo. */
function productionNames(notices: string): string[] {
  const start = notices.indexOf('\n## Dependências npm de produção\n');
  const end = notices.indexOf('\n## ', start + 1);
  return [...notices.slice(start, end).matchAll(/^\| `([^`]+)`/gm)].map((m) => m[1] ?? '');
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

  test('a lista real cobre as dependências novas do r7, com lodash e katex corrigidos pelos overrides', () => {
    const ids = Object.values(real).flatMap((pkgs) =>
      pkgs.flatMap((p) => p.versions.map((v) => `${p.name}@${v}`)),
    );
    const names = new Set(Object.values(real).flatMap((pkgs) => pkgs.map((p) => p.name)));
    for (const name of [
      '@replit/codemirror-vim',
      'markdownlint',
      '@tgrosinger/md-advanced-tables',
      'dompurify',
      '@codemirror/search',
    ])
      expect(names).toContain(name);
    // As versões corrigidas são as dos overrides (o Dependabot e o `deps:fix` as movem), e as
    // vulneráveis continuam fora.
    const workspace = parse(readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')) as {
      overrides: Record<string, string>;
    };
    const lodash = workspace.overrides['@tgrosinger/md-advanced-tables>lodash'] ?? '';
    const katex = workspace.overrides['mermaid>katex'] ?? '';
    expect(ids).toContain(`lodash@${lodash}`);
    expect(ids).toContain(`katex@${katex}`);
    expect(ids).not.toContain('lodash@4.17.21');
    expect(ids).not.toContain('katex@0.16.47');
    // Piso de segurança: o override nunca desce para uma versão vulnerável (lodash 4.18.1, katex
    // 0.18.2), qualquer que seja (comparação numérica de x.y.z).
    const numeric = { numeric: true } as const;
    expect(lodash.localeCompare('4.18.1', undefined, numeric)).toBeGreaterThanOrEqual(0);
    expect(katex.localeCompare('0.18.2', undefined, numeric)).toBeGreaterThanOrEqual(0);
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

  test('r23 --fix escreve a linha que falta (licença permitida) na ordem alfabética, uma vez só', () => {
    const first = fixture(withPackage('MIT', 'prova-sem-entrada'), { args: ['--fix'] });
    expect(first.status).toBe(0);
    expect(first.out).toContain(
      'check-licenses: +1 linha(s) no THIRD-PARTY-NOTICES.md: prova-sem-entrada',
    );
    const fixed = readFileSync(join(first.root, NOTICES), 'utf8');
    expect(fixed).toContain('\n| `prova-sem-entrada` | MIT | Prova | — |\n');
    const names = productionNames(fixed);
    expect(names).toContain('prova-sem-entrada');
    expect(names).toEqual([...names].sort());
    const again = run(
      LICENSES,
      first.root,
      '--licenses',
      join(first.root, 'licenses.json'),
      '--fix',
    );
    expect(again.status).toBe(0);
    expect(again.out).not.toContain('linha(s) no');
    expect(readFileSync(join(first.root, NOTICES), 'utf8')).toBe(fixed);
  });

  test('r23 --fix nunca escreve licença proibida, desconhecida ou fora da lista', () => {
    const licenses = withPackage('GPL-3.0', 'prova-copyleft');
    licenses.WTFPL = [{ name: 'prova-sem-licenca', versions: ['1.0.0'], author: 'Prova' }];
    const { status, out, root } = fixture(licenses, { args: ['--fix'] });
    expect(status).toBe(1);
    expect(out).toContain('prova-copyleft@1.0.0: licença proibida em produção (GPL-3.0');
    expect(out).toContain('prova-sem-licenca@1.0.0: licença ausente, desconhecida ou fora');
    expect(out).toContain('prova-copyleft (GPL-3.0): dependência de produção sem entrada');
    expect(out).not.toContain('linha(s) no');
    expect(readFileSync(join(root, NOTICES), 'utf8')).toBe(
      readFileSync(join(ROOT, NOTICES), 'utf8'),
    );
  });

  test('r23 --fix: autor e página com quebra de linha ou `|` não criam linha nem coluna', () => {
    const licenses = structuredClone(real);
    licenses.MIT = [
      ...(licenses.MIT ?? []),
      {
        name: 'prova-celula',
        versions: ['1.0.0'],
        author: 'A | B\n| `falsa` | MIT | X | — |',
        homepage: 'https://x.test/a|b\r\n## Injetado',
      },
    ];
    const { status, root } = fixture(licenses, { args: ['--fix'] });
    expect(status).toBe(0);
    const fixed = readFileSync(join(root, NOTICES), 'utf8');
    const row =
      '| `prova-celula` | MIT | A / B / `falsa` / MIT / X / — / | https://x.test/a/b ## Injetado |';
    expect(fixed).toContain(`\n${row}\n`);
    expect(fixed.split('\n').length).toBe(
      readFileSync(join(ROOT, NOTICES), 'utf8').split('\n').length + 1,
    );
  });

  test('a tabela real está na ordem que o --fix mantém (code units)', () => {
    const names = productionNames(readFileSync(join(ROOT, NOTICES), 'utf8'));
    expect(names.length).toBeGreaterThan(100);
    expect(names).toEqual([...names].sort());
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

  test('khroma 2.1.0: "Unknown" do pnpm no Linux vale como MIT (exceção nominal); outra versão reprova', () => {
    const linux = structuredClone(real);
    for (const key of Object.keys(linux))
      linux[key] = linux[key]!.filter((p) => p.name !== 'khroma');
    linux.Unknown = [{ name: 'khroma', versions: ['2.1.0'], author: '' }];
    expect(fixture(linux).status).toBe(0);
    linux.Unknown = [{ name: 'khroma', versions: ['2.2.0'], author: '' }];
    const { status, out } = fixture(linux);
    expect(status).toBe(1);
    expect(out).toContain(
      'khroma@2.2.0: licença ausente, desconhecida ou fora da lista permitida (Unknown)',
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

    // CR-S0-06: o autor é o da linha do NOTICES, não qualquer texto depois de "©".
    const wrongAuthor = fixture(real, {
      files: {
        'packages/core/src/wikilinks/syntax.ts':
          header.replace('2022 Zef Hemel', 'Alguém') + 'x;\n',
      },
    });
    expect(wrongAuthor.status).toBe(1);
    expect(wrongAuthor.out).toContain(`syntax.ts: falta o cabeçalho L-3 "${header.trimEnd()}"`);
  });

  test('CR-S0-06: destinos sem arquivo são listados; com --require-destinations reprovam', () => {
    const listed = fixture(real);
    expect(listed.status).toBe(0);
    expect(listed.out).toContain('destino(s) de porte ainda sem arquivo');
    expect(listed.out).toContain('packages/core/src/wikilinks/syntax.ts');
    const strict = fixture(real, { args: ['--require-destinations'] });
    expect(strict.status).toBe(1);
    expect(strict.out).toContain(
      'packages/core/src/wikilinks/syntax.ts: destino declarado no THIRD-PARTY-NOTICES.md sem arquivo de código',
    );
  });
});

describe('check-single-version (AC-X7.8, D-R7-F21; R17-KATEX-GUARD, AC-R23-3)', () => {
  const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
  function withLock(text: string) {
    const dir = tempDir();
    writeFileSync(join(dir, 'pnpm-lock.yaml'), text);
    return run(SINGLE, join(dir, 'pnpm-lock.yaml'));
  }
  const yamlKey = (key: string) => (key.startsWith('@') ? `'${key}'` : key);
  /** Chave `nome@versão` de `name` na seção `packages` do lock (a primeira), sem pino aqui. */
  function current(name: string): string {
    const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const key = new RegExp(`\\n  '?(${escaped}@\\d[^(':\\n]*)'?:\\n`).exec(lock)?.[1];
    expect(key, `${name} no pnpm-lock.yaml`).toBeDefined();
    return key ?? '';
  }
  /** O lock com uma segunda cópia de `name` (0.0.0) na seção `packages`. */
  function withSecondCopy(name: string) {
    const present = `\n  ${yamlKey(current(name))}:\n`;
    return withLock(
      lock.replace(
        present,
        `\n  ${yamlKey(`${name}@0.0.0`)}:\n    resolution: {integrity: sha512-AAAA}\n${present}`,
      ),
    );
  }

  test('o lockfile do repositório tem uma cópia de cada pacote marcado (CodeMirror, Lezer do núcleo, katex, React)', () => {
    const { status, out } = run(SINGLE);
    expect(out).toMatch(/^check-single-version: \d+ pacotes, uma cópia de cada\./);
    expect(status).toBe(0);
  });

  test.each([
    '@codemirror/state',
    '@codemirror/commands',
    '@lezer/lr',
    'katex',
    'react',
    'react-dom',
  ])('segunda cópia de %s reprova', (name) => {
    const { status, out } = withSecondCopy(name);
    expect(status).toBe(1);
    expect(out).toContain(`- ${name}: ${name}@0.0.0, ${current(name)}`);
  });

  test('CR-S0-04: mesma versão com outros peers (duas pastas em .pnpm) reprova', () => {
    const lint = current('@codemirror/lint');
    const snapshot = `\n  '${lint}':\n`;
    const at = lock.lastIndexOf(snapshot);
    expect(at).toBeGreaterThan(lock.indexOf('\nsnapshots:'));
    const { status, out } = withLock(
      `${lock.slice(0, at)}\n  '${lint}(@codemirror/state@0.0.0)':\n    dependencies: {}\n${lock.slice(at)}`,
    );
    expect(status).toBe(1);
    expect(out).toContain(`- @codemirror/lint: ${lint}, ${lint}(@codemirror/state@0.0.0)`);
  });

  test('fora da lista, duas versões passam (@lezer/* fora do núcleo; micromark, R17-MICROMARK-DUP)', () => {
    for (const name of ['@lezer/css', 'micromark']) expect(withSecondCopy(name).status).toBe(0);
  });
});
