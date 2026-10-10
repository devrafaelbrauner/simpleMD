import { defineInternalPlugin } from './define';

/** Cálculo (etapa 7): resultado de expressões `=…` ao lado da linha. */
export default defineInternalPlugin({
  id: 'simplemd.calc',
  name: 'Cálculo',
  description: 'Mostra o resultado de expressões como =2+3.',
  defaultEnabled: true,
  order: 30,
  load: () => import('@simplemd/plugins-internal/calc'),
});
