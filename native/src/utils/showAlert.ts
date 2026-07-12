import { Alert, Platform } from 'react-native';

import { enqueueAlert } from './alertQueue';

/**
 * Cross-platform alert.
 *
 * `Alert.alert` is a no-op on react-native-web, which is Compass's primary
 * target — so a bare `Alert.alert` in a mutation's `onError` shows the CHW
 * nothing on the web app, making failed actions look like silent successes.
 *
 * On web this now enqueues an in-app Compass dialog (rendered by
 * `AppDialogProvider`, mounted once at the app root in App.tsx) instead of
 * the browser's native `window.alert` "…says" popup — see
 * src/utils/alertQueue.ts for the queueing mechanism and
 * src/components/shared/AppDialogProvider.tsx for the rendered dialog.
 * `enqueueAlert` is a plain module function (no hook, no Context), so this
 * keeps working exactly as before for every existing caller — including the
 * ~16 mutation `onError` handlers in hooks/useApiQueries.ts, which call this
 * from outside any component.
 *
 * Native already renders `Alert.alert` as a native OS dialog, which looks
 * in-app by definition, so it's left as-is.
 *
 * @param title   Short heading.
 * @param message Optional detail line.
 */
export function showAlert(title: string, message?: string): void {
  if (Platform.OS === 'web') {
    enqueueAlert(title, message);
    return;
  }
  Alert.alert(title, message);
}
