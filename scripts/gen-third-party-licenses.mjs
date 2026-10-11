#!/usr/bin/env node
// Atribuição de terceiros que vai dentro do app (r8, R-R8-1; CR-S0-03 e CR-S0-12). Roda em todo
// `tauri build` (`build.beforeBuildCommand`, depois do `build:vite`) e escreve um
// `THIRD-PARTY-LICENSES.txt` UTF-8 para o triplo-alvo do build, com:
// - npm: todo `name@version` de `pnpm -r licenses list --prod --json --long`;
// - crates: fecho só pelas arestas `normal` (proc-macros incluídos) a partir do pacote raiz em
//   `cargo metadata --locked --filter-platform <alvo>` (D-R8-S01); o cargo baixa o que faltar,
//   conferido pelo Cargo.lock;
// - fixos (D-R8-S09): biblioteca padrão do Rust, runtime que o Vite/Rolldown injeta no `dist` e as
//   3 fontes OFL embutidas.
// Cada entrada traz a licença declarada, a origem, os autores declarados e o texto integral de
// todo arquivo LICENSE*/LICENCE*/COPYING*/UNLICENSE*/NOTICE* do pacote (CRLF vira LF); nas
// entradas MPL-2.0, a URL do código-fonte. Sem data e sem caminho absoluto: as mesmas entradas
// dão os mesmos bytes.
// Falha (código 1), listando cada pacote, se:
// - um pacote não tiver texto de licença nem reserva nominal `name@version` no RESERVE;
// - uma reserva não casar com pacote nenhum (npm de produção ou Cargo.lock), sobrar para um pacote
//   que já traz o arquivo, ou não trouxer a origem (URL, commit de 40 hex, caminho e texto);
// - um crate tiver licença proibida (L-4) ou não declarar licença (R-R8-1.4).
// Uso: `node scripts/gen-third-party-licenses.mjs [raiz] [--target <triplo>] [--out <arquivo>]
//   [--licenses <json do pnpm>] [--metadata <json do cargo>] [--reserve <json>]
//   [--rust-sysroot <pasta>]`. Sem `--target`, vale `TAURI_ENV_TARGET_TRIPLE` (o CLI do Tauri a
//   exporta para o gancho). As quatro últimas opções são dos testes (sem pnpm, cargo e rustc).
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    target: { type: 'string' },
    out: { type: 'string' },
    licenses: { type: 'string' },
    metadata: { type: 'string' },
    reserve: { type: 'string' },
    'rust-sysroot': { type: 'string' },
  },
});
const root = resolve(positionals[0] ?? fileURLToPath(new URL('..', import.meta.url)));
const target = options.target ?? process.env.TAURI_ENV_TARGET_TRIPLE;
if (!target) {
  console.error(
    'gen-third-party-licenses: sem alvo (TAURI_ENV_TARGET_TRIPLE ausente; use --target <triplo>).',
  );
  process.exit(1);
}
const out = resolve(options.out ?? join(root, 'build/third-party/THIRD-PARTY-LICENSES.txt'));
const RESERVE = 'scripts/third-party-licenses-reserve.json';
const TAURI = join(root, 'apps/desktop/src-tauri');
const FORBIDDEN = /\b(?:A|L)?GPL\b|\bSSPL\b/i;
const LICENSE_FILE = /^(?:licen[cs]e|copying|unlicense|notice)(?:[-._].*)?$/i;
const CODE = /\.(?:[cm]?[jt]sx?|json|map|rs)$/i;

const problems = [];

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    console.error(
      `gen-third-party-licenses: ${[command, ...args].join(' ')} falhou:\n${result.error ?? result.stderr}`,
    );
    process.exit(1);
  }
  return result.stdout;
}

/** O pnpm que roda este script (`pnpm … tauri build`), sem shell; fora do pnpm, `pnpm` do PATH. */
function pnpmCommand() {
  const execpath = process.env.npm_execpath;
  if (!execpath || !process.env.npm_config_user_agent?.startsWith('pnpm/')) return ['pnpm', []];
  return /\.[cm]?js$/.test(execpath) ? [process.execPath, [execpath]] : [execpath, []];
}

const text = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/** Arquivos de licença no topo de `dir` (mais o `license-file` do Cargo), em ordem fixa. */
function licenseFiles(dir, licenseFile) {
  const names = readdirSync(dir).filter(
    (name) => LICENSE_FILE.test(name) && !CODE.test(name) && statSync(join(dir, name)).isFile(),
  );
  if (licenseFile && !names.includes(licenseFile)) names.push(licenseFile);
  return names.sort().map((name) => ({ name, text: text(join(dir, name)) }));
}

const authorName = (author) => (typeof author === 'object' ? author?.name : author);
const entries = [];

// ---- npm de produção ----
const npm = options.licenses
  ? JSON.parse(readFileSync(resolve(options.licenses), 'utf8'))
  : (() => {
      const [command, prefix] = pnpmCommand();
      return JSON.parse(
        run(command, [...prefix, '-r', 'licenses', 'list', '--prod', '--json', '--long']),
      );
    })();
for (const [license, packages] of Object.entries(npm))
  for (const pkg of packages)
    pkg.versions.forEach((version, i) =>
      entries.push({
        eco: 'npm',
        name: pkg.name,
        version,
        license,
        origin: pkg.homepage,
        authors: authorName(pkg.author),
        source: /MPL/.test(license)
          ? `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split('/').pop()}-${version}.tgz`
          : undefined,
        files: licenseFiles(pkg.paths[i]),
      }),
    );

// ---- crates ligados ao binário do alvo ----
const metadata = JSON.parse(
  options.metadata
    ? readFileSync(resolve(options.metadata), 'utf8')
    : run('cargo', [
        'metadata',
        '--locked',
        '--format-version',
        '1',
        '--filter-platform',
        target,
        '--manifest-path',
        join(TAURI, 'Cargo.toml'),
      ]),
);
const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
const linked = new Set([metadata.resolve.root]);
for (const id of linked)
  for (const dep of nodes.get(id).deps)
    if (dep.dep_kinds.some((kind) => kind.kind === null)) linked.add(dep.pkg);
linked.delete(metadata.resolve.root);
let procMacros = 0;
for (const p of metadata.packages) {
  if (!linked.has(p.id)) continue;
  const id = `${p.name}@${p.version}`;
  if (!p.license) problems.push(`crate ${id}: sem expressão de licença (campo license)`);
  else if (FORBIDDEN.test(p.license)) problems.push(`crate ${id}: licença proibida (${p.license})`);
  if (p.targets.some((t) => t.kind.includes('proc-macro'))) procMacros += 1;
  entries.push({
    eco: 'crate',
    name: p.name,
    version: p.version,
    license: p.license ?? 'não declarada',
    origin: p.repository ?? p.homepage,
    authors: p.authors.join(', '),
    source: /MPL/.test(p.license ?? '')
      ? `https://static.crates.io/crates/${p.name}/${p.name}-${p.version}.crate`
      : undefined,
    files: licenseFiles(dirname(p.manifest_path), p.license_file?.replaceAll('\\', '/')),
  });
}

// ---- fixos (D-R8-S09) ----
const toolchain = /^channel\s*=\s*"([^"]+)"/m.exec(text(join(root, 'rust-toolchain.toml')))[1];
let sysroot = options['rust-sysroot'];
if (!sysroot) {
  const release = /^release: (.+)$/m.exec(run('rustc', ['-vV']))[1];
  if (release !== toolchain)
    problems.push(`rust-std: rustc ${release} diferente do rust-toolchain.toml (${toolchain})`);
  sysroot = run('rustc', ['--print', 'sysroot']).trim();
}
entries.push({
  eco: 'fixo',
  name: 'rust-std',
  version: toolchain,
  license: 'MIT OR Apache-2.0',
  origin: 'https://github.com/rust-lang/rust',
  authors: 'The Rust Project Developers (https://thanks.rust-lang.org)',
  note: 'biblioteca padrão do Rust, ligada estaticamente ao binário; textos do sysroot do toolchain',
  files: ['Apache-2.0.txt', 'MIT.txt'].map((name) => ({
    name: `share/doc/rust/licenses/${name}`,
    text: text(join(sysroot, 'share/doc/rust/licenses', name)),
  })),
});
const vite = realpathSync(join(root, 'apps/desktop/node_modules/vite'));
for (const dir of [vite, join(dirname(vite), 'rolldown')]) {
  const pkg = JSON.parse(text(join(dir, 'package.json')));
  entries.push({
    eco: 'fixo',
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    origin: pkg.homepage,
    authors: authorName(pkg.author),
    note: 'código de runtime que o Vite/Rolldown injeta no dist do app',
    files: licenseFiles(dir),
  });
}
const FONTS = 'packages/themes/src/fonts';
for (const name of readdirSync(join(root, FONTS)).sort()) {
  const source = text(join(root, FONTS, name, 'SOURCE.md'));
  entries.push({
    eco: 'fixo',
    name,
    version: /^- Versão: (\S+)/m.exec(source)[1],
    license: 'OFL-1.1',
    origin: /^- Projeto: <([^>]+)>/m.exec(source)[1],
    note: `fonte embutida no app (${FONTS}/${name})`,
    files: [{ name: 'OFL.txt', text: text(join(root, FONTS, name, 'OFL.txt')) }],
  });
}

// ---- reserva nominal (R-R8-1.3, D-R8-S02) ----
const reserve = JSON.parse(
  readFileSync(options.reserve ? resolve(options.reserve) : join(root, RESERVE), 'utf8'),
).packages;
for (const entry of entries) {
  const id = `${entry.name}@${entry.version}`;
  const fallback = Object.hasOwn(reserve, id) ? reserve[id] : undefined;
  if (entry.files.length > 0) {
    if (fallback)
      problems.push(`reserva ${id}: o pacote já traz arquivo de licença; tire a entrada`);
  } else if (!fallback) {
    problems.push(`${entry.eco} ${id} (${entry.license}): sem arquivo de licença e sem reserva`);
  } else {
    entry.note = `o pacote não traz arquivo de licença; texto da reserva (licença eleita: ${fallback.license}). ${fallback.note}`;
    entry.files = fallback.files.map((file) => ({
      name: `${file.path} (${file.source}${file.tag ? `, tag ${file.tag}` : ''}, commit ${file.commit})`,
      text: file.text,
    }));
  }
}
const lock = text(join(TAURI, 'Cargo.lock'));
const known = new Set([
  ...entries.map((entry) => `${entry.name}@${entry.version}`),
  ...[...lock.matchAll(/^name = "([^"]+)"\nversion = "([^"]+)"$/gm)].map(([, n, v]) => `${n}@${v}`),
]);
for (const [id, fallback] of Object.entries(reserve)) {
  if (!known.has(id))
    problems.push(
      `reserva ${id}: nenhum pacote com esse nome@versão (npm de produção ou Cargo.lock)`,
    );
  for (const file of fallback.files)
    if (!file.source || !/^[0-9a-f]{40}$/.test(file.commit) || !file.path || !file.text)
      problems.push(`reserva ${id}: arquivo sem source, commit de 40 hex, path ou text`);
}

if (problems.length > 0) {
  console.error(
    `gen-third-party-licenses: ${problems.length} problema(s) (reserva: ${RESERVE}):\n- ${problems.join('\n- ')}`,
  );
  process.exit(1);
}

// ---- saída ----
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
entries.sort((a, b) => order(a.eco, b.eco) || order(a.name, b.name) || order(a.version, b.version));
const count = (eco) => entries.filter((entry) => entry.eco === eco).length;
const chunks = [
  'simpleMD — licenças de terceiros\n\n',
  `Alvo: ${target}\n`,
  `npm de produção: ${count('npm')}; crates Rust ligados ao binário: ${count('crate')}; componentes fixos: ${count('fixo')}\n`,
  'Cada entrada traz a licença declarada, a origem, os autores declarados e o texto integral dos arquivos de licença e NOTICE do pacote. Gerado no build por scripts/gen-third-party-licenses.mjs; os avisos do código portado estão no THIRD-PARTY-NOTICES.md.\n',
];
for (const entry of entries) {
  chunks.push(
    `\n## ${entry.eco} ${entry.name} ${entry.version}\n`,
    `- Licença: ${entry.license}\n`,
    `- Origem: ${entry.origin ?? 'não declarada'}\n`,
    `- Autores: ${entry.authors || 'não declarado'}\n`,
  );
  if (entry.source) chunks.push(`- Código-fonte (MPL-2.0): ${entry.source}\n`);
  if (entry.note) chunks.push(`- Nota: ${entry.note}\n`);
  for (const file of entry.files)
    chunks.push(`\n### ${file.name}\n`, file.text, file.text.endsWith('\n') ? '' : '\n');
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, chunks.join(''));
console.log(
  `gen-third-party-licenses: alvo ${target}; npm ${count('npm')}, crates ${count('crate')} (proc-macro ${procMacros}), fixos ${count('fixo')} → ${relative(root, out)} (${statSync(out).size} bytes)`,
);
