import { defineInternalPlugin } from './define';

/** Mermaid (etapa 7): a biblioteca só carrega quando há um bloco visível. */
export default defineInternalPlugin({
  id: 'simplemd.mermaid',
  name: 'Diagramas Mermaid',
  description: 'Desenha blocos mermaid como diagramas.',
  defaultEnabled: true,
  order: 10,
  load: () => import('@simplemd/plugins-internal/mermaid'),
});
