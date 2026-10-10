import { defineInternalPlugin } from './index';

/** KaTeX (etapa 7): a biblioteca só carrega quando há uma fórmula visível. */
export default defineInternalPlugin({
  id: 'simplemd.katex',
  name: 'Fórmulas KaTeX',
  description: 'Mostra fórmulas entre $ e $$.',
  defaultEnabled: true,
  order: 20,
  load: () => import('@simplemd/plugins-internal/katex'),
});
