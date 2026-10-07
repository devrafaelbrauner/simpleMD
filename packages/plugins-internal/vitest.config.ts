import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'plugins-internal',
    environment: 'jsdom',
    setupFiles: ['../core/test/setup-dom.ts', './test/setup-svg.ts'],
  },
});
