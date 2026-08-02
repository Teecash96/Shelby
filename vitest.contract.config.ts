import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/contract/**/*.contract.test.ts'],
    env: {
      PROOFVAULT_TEST_STORAGE_DIR: '.proofvault/test-data',
    },
  },
});
