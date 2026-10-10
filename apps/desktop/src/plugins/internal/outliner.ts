import { defineInternalPlugin } from './define';

/**
 * Outliner (r7 I-7, porte do `obsidian-outliner` 4.10.2): desligado por padrão (D-R7-P01). O código
 * só chega no `import()` (pedaço sob demanda); recebe o contexto do host com o privilégio `palette`.
 */
export default defineInternalPlugin({
  id: 'simplemd.outliner',
  name: 'Outliner',
  description:
    'Listas como tópicos: mover, indentar e dobrar itens com os subitens; arrastar pelo marcador.',
  defaultEnabled: false,
  order: 80,
  load: async ({ host }) => {
    const { activate } = await import('@simplemd/plugins-internal/outliner');
    return { default: (api) => activate(api, host) };
  },
});
