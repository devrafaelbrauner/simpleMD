import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'ui',
    environment: 'jsdom',
    setupFiles: ['../core/test/setup-dom.ts'],
  },
});
