import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'themes',
    environment: 'node',
    css: { include: [/tokens\.css/] },
  },
});
