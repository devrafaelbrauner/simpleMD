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
//   THIRD-PARTY-NOTICES.md não começar pelo cabeçalho L-3 exato da linha (origem, licença e autor):
//   `// Portado de <repo>@<commit> (<licença>), © <autor>. Modificado para o simpleMD.`;
// - com `--require-destinations`, algum destino declarado ainda não tiver arquivo (sem a opção, os
//   destinos pendentes são listados na saída, nunca em silêncio; CR-S0-06).
// Uso: `node scripts/check-licenses.mjs [raiz] [--licenses <saída do pnpm em JSON>]
//   [--require-destinations]`.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = args.indexOf('--licenses');
const licensesFile = flag >= 0 ? args[flag + 1] : undefined;
const requireDestinations = args.includes('--require-destinations');
const positional = args.filter(
  (arg, i) => i !== flag && i !== flag + 1 && arg !== '--require-destinations',
);
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
 * Exceções nominais (L-4), por nome@versão: outra versão volta a ser revisada. `reported` é a
 * licença como o pnpm a informa; `license` é a que vale (e a da linha no NOTICES).
 */
const EXCEPTIONS = {
  'elkjs@0.9.3': {
    reported: 'EPL-2.0',
    license: 'EPL-2.0',
    why: 'já em 52de38b: layout ELK do Mermaid 12.1.0 (dependência do mermaid, não nossa); EPL-2.0 é copyleft fraco por arquivo: usado sem modificação, o código-fonte é público e o restante do app não é afetado.',
  },
  'robust-predicates@3.0.3': {
    reported: 'Unlicense',
    license: 'Unlicense',
    why: 'já em 52de38b: predicados geométricos do d3-delaunay (via Mermaid); Unlicense é domínio público, sem obrigação de atribuição.',
  },
  'khroma@2.1.0': {
    reported: 'Unknown',
    license: 'MIT',
    why: 'já em 52de38b (via Mermaid): o package.json não tem o campo "license" e o arquivo se chama `license` em minúsculas; o pnpm o acha no macOS e no Windows (MIT) mas não no Linux (Unknown). Texto conferido: "The MIT License (MIT) Copyright (c) 2019-present Fabio Spampinato, Andrew Maney".',
  },
};

const FORBIDDEN = /\b(?:A|L)?GPL\b|\bSSPL\b/i;
const CODE = /\.(?:[cm]?js|tsx?)$/;

const problems = [];
const fail = (message) => problems.push(message);

/** O pnpm que roda este script (`pnpm lint`/`pnpm test`), sem shell; fora do pnpm, `pnpm` do PATH. */
function pnpmCommand() {
  const execpath = process.env.npm_execpath;
  if (!execpath || !process.env.npm_config_user_agent?.startsWith('pnpm/')) return ['pnpm', []];
  return /\.[cm]?js$/.test(execpath) ? [process.execPath, [execpath]] : [execpath, []];
}

/** `{ licença: [{ name, versions, author? }] }` do pnpm. */
function readLicenses() {
  if (licensesFile) return JSON.parse(readFileSync(resolve(licensesFile), 'utf8'));
  const [command, prefix] = pnpmCommand();
  const run = spawnSync(command, [...prefix, '-r', 'licenses', 'list', '--prod', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) {
    console.error(`pnpm licenses list falhou:\n${run.error ?? run.stderr}`);
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

/** Destino declarado: arquivo, pasta terminada em `/` (tudo dentro) ou um `*` no último nome. */
function destinationFiles(pattern) {
  if (pattern.endsWith('/')) {
    const dir = join(root, pattern);
    return existsSync(dir) ? walk(dir) : [];
  }
  const slash = pattern.lastIndexOf('/');
  const dir = join(root, pattern.slice(0, slash));
  const [before, after, extra] = pattern.slice(slash + 1).split('*');
  if (after === undefined) return existsSync(join(root, pattern)) ? [pattern] : [];
  if (extra !== undefined) {
    fail(`${NOTICES}: destino com mais de um "*": ${pattern}`);
    return [];
  }
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(
      (name) =>
        name.length >= before.length + after.length &&
        name.startsWith(before) &&
        name.endsWith(after),
    )
    .flatMap((name) =>
      statSync(join(dir, name)).isDirectory()
        ? walk(join(dir, name))
        : [`${pattern.slice(0, slash)}/${name}`],
    );
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
for (const [reported, packages] of Object.entries(readLicenses())) {
  for (const pkg of packages) {
    installed += 1;
    let license = reported;
    for (const version of pkg.versions) {
      const id = `${pkg.name}@${version}`;
      const exception = EXCEPTIONS[id];
      if (exception?.reported === reported) {
        license = exception.license;
        continue;
      }
      if (FORBIDDEN.test(reported))
        fail(`${id}: licença proibida em produção (${reported}; L-1/L-4).`);
      else if (!ALLOWED.has(reported))
        fail(
          `${id}: licença ausente, desconhecida ou fora da lista permitida (${reported || 'vazia'}).`,
        );
    }
    seen.add(`${pkg.name} ${license}`);
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
const pending = [];
for (const [patternCell, sourceCell, license, author] of tableRows(
  notices,
  'Destinos dos portes',
)) {
  const pattern = code(patternCell);
  const source = code(sourceCell);
  if (!pattern || !source || !author || !/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(source)) {
    fail(
      `${NOTICES}: linha de destino inválida: | ${patternCell} | ${sourceCell} | ${license} | ${author ?? ''} |`,
    );
    continue;
  }
  const header = `// Portado de ${source} (${license}), © ${author}. Modificado para o simpleMD.`;
  const files = destinationFiles(pattern).filter((f) => CODE.test(f));
  if (files.length === 0) pending.push(pattern);
  for (const file of files) {
    const lead = readFileSync(join(root, file), 'utf8').split(/\r?\n/);
    const end = lead.findIndex((line) => !line.startsWith('//'));
    const comments = end < 0 ? lead : lead.slice(0, end);
    if (!comments.includes(header)) fail(`${file}: falta o cabeçalho L-3 "${header}"`);
  }
}
if (requireDestinations)
  for (const pattern of pending)
    fail(
      `${pattern}: destino declarado no ${NOTICES} sem arquivo de código (porte ausente ou em outro caminho).`,
    );

if (problems.length > 0) {
  console.error(`check-licenses: ${problems.length} problema(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `check-licenses: ${installed} dependências de produção com licença permitida e entrada no ${NOTICES}.`,
);
if (pending.length > 0)
  console.log(
    `check-licenses: ${pending.length} destino(s) de porte ainda sem arquivo (cobrados com --require-destinations): ${pending.join(', ')}`,
  );
