#!/usr/bin/env node
// Uma cópia de cada pacote do CodeMirror (r7 R-X7.10, AC-X7.8; arch-frontend r7 D-R7-F21). Roda
// dentro de `pnpm lint`. Falha (código 1) se o `pnpm-lock.yaml` tiver mais de uma instalação de algum
// `@codemirror/*` ou de `@lezer/common`, `@lezer/highlight`, `@lezer/lr` ou `@lezer/markdown`: outra
// versão OU a mesma versão com outros peers (`x@1.0.0(peerA)` e `x@1.0.0(peerB)` são duas pastas em
// `.pnpm`, duas instâncias do módulo; CR-S0-04). Uma segunda cópia quebra `instanceof`/facets do
// `@codemirror/state` e o `history()` do `@codemirror/commands` usado pelos plugins internos.
// Uso: `node scripts/check-single-codemirror.mjs [pnpm-lock.yaml]`.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

const lockfile = resolve(
  process.argv[2] ?? fileURLToPath(new URL('../pnpm-lock.yaml', import.meta.url)),
);
/** Nome do pacote vigiado no começo da chave `nome@versão(peers…)`. */
const SINGLE = /^(@codemirror\/[^@]+|@lezer\/(?:common|highlight|lr|markdown))@/;

/** Chaves completas por pacote, de `packages` (versões) e `snapshots` (versões + peers). */
const installs = new Map();
const add = (section, key) => {
  const name = SINGLE.exec(key)?.[1];
  if (!name) return;
  if (!installs.has(name)) installs.set(name, { packages: new Set(), snapshots: new Set() });
  installs.get(name)[section].add(key);
};
for (const doc of parseAllDocuments(readFileSync(lockfile, 'utf8'))) {
  if (doc.errors.length > 0) {
    console.error(`check-single-codemirror: ${lockfile} inválido: ${doc.errors[0].message}`);
    process.exit(1);
  }
  const data = doc.toJS() ?? {};
  for (const section of ['packages', 'snapshots'])
    for (const key of Object.keys(data[section] ?? {})) add(section, key);
}

const duplicated = [...installs]
  .map(([name, { packages, snapshots }]) => [name, packages.size > 1 ? packages : snapshots])
  .filter(([, keys]) => keys.size > 1);
if (duplicated.length > 0) {
  console.error(
    `check-single-codemirror: mais de uma cópia no lockfile (uma cópia de cada pacote, R-X7.10):\n${duplicated
      .map(([name, keys]) => `- ${name}: ${[...keys].sort().join(', ')}`)
      .join('\n')}`,
  );
  process.exit(1);
}
if (!installs.has('@codemirror/state')) {
  console.error(`check-single-codemirror: ${lockfile} não tem @codemirror/state.`);
  process.exit(1);
}
console.log(`check-single-codemirror: ${installs.size} pacotes, uma cópia de cada.`);
