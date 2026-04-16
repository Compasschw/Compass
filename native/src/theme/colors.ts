export const colors = {
  // Core palette (from Lovable CSS variables)
  primary: '#3D5A3E',        // hsl(147 20% 30%) — dark forest green
  primaryForeground: '#FFFFFF',
  secondary: '#7A9F5A',      // hsl(100 18% 52%) — sage green
  secondaryForeground: '#FFFFFF',
  background: '#F4F1ED',     // hsl(35 30% 95%) — warm cream
  foreground: '#1E3320',     // hsl(150 20% 12%) — near-black green
  card: '#F7F5F1',           // hsl(35 22% 97%)
  cardForeground: '#1E3320',
  muted: '#E5DFD6',          // hsl(33 22% 90%)
  mutedForeground: '#6B7A6B', // hsl(150 10% 45%)
  border: '#DDD6CC',         // hsl(33 18% 86%)
  destructive: '#E53E3E',    // hsl(0 84% 60%)
  destructiveForeground: '#FFFFFF',
  // Compass brand
  compassGreen: '#3D5A3E',
  compassGreenLight: '#7A9F5A',
  compassCream: '#F4F1ED',
  compassNude: '#DDD1C4',    // hsl(30 25% 88%)
  compassDark: '#142B1A',    // hsl(150 22% 10%)
  compassSage: '#8DA07E',    // hsl(100 14% 58%)
  compassGold: '#D4A030',    // hsl(42 80% 55%)
} as const;

export type ColorToken = keyof typeof colors;
