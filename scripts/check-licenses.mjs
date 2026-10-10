#!/usr/bin/env node
// Portão de licenças do r7 (product r7 §7, L-2…L-4; AC-X7.9). Roda dentro de `pnpm lint`. Falha
// (código 1) se:
// - alguma dependência de produção (`pnpm -r licenses list --prod --json`) tiver licença GPL,
//   AGPL, LGPL ou SSPL (em qualquer forma), licença ausente/desconhecida, ou licença fora da lista
//   permitida e das exceções nominais abaixo (cada uma com justificativa);
// - algum par pacote/licença da árvore de produção não tiver linha na tabela "Dependências npm de
//   produção" do THIRD-PARTY-NOTICES.md (um pacote pode aparecer com duas licenças, uma por
//   versão), ou a tabela tiver linha que não está mais na árvore de produção (o arquivo continua
//   fiel ao lockfile);
// - algum arquivo de código dentro de um destino declarado na tabela "Destinos dos portes" do
//   THIRD-PARTY-NOTICES.md não começar pelo cabeçalho L-3 da origem declarada:
//   `// Portado de <repo>@<commit> (<licença>), © <autor>. Modificado para o simpleMD.`
// Uso: `node scripts/check-licenses.mjs [raiz] [--licenses <saída do pnpm em JSON>]`.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = args.indexOf('--licenses');
const licensesFile = flag >= 0 ? args[flag + 1] : undefined;
const positional = args.filter((_, i) => i !== flag && i !== flag + 1);
const root = resolve(positional[0] ?? fileURLToPath(new URL('..', import.meta.url)));
const NOTICES = 'THIRD-PARTY-NOTICES.md';

/** Licenças aceitas em produção (L-4), exatamente como o pnpm as informa. */
const ALLOWED = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
  'Apache-2.0 OR MIT',
  '(MPL-2.0 OR Apache-2.0)',
  'Unlicense',
]);

/**
 * Exceções nominais já presentes em `52de38b` (L-4), por nome@versão: outra versão volta a ser
 * revisada.
 */
const EXCEPTIONS = {
  'elkjs@0.9.3': {
    license: 'EPL-2.0',
    why: 'layout ELK do Mermaid 12.1.0 (dependência do mermaid, não nossa); EPL-2.0 é copyleft fraco por arquivo: usado sem modificação, o código-fonte é público e o restante do app não é afetado.',
  },
  'robust-predicates@3.0.3': {
    license: 'Unlicense',
    why: 'predicados geométricos do d3-delaunay (via Mermaid); Unlicense é domínio público, sem obrigação de atribuição.',
  },
};

const FORBIDDEN = /\b(?:A|L)?GPL\b|\bSSPL\b/i;
const CODE = /\.(?:[cm]?js|tsx?)$/;

const problems = [];
const fail = (message) => problems.push(message);

/** `{ licença: [{ name, versions, author? }] }` do pnpm. */
function readLicenses() {
  if (licensesFile) return JSON.parse(readFileSync(resolve(licensesFile), 'utf8'));
  const run = spawnSync('pnpm', ['-r', 'licenses', 'list', '--prod', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  if (run.status !== 0) {
    console.error(`pnpm licenses list falhou:\n${run.stderr}`);
    process.exit(1);
  }
  return JSON.parse(run.stdout);
}

/** Linhas `| … |` da tabela logo abaixo do título `## <heading>` (sem cabeçalho e separador). */
function tableRows(text, heading) {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) {
    fail(`${NOTICES}: falta a seção "## ${heading}".`);
    return [];
  }
  const end = text.indexOf('\n## ', start + 1);
  const section = text.slice(start, end < 0 ? text.length : end);
  return section
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .slice(1)
    .map((line) =>
      line
        .slice(1, line.endsWith('|') ? -1 : undefined)
        .split('|')
        .map((cell) => cell.trim()),
    );
}

const code = (cell) => /^`([^`]+)`$/.exec(cell)?.[1];

/** Arquivos (relativos, com `/`) sob `dir`, sem `node_modules`. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(relative(root, path).split(sep).join('/'));
  }
  return out;
}

/** Destino declarado: arquivo, pasta terminada em `/` (tudo dentro) ou `*` no último nome. */
function destinationFiles(pattern) {
  if (pattern.endsWith('/')) {
    const dir = join(root, pattern);
    return existsSync(dir) ? walk(dir) : [];
  }
  const slash = pattern.lastIndexOf('/');
  const dir = join(root, pattern.slice(0, slash));
  const last = pattern.slice(slash + 1);
  if (!last.includes('*')) return existsSync(join(root, pattern)) ? [pattern] : [];
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^${last.split('*').map(escape).join('[^/]*')}$`);
  return readdirSync(dir)
    .filter((name) => re.test(name))
    .flatMap((name) =>
      statSync(join(dir, name)).isDirectory()
        ? walk(join(dir, name))
        : [`${pattern.slice(0, slash)}/${name}`],
    );
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

const noticesPath = join(root, NOTICES);
if (!existsSync(noticesPath)) {
  console.error(`check-licenses: ${NOTICES} não existe (L-2).`);
  process.exit(1);
}
const notices = readFileSync(noticesPath, 'utf8');

// 1–2. Licenças da árvore de produção e entradas do NOTICES (chave: pacote + licença).
const declared = new Set();
for (const [nameCell, license] of tableRows(notices, 'Dependências npm de produção')) {
  const name = code(nameCell);
  if (name) declared.add(`${name} ${license}`);
  else fail(`${NOTICES}: linha de dependência sem \`nome\`: | ${nameCell} | ${license} |`);
}
const seen = new Set();
let installed = 0;
for (const [license, packages] of Object.entries(readLicenses())) {
  for (const pkg of packages) {
    installed += 1;
    seen.add(`${pkg.name} ${license}`);
    for (const version of pkg.versions) {
      const id = `${pkg.name}@${version}`;
      if (EXCEPTIONS[id]?.license === license) continue;
      if (FORBIDDEN.test(license))
        fail(`${id}: licença proibida em produção (${license}; L-1/L-4).`);
      else if (!ALLOWED.has(license))
        fail(
          `${id}: licença ausente, desconhecida ou fora da lista permitida (${license || 'vazia'}).`,
        );
    }
    if (!declared.has(`${pkg.name} ${license}`)) {
      const author = (pkg.author || '—').replace(/\|/g, '/');
      fail(
        `${pkg.name} (${license}): dependência de produção sem entrada no ${NOTICES} (L-2). Linha: | \`${pkg.name}\` | ${license} | ${author} | ${pkg.homepage ?? '—'} |`,
      );
    }
  }
}
for (const entry of declared)
  if (!seen.has(entry))
    fail(
      `${entry.replace(' ', ' (')}): está no ${NOTICES} mas não é mais dependência de produção; remova a linha.`,
    );

// 3. Cabeçalho L-3 nos destinos dos portes.
for (const [patternCell, sourceCell, license] of tableRows(notices, 'Destinos dos portes')) {
  const pattern = code(patternCell);
  const source = code(sourceCell);
  if (!pattern || !source || !/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(source)) {
    fail(`${NOTICES}: linha de destino inválida: | ${patternCell} | ${sourceCell} | ${license} |`);
    continue;
  }
  const header = new RegExp(
    `^// Portado de ${escape(source)} \\(${escape(license)}\\), © .+\\. Modificado para o simpleMD\\.$`,
  );
  for (const file of destinationFiles(pattern).filter((f) => CODE.test(f))) {
    const lead = readFileSync(join(root, file), 'utf8').split(/\r?\n/);
    const end = lead.findIndex((line) => !line.startsWith('//'));
    const comments = end < 0 ? lead : lead.slice(0, end);
    if (!comments.some((line) => header.test(line)))
      fail(
        `${file}: falta o cabeçalho L-3 "// Portado de ${source} (${license}), © <autor>. Modificado para o simpleMD."`,
      );
  }
}

if (problems.length > 0) {
  console.error(`check-licenses: ${problems.length} problema(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `check-licenses: ${installed} dependências de produção com licença permitida e entrada no ${NOTICES}.`,
);
