/**
 * confirmAsync — cross-platform confirmation dialog.
 *
 * react-native-web's `Alert.alert` does not reliably render multi-button
 * dialogs; the destructive button's `onPress` callback never fires, which
 * makes things like the Sign Out button look broken on the web build.
 *
 * This helper falls back to `window.confirm` on web (synchronous, but
 * universally supported) and uses `Alert.alert` on iOS/Android where it
 * works as designed. Returns a Promise<boolean> so callers can await it
 * uniformly regardless of platform.
 *
 * Usage:
 *   const ok = await confirmAsync({
 *     title: 'Sign Out',
 *     message: 'Are you sure?',
 *     confirmText: 'Sign Out',
 *     destructive: true,
 *   });
 *   if (ok) await logout();
 */

import { Alert, Platform } from 'react-native';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  /** Renders the confirm button in destructive (red) styling on iOS/Android. */
  destructive?: boolean;
}

export function confirmAsync(opts: ConfirmOptions): Promise<boolean> {
  const {
    title,
    message,
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    destructive = false,
  } = opts;

  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const text = message ? `${title}\n\n${message}` : title;
    return Promise.resolve(window.confirm(text));
  }

  return new Promise<boolean>((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: cancelText, style: 'cancel', onPress: () => resolve(false) },
        {
          text: confirmText,
          style: destructive ? 'destructive' : 'default',
          onPress: () => resolve(true),
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
