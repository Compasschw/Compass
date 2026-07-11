import { defineConfig } from 'vitest/config';

/**
 * Vitest harness — scoped to PURE TypeScript logic.
 *
 * This project is Expo React Native; full component rendering under jsdom is
 * fragile across the RN/React 19 boundary. So this harness deliberately covers
 * only pure, framework-free modules (data transforms, validation, date/geo
 * math) — exactly the logic where silent regressions have bitten us. Tests live
 * next to the code they cover as `*.test.ts`.
 *
 * A test file that imports `react-native` will fail to resolve here by design:
 * keep component tests out until we add a proper RN test runner (jest-expo).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Coverage floor is enforced on CHANGED lines via diff-cover in CI, not as a
    // global percentage — see .github/workflows/ci.yml. Local `bun run test:cov`
    // still prints a full report for spot checks.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
    },
  },
});
