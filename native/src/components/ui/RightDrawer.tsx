/**
 * RightDrawer — slide-in panel for detail views, forms, and context actions.
 *
 * Platform behaviour:
 *   - Web: `position: fixed` overlay, 520px wide, slides in from the right,
 *     with a semi-transparent backdrop that dismisses on press.
 *   - Native iOS/Android: React Native `<Modal>` with
 *     `presentationStyle="formSheet"`.
 *
 * IMPORTANT: This component deliberately does NOT call `useNavigation()`.
 * All open/close behaviour is driven through callback props so the caller
 * controls navigation state. This prevents the "Navigator not found" error
 * when the drawer is rendered outside a navigation context.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  ScrollView,
  Animated,
  Platform,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { X } from 'lucide-react-native';

import { colors, spacing, radius, shadows } from '../../theme/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RightDrawerProps {
  /** Controls visibility. The parent owns this state. */
  isOpen: boolean;
  /** Called when the drawer requests to be closed (X button or backdrop). */
  onClose: () => void;
  /** Drawer heading. */
  title: string;
  /** Optional subtitle rendered below the title. */
  subtitle?: string;
  /** Scrollable body content. */
  children?: React.ReactNode;
  /** Optional sticky footer row — typically action buttons. */
  footer?: React.ReactNode;
  /**
   * Web-only. When true the drawer renders as an inline flex-column panel
   * (no backdrop, no `position: fixed`) so it participates in normal document
   * flow and compresses sibling content rather than overlaying it.
   *
   * The parent is responsible for placing the drawer as a flex sibling of the
   * main content area. When false (default) the drawer uses the original
   * fixed overlay + backdrop behaviour.
   *
   * On native this prop is ignored — the Modal sheet is always used.
   */
  inline?: boolean;
  /**
   * Fixed pixel width used when `inline` is true.
   * @default 360
   */
  inlineWidth?: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Right-side detail drawer.
 *
 * ```tsx
 * const [open, setOpen] = React.useState(false);
 *
 * <RightDrawer
 *   isOpen={open}
 *   onClose={() => setOpen(false)}
 *   title="Member Details"
 *   subtitle="Rosa Gutierrez"
 *   footer={<Button onPress={() => setOpen(false)}>Done</Button>}
 * >
 *   <MemberDetailContent />
 * </RightDrawer>
 * ```
 */
export function RightDrawer({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  footer,
  inline = false,
  inlineWidth = 360,
}: RightDrawerProps): React.JSX.Element {
  if (Platform.OS !== 'web') {
    return (
      <NativeDrawer
        isOpen={isOpen}
        onClose={onClose}
        title={title}
        subtitle={subtitle}
        footer={footer}
      >
        {children}
      </NativeDrawer>
    );
  }

  if (inline) {
    return (
      <WebInlineDrawer
        isOpen={isOpen}
        onClose={onClose}
        title={title}
        subtitle={subtitle}
        footer={footer}
        inlineWidth={inlineWidth}
      >
        {children}
      </WebInlineDrawer>
    );
  }

  return (
    <WebDrawer
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      footer={footer}
    >
      {children}
    </WebDrawer>
  );
}

// ─── Web implementation ───────────────────────────────────────────────────────

interface DrawerInternalProps extends RightDrawerProps {
  /** Width used by the inline variant. */
  inlineWidth?: number;
}

function WebDrawer({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  footer,
}: DrawerInternalProps): React.JSX.Element {
  // Track whether the panel should be mounted so we can animate out before unmount.
  const [mounted, setMounted] = useState(isOpen);
  const translateX = useRef(new Animated.Value(isOpen ? 0 : 520)).current;

  useEffect(() => {
    if (isOpen) {
      setMounted(true);
      Animated.spring(translateX, {
        toValue:         0,
        useNativeDriver: true,
        tension:         300,
        friction:        30,
      }).start();
    } else {
      Animated.timing(translateX, {
        toValue:         520,
        duration:        200,
        useNativeDriver: true,
      }).start(() => setMounted(false));
    }
  }, [isOpen, translateX]);

  if (!mounted) {
    return <View />;
  }

  return (
    <View style={webStyles.root}>
      {/* Backdrop */}
      <Pressable
        style={webStyles.backdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close drawer"
      />

      {/* Panel */}
      <Animated.View
        style={[
          webStyles.panel,
          shadows.card as ViewStyle,
          { transform: [{ translateX }] },
        ]}
      >
        <DrawerHeader
          title={title}
          subtitle={subtitle}
          onClose={onClose}
        />

        <ScrollView
          style={webStyles.body}
          contentContainerStyle={webStyles.bodyContent}
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>

        {footer !== undefined && (
          <View style={webStyles.footer}>{footer}</View>
        )}
      </Animated.View>
    </View>
  );
}

// ─── Web inline (side-panel) implementation ───────────────────────────────────

/**
 * Inline variant of the web drawer.
 *
 * Renders as a fixed-width flex-column panel with no backdrop and no
 * `position: fixed`. The parent must place this component as a flex sibling
 * of the main content so the layout adjusts naturally.
 *
 * Visibility is controlled by `isOpen`:
 *   - Open: panel is rendered at `inlineWidth` px wide.
 *   - Closed: panel is not mounted (`display:none` equivalent via null return).
 *
 * Keyboard: Esc is handled by the consumer (`OpenQuestionsDrawer`) to avoid
 * double-listener registration. Tap-outside-to-dismiss is intentionally
 * disabled in inline mode — only the X button closes (WCAG: non-modal
 * region, user may interact with adjacent content while panel is open).
 */
function WebInlineDrawer({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  footer,
  inlineWidth = 360,
}: DrawerInternalProps): React.JSX.Element {
  const [mounted, setMounted] = useState(isOpen);
  const translateX = useRef(new Animated.Value(isOpen ? 0 : inlineWidth)).current;

  useEffect(() => {
    if (isOpen) {
      setMounted(true);
      Animated.spring(translateX, {
        toValue:         0,
        useNativeDriver: true,
        tension:         300,
        friction:        30,
      }).start();
    } else {
      Animated.timing(translateX, {
        toValue:         inlineWidth,
        duration:        200,
        useNativeDriver: true,
      }).start(() => setMounted(false));
    }
  }, [isOpen, translateX, inlineWidth]);

  if (!mounted) {
    return <View style={{ width: 0 }} />;
  }

  return (
    <Animated.View
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      accessibilityRole={'complementary' as any}
      style={[
        webInlineStyles.panel,
        { width: inlineWidth },
        shadows.card as ViewStyle,
        { transform: [{ translateX }] },
      ]}
    >
      <DrawerHeader
        title={title}
        subtitle={subtitle}
        onClose={onClose}
      />

      <ScrollView
        style={webInlineStyles.body}
        contentContainerStyle={webInlineStyles.bodyContent}
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>

      {footer !== undefined && (
        <View style={webInlineStyles.footer}>{footer}</View>
      )}
    </Animated.View>
  );
}

const webInlineStyles = StyleSheet.create({
  panel: {
    flexDirection:   'column',
    backgroundColor: colors.cardBg,
    borderLeftWidth: 1,
    borderLeftColor: colors.cardBorder,
    // Prevent the panel from growing beyond its declared width.
    flexShrink:      0,
    // Stretch the full height of its flex-row parent.
    alignSelf:       'stretch',
  } as ViewStyle,

  body: {
    flex: 1,
  } as ViewStyle,

  bodyContent: {
    padding: spacing.xl,
  } as ViewStyle,

  footer: {
    borderTopWidth:  1,
    borderTopColor:  colors.cardBorder,
    padding:         spacing.lg,
    gap:             spacing.sm,
  } as ViewStyle,
});

// ─── Native implementation ────────────────────────────────────────────────────

function NativeDrawer({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  footer,
}: DrawerInternalProps): React.JSX.Element {
  return (
    <Modal
      visible={isOpen}
      animationType="slide"
      presentationStyle="formSheet"
      onRequestClose={onClose}
    >
      <View style={nativeStyles.container}>
        <DrawerHeader
          title={title}
          subtitle={subtitle}
          onClose={onClose}
        />

        <ScrollView
          style={nativeStyles.body}
          contentContainerStyle={nativeStyles.bodyContent}
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>

        {footer !== undefined && (
          <View style={nativeStyles.footer}>{footer}</View>
        )}
      </View>
    </Modal>
  );
}

// ─── Shared header ────────────────────────────────────────────────────────────

interface DrawerHeaderProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
}

function DrawerHeader({
  title,
  subtitle,
  onClose,
}: DrawerHeaderProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false);

  return (
    <View style={headerStyles.header}>
      <View style={headerStyles.textBlock}>
        <Text style={headerStyles.title}>{title}</Text>
        {subtitle !== undefined && subtitle.length > 0 && (
          <Text style={headerStyles.subtitle}>{subtitle}</Text>
        )}
      </View>

      <Pressable
        onPress={onClose}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={({ pressed }) => [
          headerStyles.closeBtn,
          (pressed || hovered) && headerStyles.closeBtnActive,
        ]}
      >
        <X color={colors.textSecondary} size={18} />
      </Pressable>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const webStyles = StyleSheet.create({
  root: {
    position: 'fixed' as 'absolute',
    inset:    0,
    zIndex:   100,
  } as ViewStyle,

  backdrop: {
    position:        'absolute' as 'absolute',
    inset:           0,
    backgroundColor: 'rgba(0,0,0,0.25)',
  } as ViewStyle,

  panel: {
    position:        'absolute' as 'absolute',
    right:           0,
    top:             0,
    bottom:          0,
    width:           520,
    backgroundColor: colors.cardBg,
    borderLeftWidth: 1,
    borderLeftColor: colors.cardBorder,
    flexDirection:   'column',
  } as ViewStyle,

  body: {
    flex: 1,
  } as ViewStyle,

  bodyContent: {
    padding: spacing.xl,
  } as ViewStyle,

  footer: {
    borderTopWidth:  1,
    borderTopColor:  colors.cardBorder,
    padding:         spacing.lg,
    flexDirection:   'row',
    justifyContent:  'flex-end',
    gap:             spacing.sm,
  } as ViewStyle,
});

const nativeStyles = StyleSheet.create({
  container: {
    flex:            1,
    backgroundColor: colors.cardBg,
  } as ViewStyle,

  body: {
    flex: 1,
  } as ViewStyle,

  bodyContent: {
    padding: spacing.xl,
  } as ViewStyle,

  footer: {
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    padding:        spacing.lg,
    flexDirection:  'row',
    justifyContent: 'flex-end',
    gap:            spacing.sm,
  } as ViewStyle,
});

const headerStyles = StyleSheet.create({
  header: {
    flexDirection:   'row',
    alignItems:      'flex-start',
    justifyContent:  'space-between',
    padding:         spacing.xl,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  } as ViewStyle,

  textBlock: {
    flex: 1,
    gap:  4,
  } as ViewStyle,

  title: {
    fontSize:   18,
    fontWeight: '700',
    color:      colors.textPrimary,
    lineHeight: 24,
  } as TextStyle,

  subtitle: {
    fontSize:   13,
    fontWeight: '400',
    color:      colors.textSecondary,
    lineHeight: 18,
  } as TextStyle,

  closeBtn: {
    width:          36,
    height:         36,
    borderRadius:   radius.md,
    alignItems:     'center',
    justifyContent: 'center',
    marginLeft:     spacing.md,
  } as ViewStyle,

  closeBtnActive: {
    backgroundColor: colors.gray100,
  } as ViewStyle,
});
