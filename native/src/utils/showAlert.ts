import { Alert, Platform } from 'react-native';

/**
 * Cross-platform alert.
 *
 * `Alert.alert` is a no-op on react-native-web, which is Compass's primary
 * target — so a bare `Alert.alert` in a mutation's `onError` shows the CHW
 * nothing on the web app, making failed actions look like silent successes.
 * This helper branches to `window.alert` on web (where it renders) and falls
 * back to `Alert.alert` on native.
 *
 * @param title   Short heading (shown bold on native; prefixed on web).
 * @param message Optional detail line.
 */
export function showAlert(title: string, message?: string): void {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.alert(message ? `${title}\n\n${message}` : title);
    return;
  }
  Alert.alert(title, message);
}
