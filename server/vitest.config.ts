import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // Tests must not connect to Supabase or hit any network — fail fast if they try.
    testTimeout: 10_000,
  },
});
