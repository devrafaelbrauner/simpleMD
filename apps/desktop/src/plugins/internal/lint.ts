import { defineInternalPlugin } from './define';

/**
 * Lint de Markdown (r7 I-5, S5): markdownlint num worker, só diagnóstico, desligado por padrão
 * (D-R7-P01). O descritor fica minúsculo: a opção "Regras em uso" e o plugin chegam por `import()`
 * (0 bytes do lint na partida, NFR-54). Privilégios (`files` = `.markdownlint.json(c)`, `problems`,
 * alvo de interação W2) na tabela de `internal-context.ts`.
 */
export default defineInternalPlugin({
  id: 'simplemd.lint',
  name: 'Lint de Markdown',
  description: 'Aponta problemas de estilo do Markdown (markdownlint). Só mostra; nunca corrige.',
  defaultEnabled: false,
  order: 60,
  options: [
    {
      key: 'rules',
      kind: 'info',
      label: 'Regras em uso',
      info: async (src) =>
        (await import('@simplemd/plugins-internal/lint/render')).rulesInUse((name) =>
          src.readFile(name),
        ),
    },
  ],
  load: async ({ host }) =>
    (await import('@simplemd/plugins-internal/lint')).createLintPlugin(host),
});
