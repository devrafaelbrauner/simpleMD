import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'desktop',
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // O tema claro embutido é `tokens.css?raw` (@simplemd/themes); sem isto o Vitest troca o CSS
    // por texto vazio.
    css: { include: [/tokens\.css/] },
  },
});
