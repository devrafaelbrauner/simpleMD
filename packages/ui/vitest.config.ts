import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'ui',
    environment: 'jsdom',
    setupFiles: ['../core/test/setup-dom.ts'],
    // O Vitest troca CSS por texto vazio, inclusive com `?raw`; o tema claro embutido é
    // `tokens.css?raw` (@simplemd/themes), então essa folha precisa passar.
    css: { include: [/tokens\.css/] },
  },
});
