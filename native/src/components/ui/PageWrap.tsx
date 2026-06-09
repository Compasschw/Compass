/**
 * PageWrap — max-width container for Member screens on web.
 *
 * On web (Platform.OS === 'web'), constrains content to 560px and centers it
 * horizontally. On native mobile, this is a transparent pass-through (flex: 1).
 *
 * Wave 3 Member screens MUST wrap their root content in PageWrap.
 * CHW screens do NOT use this — they are admin-style and go full-width.
 */

import React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PageWrapProps {
  children: React.ReactNode;
  /** Additional styles merged onto the wrapper View. */
  style?: StyleProp<ViewStyle>;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Wraps Member-screen page content with a 560px max-width cap on web.
 * On native the wrapper is a transparent flex:1 pass-through.
 *
 * @example
 * <PageWrap>
 *   <PageHeader title="Hello, Maria" subtitle="Your care summary" />
 *   <Card style={{ padding: spacing.xl }}>...</Card>
 * </PageWrap>
 */
export function PageWrap({ children, style }: PageWrapProps): React.JSX.Element {
  return (
    <View
      style={[
        Platform.OS === 'web'
          ? { maxWidth: 560, width: '100%', alignSelf: 'center' }
          : { flex: 1 },
        style,
      ]}
    >
      {children}
    </View>
  );
}
