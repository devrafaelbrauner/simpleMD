import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'ai',
    environment: 'node',
    // AC-11.1: `expectTypeOf` só prova algo quando o verificador de tipos roda.
    typecheck: { enabled: true, include: ['test/**/*.test-d.ts'], tsconfig: './tsconfig.json' },
  },
});
