// r8 (R-R8-1, AC-R8-1.6/1.7/1.8): `scripts/gen-third-party-licenses.mjs`, que roda em todo `tauri
// build` e gera o THIRD-PARTY-LICENSES.txt do pacote, aprova uma árvore em que todo pacote tem texto
// de licença e reprova, listando o pacote, cada falha que deixaria o app sem atribuição: pacote sem
// texto e sem reserva, reserva de outra versão, reserva sem uso ou sem origem, crate com licença
// proibida ou sem licença, build sem alvo. Também confere a saída: fecho só por arestas normais,
// textos integrais (NOTICE incluído), entradas fixas, URL do código-fonte nas MPL-2.0, bytes iguais
// entre execuções e nenhum caminho absoluto. Usa listas de fixture (sem pnpm, cargo e rustc).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

const ROOT = join(__dirname, '../../..');
const SCRIPT = join(ROOT, 'scripts/gen-third-party-licenses.mjs');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

type NpmPackage = { name: string; version: string; license: string; files: Record<string, string> };
type Crate = {
  name: string;
  license?: string;
  files: Record<string, string>;
  kind?: 'build' | null;
  procMacro?: boolean;
};
type Reserve = Record<
  string,
  { license: string; note: string; files: Array<Record<string, string>> }
>;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function writeFiles(dir: string, files: Record<string, string>) {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}

const NPM: NpmPackage[] = [
  {
    name: 'pkg-a',
    version: '1.0.0',
    license: 'MIT',
    files: { LICENSE: 'MIT License\r\nCopyright (c) Prova A\r\n', 'license-update.mjs': 'x' },
  },
  {
    name: 'pkg-mpl',
    version: '2.0.0',
    license: '(MPL-2.0 OR Apache-2.0)',
    files: { LICENSE: 'Texto MPL do pkg-mpl\n' },
  },
];
const CRATES: Crate[] = [
  {
    name: 'crate-c',
    license: 'MIT OR Apache-2.0',
    files: { 'LICENSE-MIT': 'Copyright (c) Prova C\n', NOTICE: 'Aviso NOTICE da prova C\n' },
  },
  { name: 'crate-macro', license: 'MIT', files: { LICENSE: 'Prova macro\n' }, procMacro: true },
  { name: 'crate-build', license: 'MIT', files: { LICENSE: 'Prova build\n' }, kind: 'build' },
];

/** Gera numa raiz de fixture (pacotes, metadados do cargo, reserva e sysroot) e roda o gerador. */
function generate(
  options: { npm?: NpmPackage[]; crates?: Crate[]; reserve?: Reserve; target?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'smd-third-party-'));
  dirs.push(dir);
  const licenses: Record<string, Array<Record<string, unknown>>> = {};
  for (const pkg of options.npm ?? NPM) {
    const path = join(dir, 'npm', pkg.name);
    writeFiles(path, { 'package.json': '{}', ...pkg.files });
    (licenses[pkg.license] ??= []).push({
      name: pkg.name,
      versions: [pkg.version],
      paths: [path],
      license: pkg.license,
      author: 'Autora Prova',
      homepage: `https://example.org/${pkg.name}`,
    });
  }
  const crates = options.crates ?? CRATES;
  for (const crate of crates) writeFiles(join(dir, 'crates', crate.name), crate.files);
  const id = (name: string) => `${name} 1.0.0`;
  const metadata = {
    packages: crates.map((crate) => ({
      id: id(crate.name),
      name: crate.name,
      version: '1.0.0',
      license: crate.license ?? null,
      license_file: null,
      authors: ['Autor Prova'],
      repository: `https://example.org/${crate.name}`,
      manifest_path: join(dir, 'crates', crate.name, 'Cargo.toml'),
      targets: [{ kind: crate.procMacro ? ['proc-macro'] : ['lib'] }],
    })),
    resolve: {
      root: 'simplemd 0.1.1',
      nodes: [
        {
          id: 'simplemd 0.1.1',
          deps: crates.map((crate) => ({
            pkg: id(crate.name),
            dep_kinds: [{ kind: crate.kind ?? null }],
          })),
        },
        ...crates.map((crate) => ({ id: id(crate.name), deps: [] })),
      ],
    },
  };
  writeFiles(join(dir, 'sysroot/share/doc/rust/licenses'), {
    'MIT.txt': 'MIT do sysroot\n',
    'Apache-2.0.txt': 'Apache do sysroot\n',
  });
  writeFiles(dir, {
    'licenses.json': JSON.stringify(licenses),
    'metadata.json': JSON.stringify(metadata),
    'reserve.json': JSON.stringify({ packages: options.reserve ?? {} }),
  });
  const out = join(dir, 'out/THIRD-PARTY-LICENSES.txt');
  const env = { ...process.env };
  delete env.TAURI_ENV_TARGET_TRIPLE;
  const args = [
    SCRIPT,
    ...(options.target === '' ? [] : ['--target', options.target ?? 'aarch64-apple-darwin']),
    '--out',
    out,
    '--licenses',
    join(dir, 'licenses.json'),
    '--metadata',
    join(dir, 'metadata.json'),
    '--reserve',
    join(dir, 'reserve.json'),
    '--rust-sysroot',
    join(dir, 'sysroot'),
  ];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env });
  return {
    dir,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    text: existsSync(out) ? readFileSync(out, 'utf8') : undefined,
  };
}

const reserveFor = (text: string, extra: Record<string, string> = {}) => ({
  license: 'MIT',
  note: 'Nota da prova',
  files: [{ source: 'https://example.org/up', commit: COMMIT, path: 'LICENSE', text, ...extra }],
});
const noFile = (name: string): NpmPackage => ({
  name,
  version: '1.0.0',
  license: 'MIT',
  files: { 'README.md': '# Licença MIT\n' },
});

describe('gen-third-party-licenses (AC-R8-1.6)', () => {
  test('aprova a árvore com texto de licença em todo pacote e escreve cada entrada', () => {
    const r = generate();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'alvo aarch64-apple-darwin; npm 2, crates 2 (proc-macro 1), fixos 6',
    );
    const text = r.text ?? '';
    expect(text).toContain(
      '## npm pkg-a 1.0.0\n- Licença: MIT\n- Origem: https://example.org/pkg-a\n- Autores: Autora Prova\n\n### LICENSE\nMIT License\nCopyright (c) Prova A\n',
    );
    expect(text).not.toContain('\r');
    expect(text).not.toContain('license-update.mjs');
    expect(text).toContain('### LICENSE-MIT\nCopyright (c) Prova C\n');
    expect(text).toContain('### NOTICE\nAviso NOTICE da prova C\n');
    expect(text).toContain('## crate crate-macro 1.0.0');
    expect(text).not.toContain('crate-build');
  });

  test('pacote sem texto de licença e sem reserva reprova o build listando name@version', () => {
    const r = generate({
      npm: [...NPM, noFile('pkg-b')],
      crates: [...CRATES, { name: 'crate-sem-texto', license: 'MIT', files: {} }],
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('- npm pkg-b@1.0.0 (MIT): sem arquivo de licença e sem reserva');
    expect(r.stderr).toContain(
      '- crate crate-sem-texto@1.0.0 (MIT): sem arquivo de licença e sem reserva',
    );
    expect(r.text).toBeUndefined();
  });

  test('a reserva com o name@version exato entra no arquivo com a origem', () => {
    const r = generate({
      npm: [...NPM, noFile('pkg-b')],
      reserve: { 'pkg-b@1.0.0': reserveFor('Copyright (c) Upstream B\n') },
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.text).toContain(
      `### LICENSE (https://example.org/up, commit ${COMMIT})\nCopyright (c) Upstream B\n`,
    );
    expect(r.text).toContain('- Nota: o pacote não traz arquivo de licença; texto da reserva');
  });

  test('a reserva de outra versão não vale: o pacote e a reserva sobrando reprovam', () => {
    const r = generate({
      npm: [...NPM, noFile('pkg-b')],
      reserve: { 'pkg-b@1.0.1': reserveFor('Copyright (c) Upstream B\n') },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('- npm pkg-b@1.0.0 (MIT): sem arquivo de licença e sem reserva');
    expect(r.stderr).toContain(
      '- reserva pkg-b@1.0.1: nenhum pacote com esse nome@versão (npm de produção ou Cargo.lock)',
    );
  });

  test.each<{ name: string; npm?: NpmPackage[]; reserve: Reserve; message: string }>([
    {
      name: 'reserva para pacote que já traz o arquivo',
      reserve: { 'pkg-a@1.0.0': reserveFor('x\n') },
      message: '- reserva pkg-a@1.0.0: o pacote já traz arquivo de licença; tire a entrada',
    },
    {
      name: 'reserva sem commit de origem',
      npm: [...NPM, noFile('pkg-b')],
      reserve: { 'pkg-b@1.0.0': reserveFor('x\n', { commit: 'main' }) },
      message: '- reserva pkg-b@1.0.0: arquivo sem source, commit de 40 hex, path ou text',
    },
  ])('reprova: $name', ({ npm, reserve, message }) => {
    const r = generate({ npm, reserve });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });

  test.each([
    { license: 'GPL-3.0-only', message: '- crate crate-x@1.0.0: licença proibida (GPL-3.0-only)' },
    { license: 'MIT OR LGPL-2.1', message: '- crate crate-x@1.0.0: licença proibida' },
    { license: undefined, message: '- crate crate-x@1.0.0: sem expressão de licença' },
  ])('reprova crate com licença $license (R-R8-1.4)', ({ license, message }) => {
    const crate: Crate = { name: 'crate-x', files: { LICENSE: 'x\n' } };
    if (license) crate.license = license;
    const r = generate({ crates: [...CRATES, crate] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });

  test('sem alvo (TAURI_ENV_TARGET_TRIPLE nem --target) reprova em vez de adivinhar', () => {
    const r = generate({ target: '' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('gen-third-party-licenses: sem alvo');
  });
});

describe('gen-third-party-licenses — saída (AC-R8-1.7, AC-R8-1.8, R-R8-1.2)', () => {
  test('MPL-2.0 traz a URL do código-fonte (npm e crate da reserva)', () => {
    const r = generate({
      crates: [...CRATES, { name: 'crate-mpl', license: 'MPL-2.0', files: {} }],
      reserve: { 'crate-mpl@1.0.0': reserveFor('Mozilla Public License Version 2.0\n') },
    });
    expect(r.status).toBe(0);
    expect(r.text).toContain(
      '- Código-fonte (MPL-2.0): https://registry.npmjs.org/pkg-mpl/-/pkg-mpl-2.0.0.tgz\n',
    );
    expect(r.text).toContain(
      '## crate crate-mpl 1.0.0\n- Licença: MPL-2.0\n- Origem: https://example.org/crate-mpl\n- Autores: Autor Prova\n- Código-fonte (MPL-2.0): https://static.crates.io/crates/crate-mpl/crate-mpl-1.0.0.crate\n',
    );
  });

  test('entradas fixas: Rust std, Vite/Rolldown e as 3 fontes com o OFL.txt do repositório', () => {
    const r = generate();
    const text = r.text ?? '';
    const channel = /^channel = "([^"]+)"/m.exec(
      readFileSync(join(ROOT, 'rust-toolchain.toml'), 'utf8'),
    )?.[1];
    expect(text).toContain(`## fixo rust-std ${channel}\n- Licença: MIT OR Apache-2.0\n`);
    expect(text).toContain('### share/doc/rust/licenses/MIT.txt\nMIT do sysroot\n');
    expect(text).toContain('### share/doc/rust/licenses/Apache-2.0.txt\nApache do sysroot\n');
    expect(text).toMatch(/^## fixo vite \d+\.\d+\.\d+\n- Licença: MIT\n/m);
    expect(text).toMatch(/^## fixo rolldown \d+\.\d+\.\d+/m);
    for (const font of ['cascadia-code', 'fira-code', 'jetbrains-mono']) {
      const ofl = readFileSync(
        join(ROOT, 'packages/themes/src/fonts', font, 'OFL.txt'),
        'utf8',
      ).replace(/\r\n/g, '\n');
      expect(text).toMatch(new RegExp(`^## fixo ${font} `, 'm'));
      expect(text).toContain(`### OFL.txt\n${ofl}`);
    }
  });

  test('mesmas entradas em outra ordem dão os mesmos bytes, sem caminho absoluto', () => {
    const first = generate();
    const second = generate({ npm: [...NPM].reverse(), crates: [...CRATES].reverse() });
    expect(first.status).toBe(0);
    expect(second.text).toBe(first.text);
    for (const path of [first.dir, ROOT, homedir(), tmpdir()])
      expect(first.text).not.toContain(path);
  });
});
