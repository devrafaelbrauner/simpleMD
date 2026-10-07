import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'plugin-api',
    environment: 'jsdom',
    setupFiles: ['../core/test/setup-dom.ts'],
    // AC-6.1: `expectTypeOf` só prova algo quando o verificador de tipos roda.
    typecheck: { enabled: true, include: ['test/**/*.test-d.ts'], tsconfig: './tsconfig.json' },
  },
});
