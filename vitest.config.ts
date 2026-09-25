import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'shared/test/**/*.test.ts',
      'server/test/**/*.test.ts',
      'mock/test/**/*.test.ts',
      'agent/test/**/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
