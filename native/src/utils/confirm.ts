/**
 * confirmAsync — cross-platform confirmation dialog.
 *
 * react-native-web's `Alert.alert` does not reliably render multi-button
 * dialogs; the destructive button's `onPress` callback never fires, which
 * makes things like the Sign Out button look broken on the web build.
 *
 * Strategy:
 *   - **web**: skip the confirm dialog entirely and resolve `true`. Browser
 *     `window.confirm` modals are jarring and one tap on a destructive
 *     button is intentional enough for web UX. (We can wire up an in-app
 *     React modal later if real confirmation is needed.)
 *   - **iOS / Android**: use `Alert.alert` which renders correctly.
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

  // Web: no confirmation step. The button tap is the confirmation.
  if (Platform.OS === 'web') {
    return Promise.resolve(true);
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
