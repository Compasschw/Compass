/**
 * Deterministic test stub for `react-native-reanimated`.
 *
 * Wired via `resolve.alias` in vitest.config.ts (NOT vi.mock) so it resolves at
 * the bundler layer before any module loads — a runtime `vi.mock` races
 * vitest's parallel workers and intermittently lets reanimated's `browser`
 * entry resolve to its broken `mock.js` (`Cannot find module './src/mock'`),
 * which flaked CI. An alias can't race.
 *
 * Animated.* map to react-native-web host components (via the `react-native` →
 * `react-native-web` alias) so RN style objects render correctly; the worklet
 * timing/interp helpers are inert passthroughs. No real animation runs in tests
 * — these are visual-only effects, irrelevant to behavior assertions.
 */
import { View, Text, Image, ScrollView } from 'react-native';

const identity = <T,>(value: T): T => value;

export { View, Text, Image, ScrollView };

export const useSharedValue = (init: unknown) => ({ value: init });
export const useAnimatedStyle = (fn: () => Record<string, unknown>) => fn();
export const useDerivedValue = (fn: () => unknown) => ({ value: fn() });
export const useAnimatedGestureHandler = () => ({});
export const withTiming = identity;
export const withSpring = identity;
export const withRepeat = (animation: unknown) => animation;
export const withSequence = (...animations: unknown[]) => animations[0];
export const withDelay = (_delay: number, animation: unknown) => animation;
export const Easing = {
  inOut: identity,
  out: identity,
  in: identity,
  ease: identity,
  linear: identity,
  bezier: () => identity,
};
export const runOnJS =
  (fn: (...args: unknown[]) => unknown) =>
  (...args: unknown[]) =>
    fn(...args);
export const runOnUI =
  (fn: (...args: unknown[]) => unknown) =>
  (...args: unknown[]) =>
    fn(...args);
export const interpolate = (value: number) => value;
export const Extrapolation = { CLAMP: 'clamp', EXTEND: 'extend', IDENTITY: 'identity' };
export const Extrapolate = { CLAMP: 'clamp', EXTEND: 'extend', IDENTITY: 'identity' };

export default {
  View,
  Text,
  Image,
  ScrollView,
  createAnimatedComponent: (Component: unknown) => Component,
};
