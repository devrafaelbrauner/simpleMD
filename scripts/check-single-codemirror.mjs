#!/usr/bin/env node
// Uma cópia de cada pacote do CodeMirror (r7 R-X7.10, AC-X7.8; arch-frontend r7 D-R7-F21). Roda
// dentro de `pnpm lint`. Falha (código 1) se o `pnpm-lock.yaml` resolver mais de uma versão de algum
// `@codemirror/*` ou de `@lezer/common`, `@lezer/highlight`, `@lezer/lr` ou `@lezer/markdown`: uma
// segunda cópia quebra `instanceof`/facets do `@codemirror/state` e o `history()` do
// `@codemirror/commands` usado pelos plugins internos.
// Uso: `node scripts/check-single-codemirror.mjs [pnpm-lock.yaml]`.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

const lockfile = resolve(
  process.argv[2] ?? fileURLToPath(new URL('../pnpm-lock.yaml', import.meta.url)),
);
const SINGLE = /^(@codemirror\/[^@]+|@lezer\/(?:common|highlight|lr|markdown))@([^(]+)/;

const versions = new Map();
for (const doc of parseAllDocuments(readFileSync(lockfile, 'utf8'))) {
  if (doc.errors.length > 0) {
    console.error(`check-single-codemirror: ${lockfile} inválido: ${doc.errors[0].message}`);
    process.exit(1);
  }
  const data = doc.toJS() ?? {};
  for (const section of ['packages', 'snapshots']) {
    for (const key of Object.keys(data[section] ?? {})) {
      const match = SINGLE.exec(key);
      if (!match) continue;
      const [, name, version] = match;
      if (!versions.has(name)) versions.set(name, new Set());
      versions.get(name).add(version);
    }
  }
}

const duplicated = [...versions].filter(([, set]) => set.size > 1);
if (duplicated.length > 0) {
  console.error(
    `check-single-codemirror: mais de uma versão no lockfile (uma cópia de cada pacote, R-X7.10):\n${duplicated
      .map(([name, set]) => `- ${name}: ${[...set].sort().join(', ')}`)
      .join('\n')}`,
  );
  process.exit(1);
}
if (!versions.has('@codemirror/state')) {
  console.error(`check-single-codemirror: ${lockfile} não tem @codemirror/state.`);
  process.exit(1);
}
console.log(`check-single-codemirror: ${versions.size} pacotes, uma versão de cada.`);
