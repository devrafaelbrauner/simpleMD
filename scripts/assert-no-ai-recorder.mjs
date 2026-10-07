#!/usr/bin/env node
// AC-11.17: o gravador de fixtures de IA existe só no build de debug (`#[cfg(debug_assertions)]`).
// Confere que o binário de RELEASE não contém os nomes das variáveis de ambiente nem a constante da
// chave inválida do caso 401 (equivalente a `strings <binário> | grep`).
// Uso: node scripts/assert-no-ai-recorder.mjs [binário]
//      (padrão: apps/desktop/src-tauri/target/release/simplemd[.exe])
import { existsSync, readFileSync } from 'node:fs';

const MARKERS = [
  'SIMPLEMD_AI_RECORD_DIR',
  'SIMPLEMD_AI_RECORD_INVALID_KEY',
  'invalid-key-for-401-fixture',
];
const fallback = `apps/desktop/src-tauri/target/release/simplemd${process.platform === 'win32' ? '.exe' : ''}`;
const binary = process.argv[2] ?? fallback;
if (!existsSync(binary)) {
  console.error(`assert-no-ai-recorder: ${binary} não existe (rode o build de release antes)`);
  process.exit(1);
}
const bytes = readFileSync(binary);
const hits = MARKERS.map((marker) => [marker, bytes.indexOf(Buffer.from(marker, 'utf8'))]).filter(
  ([, at]) => at !== -1,
);
if (hits.length > 0) {
  console.error('assert-no-ai-recorder: o gravador de IA vazou para o binário de release:');
  for (const [marker, at] of hits) console.error(`  ✗ "${marker}" no byte ${at}`);
  process.exit(1);
}
console.log(
  `assert-no-ai-recorder — OK: ${binary} (${bytes.length} bytes), 0 ocorrências de ${MARKERS.join(', ')}.`,
);
