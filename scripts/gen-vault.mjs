// Gera o vault de teste do catálogo (R-9.9; 2.000 notas, semente fixa) numa pasta real, para o
// teste MAC do critério 6 (AC-9.10). Uso: `node scripts/gen-vault.mjs /private/tmp/vault-2000`.
// O gerador é o mesmo do harness e dos testes (`packages/core/src/testing/generate-vault.ts`, sem
// imports, carregado direto pelo Node com remoção de tipos).
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('uso: node scripts/gen-vault.mjs <pasta-vazia>');
  process.exit(2);
}
const root = resolve(target);
mkdirSync(root, { recursive: true });
if (readdirSync(root).length > 0) {
  console.error(`a pasta não está vazia: ${root}`);
  process.exit(1);
}
const { generateVault } = await import(
  new URL('../packages/core/src/testing/generate-vault.ts', import.meta.url).href
);
const files = generateVault();
for (const [rel, text] of Object.entries(files)) {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}
console.log(`${Object.keys(files).length} notas em ${root}`);
