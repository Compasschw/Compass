/**
 * ErrorBoundary — class component that catches uncaught render errors
 * and shows a user-friendly fallback instead of a blank screen or crash.
 *
 * Usage:
 *   <ErrorBoundary>
 *     <FeatureScreen />
 *   </ErrorBoundary>
 *
 *   <ErrorBoundary fallback={<MyCustomFallback />}>
 *     <FeatureScreen />
 *   </ErrorBoundary>
 */

import React, { Component, type ComponentType, type ReactNode, type ErrorInfo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { AlertTriangle } from 'lucide-react-native';
import { colors } from '../../theme/colors';

// NOTE: this fallback intentionally uses plain `View`, not `SafeAreaView`
// from react-native-safe-area-context. An ErrorBoundary's job is to render
// SOMETHING when everything else has failed — it can't depend on context
// providers being in scope, because the boundary may itself sit above the
// provider, or the original error may have been thrown by a sibling that
// shares the provider tree. Using SafeAreaView here once blanked
// /member/find: the boundary caught a screen error, then its fallback's
// SafeAreaView threw "No safe area value available" because the
// SafeAreaProvider was below the boundary in the tree. That second throw
// took down the whole React tree and produced an empty `<div id="root">`.
// Plain View has no such dependency and always renders.

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  children: ReactNode;
  /** Custom fallback rendered instead of the default error UI. */
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Structured log — avoids logging PII that might appear in component props.
    console.error('[ErrorBoundary]', {
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false });
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallback) {
      return this.props.fallback;
    }

    return (
      <View style={styles.safeArea}>
        <View style={styles.container}>
          <View style={styles.card}>
            <View style={styles.iconWrap}>
              <AlertTriangle size={32} color={colors.destructive} />
            </View>
            <Text style={styles.title}>Something went wrong</Text>
            <Text style={styles.body}>
              We hit an unexpected error. Please try again.
            </Text>
            <TouchableOpacity
              style={styles.button}
              onPress={this.handleRetry}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Try again"
            >
              <Text style={styles.buttonLabel}>Try Again</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }
}

// ─── withErrorBoundary HOC ────────────────────────────────────────────────────

/**
 * Higher-order component that wraps a screen component in an ErrorBoundary.
 *
 * Usage at the navigator registration site:
 *   <Stack.Screen name="MyScreen" component={withErrorBoundary(MyScreen)} />
 *
 * This limits the blast radius of a render crash to a single screen: the rest
 * of the navigator stays alive and the user can navigate away. Without this,
 * one screen crash takes down the entire navigator tree.
 *
 * DisplayName convention: `withErrorBoundary(MyScreen)` — visible in DevTools.
 * hoist-non-react-statics is NOT needed here because this HOC is only ever
 * applied at navigator registration time (not composed with other HOCs that
 * carry static methods like navigationOptions).
 */
export function withErrorBoundary<P extends object>(
  Component: ComponentType<P>,
): ComponentType<P> {
  const displayName = Component.displayName ?? Component.name ?? 'Component';

  function WithErrorBoundaryWrapper(props: P): React.JSX.Element {
    return (
      <ErrorBoundary>
        <Component {...props} />
      </ErrorBoundary>
    );
  }

  WithErrorBoundaryWrapper.displayName = `withErrorBoundary(${displayName})`;

  return WithErrorBoundaryWrapper;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  } as ViewStyle,
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  } as ViewStyle,
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 20,
    padding: 40,
    alignItems: 'center',
    width: '100%',
    maxWidth: 360,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  } as ViewStyle,
  iconWrap: {
    marginBottom: 16,
  } as ViewStyle,
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.foreground,
    marginBottom: 8,
    textAlign: 'center',
  } as TextStyle,
  body: {
    fontSize: 14,
    color: colors.mutedForeground,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
  } as TextStyle,
  button: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingHorizontal: 24,
    paddingVertical: 12,
  } as ViewStyle,
  buttonLabel: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  } as TextStyle,
});
