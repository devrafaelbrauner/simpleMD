import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'vault',
    environment: 'node',
    // `expectTypeOf` não faz nada em tempo de execução: o teste de tipo (AC-2.1) só prova algo
    // quando o verificador de tipos roda.
    typecheck: { enabled: true, include: ['test/**/*.test-d.ts'], tsconfig: './tsconfig.json' },
  },
});
