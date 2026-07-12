/**
 * AppDialogProvider — global in-app replacement for the browser's
 * `window.alert` "…says" popup.
 *
 * Mount once at the app root (see App.tsx). It subscribes to the
 * `alertQueue` module (src/utils/alertQueue.ts) via `useSyncExternalStore`
 * and renders the alert at the front of the queue, if any, as a styled
 * Compass dialog — scrim + centered card + title + message + a single OK
 * button. Visual language matches the in-app confirm/success panels in
 * DocumentationModal (src/components/sessions/DocumentationModal.tsx):
 * `rgba(15, 23, 42, 0.45)` scrim, white card, emerald primary button.
 *
 * `showAlert()` (src/utils/showAlert.ts) calls `enqueueAlert()` on web,
 * which is a plain module function — no hook, no Context — so it can be
 * called from anywhere, including outside React (a mutation's `onError`).
 * This provider is the only thing that reads the queue; everything else
 * just writes to it.
 *
 * Rendered via RN's `Modal`, only while the queue is non-empty. On web,
 * react-native-web's Modal portals into a fresh `document.body` child each
 * time it mounts (see react-native-web/src/exports/Modal/ModalPortal.js) and
 * neither it nor its content sets an explicit `z-index` — stacking among
 * sibling `position: fixed` portals is by DOM insertion order, so whichever
 * Modal mounts *last* paints on top. Because this dialog only mounts a
 * `<Modal>` when an alert is actually queued (not an always-present
 * `visible={false}` one), a `showAlert` fired while e.g. DocumentationModal
 * is already open mounts after it and therefore renders above it — verified
 * against DocumentationModal's own web confirm/success panels, which use
 * the same portal mechanism.
 */
import React from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { colors as tokens, radius, shadows, spacing } from '../../theme/tokens';
import {
  dismissFrontAlert,
  getAlertQueueSnapshot,
  subscribeAlertQueue,
} from '../../utils/alertQueue';

export function AppDialogProvider(): React.JSX.Element | null {
  const queue = React.useSyncExternalStore(
    subscribeAlertQueue,
    getAlertQueueSnapshot,
    getAlertQueueSnapshot,
  );
  const front = queue[0];

  if (!front) return null;

  return (
    <Modal
      key={front.id}
      visible
      transparent
      animationType="fade"
      onRequestClose={dismissFrontAlert}
      accessible
      accessibilityViewIsModal
    >
      <View style={styles.overlay} accessibilityViewIsModal accessibilityRole="alert">
        <View style={styles.card}>
          <Text style={styles.title}>{front.title}</Text>
          {front.message ? <Text style={styles.message}>{front.message}</Text> : null}
          <TouchableOpacity
            style={styles.button}
            onPress={dismissFrontAlert}
            accessibilityRole="button"
            accessibilityLabel="OK"
          >
            <Text style={styles.buttonText}>OK</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: tokens.cardBg,
    borderRadius: radius.lg,
    padding: spacing.xl,
    gap: spacing.md,
    ...shadows.card,
  },
  title: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 17,
    color: tokens.textPrimary,
  },
  message: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    lineHeight: 20,
    color: tokens.textSecondary,
  },
  button: {
    alignSelf: 'flex-end',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: tokens.primary,
    marginTop: spacing.sm,
  },
  buttonText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#FFFFFF',
  },
});
