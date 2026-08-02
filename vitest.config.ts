import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Local adapter tests write into the scratch data directory; keep them out
    // of the repository tree so test runs never pollute the working directory.
    env: {
      PROOFVAULT_TEST_STORAGE_DIR: '.proofvault/test-data',
    },
  },
});
