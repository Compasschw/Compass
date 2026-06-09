/**
 * PageWrap — max-width container for Member screens on web.
 *
 * On web, constrains content to 1280px and centers it horizontally — matches
 * the CHW dashboard breakpoint so Member dashboards/lists get the same
 * admin-style page width. Form-shaped screens (e.g. RegisterScreen) override
 * via `style={{ maxWidth: 560 }}` to stay narrower.
 *
 * On native mobile, this is a transparent pass-through (flex: 1).
 */

import React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PageWrapProps {
  children: React.ReactNode;
  /** Additional styles merged onto the wrapper View. Use `maxWidth` here to
   *  narrow form screens (e.g. RegisterScreen uses 560). */
  style?: StyleProp<ViewStyle>;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Wraps Member-screen page content with a 1280px max-width cap on web.
 * Form screens override via `style={{ maxWidth: 560 }}` to stay narrower.
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
          ? { maxWidth: 1280, width: '100%', alignSelf: 'center' }
          : { flex: 1 },
        style,
      ]}
    >
      {children}
    </View>
  );
}
