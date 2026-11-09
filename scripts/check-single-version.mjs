#!/usr/bin/env node
// Uma cópia de cada pacote marcado (r7 R-X7.10, AC-X7.8; arch-frontend r7 D-R7-F21; r23
// R17-KATEX-GUARD). Roda dentro de `pnpm lint`. Falha (código 1) se o `pnpm-lock.yaml` tiver mais
// de uma instalação de um pacote da lista: outra versão OU a mesma versão com outros peers
// (`x@1.0.0(peerA)` e `x@1.0.0(peerB)` são duas pastas em `.pnpm`, duas instâncias do módulo;
// CR-S0-04). A lista:
// - `@codemirror/*` e `@lezer/common`, `@lezer/highlight`, `@lezer/lr`, `@lezer/markdown`: uma
//   segunda cópia quebra `instanceof`/facets do `@codemirror/state` e o `history()` do
//   `@codemirror/commands` usado pelos plugins internos;
// - `katex`: o app o usa direto e os overrides `mermaid>katex` e `micromark-extension-math>katex`
//   forçam a mesma versão. O Dependabot não mexe em overrides (o #71 deixou duas cópias); o
//   `pnpm deps:fix` os alinha com esta mesma lista;
// - `react` e `react-dom`: duas cópias quebram hooks e contexto.
// Os `micromark-*` ficam de fora: o markdownlint fixa versões exatas (R17-MICROMARK-DUP).
// Uso: `node scripts/check-single-version.mjs [pnpm-lock.yaml]`.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

const SINGLE_VERSION =
  /^(?:@codemirror\/[^/]+|@lezer\/(?:common|highlight|lr|markdown)|katex|react|react-dom)$/;

/** O pacote `name` tem de ter uma cópia só no lockfile. */
export const isSingleVersion = (name) => SINGLE_VERSION.test(name);

/** Nome do pacote no começo da chave `nome@versão(peers…)` do lockfile. */
export const keyName = (key) => /^(@?[^@]+)@/.exec(key)?.[1];

/** Documentos do lockfile como objetos (o pnpm 12 grava dois); lança se algum for inválido. */
export function readLockfile(text) {
  return parseAllDocuments(text).map((doc) => {
    if (doc.errors.length > 0) throw new Error(doc.errors[0].message);
    return doc.toJS() ?? {};
  });
}

/**
 * Instalações dos pacotes da lista: chaves de `packages` (versões) e de `snapshots` (versões +
 * peers). `duplicated` = `[nome, chaves]` de quem tem mais de uma versão ou, com uma versão só, mais
 * de uma chave em `snapshots`.
 */
export function singleVersionReport(docs) {
  const installs = new Map();
  for (const data of docs)
    for (const section of ['packages', 'snapshots'])
      for (const key of Object.keys(data[section] ?? {})) {
        const name = keyName(key);
        if (!name || !isSingleVersion(name)) continue;
        if (!installs.has(name)) installs.set(name, { packages: new Set(), snapshots: new Set() });
        installs.get(name)[section].add(key);
      }
  const duplicated = [...installs]
    .map(([name, { packages, snapshots }]) => [name, packages.size > 1 ? packages : snapshots])
    .filter(([, keys]) => keys.size > 1)
    .map(([name, keys]) => [name, [...keys].sort()]);
  return { installs, duplicated };
}

function main() {
  const lockfile = resolve(
    process.argv[2] ?? fileURLToPath(new URL('../pnpm-lock.yaml', import.meta.url)),
  );
  let docs;
  try {
    docs = readLockfile(readFileSync(lockfile, 'utf8'));
  } catch (error) {
    console.error(`check-single-version: ${lockfile} inválido: ${error.message}`);
    process.exit(1);
  }
  const { installs, duplicated } = singleVersionReport(docs);
  if (duplicated.length > 0) {
    console.error(
      `check-single-version: mais de uma cópia no lockfile (uma cópia de cada pacote, R-X7.10, R17-KATEX-GUARD):\n${duplicated
        .map(([name, keys]) => `- ${name}: ${keys.join(', ')}`)
        .join('\n')}`,
    );
    process.exit(1);
  }
  if (!installs.has('@codemirror/state')) {
    console.error(`check-single-version: ${lockfile} não tem @codemirror/state.`);
    process.exit(1);
  }
  console.log(`check-single-version: ${installs.size} pacotes, uma cópia de cada.`);
}

// Também importado pelo `deps-fix.mjs`: só confere quando é o script chamado. `realpath` dos dois
// lados (o `/tmp` do macOS é link para `/private/tmp`; o Node dá o caminho real ao módulo).
if (
  process.argv[1] &&
  realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))
)
  main();
