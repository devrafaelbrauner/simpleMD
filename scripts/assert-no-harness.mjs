#!/usr/bin/env node
// R-2.12: o provider em memória e o harness do Chromium nunca chegam ao build de produção.
// Uso: node scripts/assert-no-harness.mjs [pasta]   (padrão: apps/desktop/dist)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const MARKERS = [
  '__SIMPLEMD_MEMORY_FS__',
  'simplemd:memory-provider',
  '__simplemdHarness',
  // r2 etapa 6 (arch-frontend r2 §15): armazém de aprovações falso e plugins de teste do harness.
  'simplemd:fake-approvals',
  'simplemd:harness-plugins',
  // r2 etapa 11: transporte de IA de replay e keychain falso.
  'simplemd:fake-ai-transport',
  'simplemd:fake-keychain',
  // r2 etapa 10: impressão falsa do harness (H16).
  'simplemd:fake-print',
];
const dir = process.argv[2] ?? 'apps/desktop/dist';

function* walk(path) {
  for (const name of readdirSync(path)) {
    const full = join(path, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

let files = 0;
const hits = [];
try {
  for (const file of walk(dir)) {
    files++;
    const rel = relative(dir, file);
    if (/(^|[\\/])harness([\\/]|$)/.test(rel)) hits.push(`${rel}: pasta do harness no build`);
    const text = readFileSync(file, 'latin1');
    for (const marker of MARKERS)
      if (text.includes(marker)) hits.push(`${rel}: contém "${marker}"`);
  }
} catch (error) {
  console.error(`assert-no-harness: não foi possível ler ${dir}: ${error.message}`);
  process.exit(1);
}
if (files === 0) {
  console.error(`assert-no-harness: ${dir} está vazio (rode o build antes)`);
  process.exit(1);
}
if (hits.length > 0) {
  console.error('assert-no-harness: o harness vazou para o build de produção:');
  for (const hit of hits) console.error(`  ✗ ${hit}`);
  process.exit(1);
}
console.log(
  `assert-no-harness — OK: ${files} arquivo(s) em ${dir}, 0 ocorrências de ${MARKERS.join(', ')}.`,
);
