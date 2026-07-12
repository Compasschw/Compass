import React from 'react';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// `__DEV__` is a global injected by the RN/Metro runtime and read at module-load
// by expo-modules-core; jsdom has no such global, so define it here.
(globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;

// Expo native modules can't initialize under jsdom (they expect the native
// runtime). Stub the ones app code imports at module top so pulling in a hook or
// component under test doesn't drag in expo-modules-core. Add more here as new
// component/hook tests surface additional native-only imports.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock('expo-file-system/legacy', () => ({}));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn(async () => false),
  shareAsync: vi.fn(async () => undefined),
}));

// lucide-react-native's compiled bundle does a bare `import ... from
// 'react-native'` internally. Vitest treats node_modules packages as
// external by default, which loads them via Node's native module loader —
// bypassing both Vite's transform pipeline AND the `react-native` →
// `react-native-web` alias in vitest.config.ts — so that nested import
// resolves to the real `react-native` package, whose entry file uses Flow's
// `import typeof` syntax and fails to parse under plain Node/jsdom. Icons are
// decorative and irrelevant to component/hook test assertions, so stub the
// whole package with a Proxy that returns a trivial functional component for
// any icon name (`X`, `CheckCircle2`, `MessageSquare`, ... every named export
// lucide-react-native has) instead of fighting SSR dependency resolution.
vi.mock('lucide-react-native', () => {
  const IconStub = (props: Record<string, unknown>): React.ReactElement =>
    React.createElement('svg', { 'data-lucide-icon-stub': true, ...props });
  // Property names that must NOT resolve to a function. Most critically
  // `then` — if the Proxy returns a function for `then`, JS engines and
  // interop helpers (Node's ESM/CJS interop, `await import(...)`, etc.)
  // treat the whole module namespace object as a thenable and call
  // `mod.then(resolve, reject)` on it. `IconStub(resolve, reject)` renders an
  // <svg> and returns — it never calls `resolve`/`reject` — so whatever
  // awaited the module hangs forever. Every other icon-name property still
  // resolves to `IconStub`.
  const NON_ICON_PROPS = new Set(['then', 'catch', 'finally', 'asymmetricMatch', 'nodeType', 'constructor']);
  return new Proxy(
    {},
    {
      get(_target, prop: string | symbol) {
        if (prop === '__esModule') return true;
        if (typeof prop === 'string' && !NON_ICON_PROPS.has(prop)) return IconStub;
        return undefined;
      },
      // Vitest validates `import { X } from '...'` against the mock via the
      // `in` operator (the `has` trap) before falling through to `get` — the
      // default `has` trap on an empty target always says "no", which made
      // every named icon import fail with "No 'X' export is defined on the
      // mock" even though `get` would have answered it. Answer `true` for
      // any icon-shaped string so every named import resolves.
      has(_target, prop: string | symbol) {
        return typeof prop === 'string' && !NON_ICON_PROPS.has(prop);
      },
    },
  );
});

// react-native-reanimated is stubbed deterministically via `resolve.alias` in
// vitest.config.ts → test/reanimated-stub.tsx (NOT a runtime vi.mock here — that
// races vitest's parallel workers and lets reanimated's broken browser `mock.js`
// load first, flaking CI). See that stub for the rationale.

// Unmount any rendered component tree after each test so DOM state and React
// Query providers never leak between tests.
afterEach(() => {
  cleanup();
});
