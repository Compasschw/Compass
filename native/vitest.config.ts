import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Vitest harness — two tiers:
 *
 *  1. Pure-logic tests (`*.test.ts`) run in the fast `node` environment. No
 *     React, no DOM — data transforms, validation, date/geo math.
 *
 *  2. Component / hook tests (`*.test.tsx`) run in `jsdom` with `react-native`
 *     aliased to `react-native-web`. Compass ships web-first via react-native-web,
 *     so this renders components/hooks *exactly as they run in production web* — a
 *     faithful harness, not a mock. Use @testing-library/react (`render`,
 *     `renderHook`, `screen`, `fireEvent`) in these files.
 *
 * A `.test.tsx` file opts into jsdom by extension (glob below); a `.test.ts` file
 * must not import a component (it has no DOM).
 */
export default defineConfig({
  // React 19 automatic JSX runtime via esbuild (no @vitejs/plugin-react — its
  // v6 requires Vite 6, which conflicts with the Vite 5 bundled by vitest 2.1).
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  resolve: {
    // Order matters: the more specific `react-native-reanimated` entry MUST come
    // before `react-native` so the latter's prefix doesn't shadow it.
    alias: [
      {
        // Deterministic stub (resolves at bundler layer — a runtime vi.mock
        // races vitest's parallel workers and lets reanimated's broken browser
        // `mock.js` load first, which flaked CI). See test/reanimated-stub.tsx.
        find: /^react-native-reanimated$/,
        replacement: fileURLToPath(new URL('./test/reanimated-stub.tsx', import.meta.url).href),
      },
      {
        // Production web resolves `react-native` → `react-native-web` (Metro/Expo);
        // mirror that so component tests exercise the real web render path.
        find: /^react-native$/,
        replacement: 'react-native-web',
      },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    // Component/hook tests opt into jsdom by file extension.
    environmentMatchGlobs: [['**/*.test.tsx', 'jsdom']],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/*.d.ts'],
    },
  },
});
