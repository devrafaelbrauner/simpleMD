import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'desktop',
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // O tema claro embutido é `tokens.css?raw` (@simplemd/themes) e a exportação embute
    // `export.css?raw` e `katex.min.css?raw` (etapa 10); sem isto o Vitest troca o CSS por texto
    // vazio.
    css: { include: [/tokens\.css/, /export\.css/, /katex\.min\.css/] },
  },
});
