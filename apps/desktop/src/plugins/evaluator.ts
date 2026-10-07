import type { ModuleEvaluator } from '@simplemd/plugin-api/runtime';

/**
 * Avaliador de módulos do app e do harness: `blob:` + `import()` dinâmico. A CSP ganha exatamente
 * `blob:` em `script-src` (arch-backend r2 §1.3.3, AC-6.26). Um `blob:` só é criado por script que
 * já roda na origem, então não abre vetor de injeção (sem `'unsafe-inline'`).
 */
export function createBlobEvaluator(): ModuleEvaluator {
  return {
    publish: (text) => URL.createObjectURL(new Blob([text], { type: 'text/javascript' })),
    importModule: (url) => import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>,
    release: (url) => URL.revokeObjectURL(url),
  };
}
