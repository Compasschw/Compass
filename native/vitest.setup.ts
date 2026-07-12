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

// Unmount any rendered component tree after each test so DOM state and React
// Query providers never leak between tests.
afterEach(() => {
  cleanup();
});
