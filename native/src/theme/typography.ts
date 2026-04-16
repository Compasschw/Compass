export const fonts = {
  display: 'DMSans_700Bold',
  displaySemibold: 'DMSans_600SemiBold',
  displayMedium: 'DMSans_500Medium',
  body: 'PlusJakartaSans_400Regular',
  bodyMedium: 'PlusJakartaSans_500Medium',
  bodySemibold: 'PlusJakartaSans_600SemiBold',
  bodyBold: 'PlusJakartaSans_700Bold',
} as const;

export const typography = {
  displayXl: { fontSize: 48, lineHeight: 52, fontFamily: fonts.display, letterSpacing: -1.5 },
  displayLg: { fontSize: 36, lineHeight: 40, fontFamily: fonts.display, letterSpacing: -1 },
  displayMd: { fontSize: 28, lineHeight: 34, fontFamily: fonts.display, letterSpacing: -0.5 },
  displaySm: { fontSize: 24, lineHeight: 30, fontFamily: fonts.displaySemibold },
  bodyLg: { fontSize: 18, lineHeight: 28, fontFamily: fonts.body },
  bodyMd: { fontSize: 16, lineHeight: 24, fontFamily: fonts.body },
  bodySm: { fontSize: 14, lineHeight: 20, fontFamily: fonts.body },
  label: { fontSize: 12, lineHeight: 16, fontFamily: fonts.bodySemibold, letterSpacing: 1 },
} as const;

export type FontToken = keyof typeof fonts;
export type TypographyToken = keyof typeof typography;
