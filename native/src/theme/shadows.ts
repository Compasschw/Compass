import { Platform } from 'react-native';

export const shadows = {
  card: Platform.select({
    ios: { shadowColor: '#3D5A3E', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.08, shadowRadius: 24 },
    android: { elevation: 3 },
    default: {},
  }),
  elevated: Platform.select({
    ios: { shadowColor: '#3D5A3E', shadowOffset: { width: 0, height: 16 }, shadowOpacity: 0.15, shadowRadius: 48 },
    android: { elevation: 8 },
    default: {},
  }),
  glow: Platform.select({
    ios: { shadowColor: '#3D5A3E', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.12, shadowRadius: 40 },
    android: { elevation: 6 },
    default: {},
  }),
} as const;

export type ShadowToken = keyof typeof shadows;
