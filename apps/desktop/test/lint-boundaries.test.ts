// r7 S0 (AC-X7.8, R-X7.10, AC-I9.1; CR-S0-05): as regras do `eslint.config.js` para o catálogo
// privado do `simplemd.tasks` reprovam os contornos (sufixo `.js`/`.ts`, `import()` dinâmico) fora
// do registro `apps/desktop/src/plugins/internal/tasks.ts` e o liberam nele. Código lido pelo ESLint
// com o caminho de cada arquivo (nada é gravado no disco).
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, test } from 'vitest';

const ROOT = join(__dirname, '../../..');
const eslint = new ESLint({ cwd: ROOT });

async function errors(path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, path) });
  return (result?.messages ?? []).filter((m) => m.severity === 2).map((m) => m.ruleId ?? '');
}

describe('caminho privado do catálogo de tarefas (CR-S0-05)', () => {
  test.each([
    ['apps/desktop/src/app/probe.ts', "export { a } from '../catalog/tasks-catalog.js';\n"],
    [
      'apps/desktop/src/app/probe.ts',
      "export const l = () => import('../catalog/tasks-catalog');\n",
    ],
    [
      'apps/desktop/src/app/probe.ts',
      "export const l = () => import('@simplemd/plugin-api/internal/tasks-catalog');\n",
    ],
    [
      'apps/desktop/src/app/probe.ts',
      "export type { B } from '@simplemd/plugin-api/internal/tasks-catalog.ts';\n",
    ],
    [
      'apps/desktop/harness/probe.ts',
      "export const l = () => import('../src/catalog/tasks-catalog.js');\n",
    ],
    [
      'packages/vault/src/probe.ts',
      "export const l = () => import('../x/catalog/tasks-catalog');\n",
    ],
    [
      'packages/core/src/probe.ts',
      "export const l = () => import('./catalog/tasks-catalog.ts');\n",
    ],
  ])('%s: `%s` reprova', async (path, code) => {
    expect((await errors(path, code)).length).toBeGreaterThan(0);
  });

  test('o registro plugins/internal/tasks.ts pode importar estática e dinamicamente', async () => {
    const code = [
      "import type { TasksCatalog } from '@simplemd/plugin-api/internal/tasks-catalog';",
      "export { createTasksCatalog } from '../../catalog/tasks-catalog';",
      "export const lazy = () => import('../../catalog/tasks-catalog');",
      'export type { TasksCatalog };',
      '',
    ].join('\n');
    expect(await errors('apps/desktop/src/plugins/internal/tasks.ts', code)).toEqual([]);
  });

  test('a regra não pega nomes parecidos (tasks-catalog-view, outro/tasks-catalogo)', async () => {
    const code = [
      "export { a } from '../catalog/tasks-catalog-view';",
      "export const l = () => import('./outro/tasks-catalogo');",
      '',
    ].join('\n');
    expect(await errors('apps/desktop/src/app/probe.ts', code)).toEqual([]);
  });
});
