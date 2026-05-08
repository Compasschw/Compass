/**
 * RateChwModal — modal sheet a member opens after a session ends.
 *
 * Features:
 *   - Tap-to-select star rating (1-5), required before submitting
 *   - Optional multiline free-text input with a live character counter (max 500)
 *   - Submits via POST /api/v1/sessions/{session_id}/testimonials
 *   - Success state with a thank-you message + auto-close after 2 s
 *   - Handles 409 (already rated) gracefully with an informative message
 *   - Controlled: parent manages visibility; ``onClose`` fires on dismiss/success
 *
 * Usage:
 *   ```tsx
 *   <RateChwModal
 *     visible={showRateModal}
 *     sessionId={session.id}
 *     chwName={session.chwName}
 *     onClose={() => setShowRateModal(false)}
 *     onSubmitted={() => {
 *       setHasTestimonial(true);
 *       setShowRateModal(false);
 *     }}
 *   />
 *   ```
 *
 * The parent (MemberSessionsScreen) is responsible for:
 *   - Passing ``sessionId`` (the UUID of the completed session)
 *   - Hiding the "Rate this CHW" button when ``onSubmitted`` has fired
 */

import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Star, X } from 'lucide-react-native';

import { submitTestimonial } from '../../api/testimonials';
import { ApiError } from '../../api/client';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_TEXT_LENGTH = 500;

// ─── Types ────────────────────────────────────────────────────────────────────

interface RateChwModalProps {
  /** Whether the modal is currently visible. */
  visible: boolean;
  /** UUID of the completed session being rated. */
  sessionId: string;
  /** Display name of the CHW (used in the prompt text). */
  chwName: string;
  /** Called when the modal should be dismissed (cancel, success, or already-rated). */
  onClose: () => void;
  /**
   * Called after a testimonial is successfully submitted.
   * Parent should hide the "Rate this CHW" button when this fires.
   */
  onSubmitted?: () => void;
}

// ─── Star selector sub-component ─────────────────────────────────────────────

interface StarSelectorProps {
  rating: number;
  onSelect: (rating: number) => void;
  disabled?: boolean;
}

function StarSelector({ rating, onSelect, disabled = false }: StarSelectorProps): React.JSX.Element {
  return (
    <View
      style={starSelectorStyles.row}
      accessibilityRole="radiogroup"
      accessibilityLabel="Star rating selector"
    >
      {Array.from({ length: 5 }, (_, i) => {
        const starValue = i + 1;
        const isFilled = starValue <= rating;

        return (
          <TouchableOpacity
            key={starValue}
            onPress={() => !disabled && onSelect(starValue)}
            disabled={disabled}
            hitSlop={8}
            accessibilityRole="radio"
            accessibilityState={{ checked: rating === starValue }}
            accessibilityLabel={`${starValue} star${starValue !== 1 ? 's' : ''}`}
          >
            <Star
              size={36}
              color={isFilled ? '#FBBF24' : colors.border}
              fill={isFilled ? '#FBBF24' : 'transparent'}
            />
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const starSelectorStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 8,
  },
});

// ─── Rating label helper ──────────────────────────────────────────────────────

function ratingLabel(rating: number): string {
  const labels: Record<number, string> = {
    1: 'Poor',
    2: 'Fair',
    3: 'Good',
    4: 'Great',
    5: 'Excellent',
  };
  return labels[rating] ?? '';
}

// ─── Main component ───────────────────────────────────────────────────────────

export function RateChwModal({
  visible,
  sessionId,
  chwName,
  onClose,
  onSubmitted,
}: RateChwModalProps): React.JSX.Element {
  const [rating, setRating] = useState(0);
  const [text, setText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  // Reset state when the modal closes.
  const handleDismiss = useCallback(() => {
    setRating(0);
    setText('');
    setIsSubmitting(false);
    setIsSuccess(false);
    onClose();
  }, [onClose]);

  const handleSubmit = useCallback(async () => {
    if (rating === 0) {
      Alert.alert('Rating required', 'Please select a star rating before submitting.');
      return;
    }

    setIsSubmitting(true);
    try {
      await submitTestimonial(sessionId, {
        rating,
        text: text.trim() || null,
      });

      setIsSuccess(true);
      onSubmitted?.();

      // Auto-close after 2 seconds so the member sees the thank-you state.
      setTimeout(() => {
        handleDismiss();
      }, 2000);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 409) {
        // Already submitted — treat as success (idempotent UX).
        Alert.alert(
          'Already submitted',
          'You have already rated this session.',
          [{ text: 'OK', onPress: handleDismiss }],
        );
        return;
      }
      const message = err instanceof Error ? err.message : 'Submission failed. Please try again.';
      Alert.alert('Error', message);
    } finally {
      setIsSubmitting(false);
    }
  }, [rating, text, sessionId, onSubmitted, handleDismiss]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleDismiss}
      accessible
      accessibilityViewIsModal
    >
      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.kav}
        >
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Rate Your Session</Text>
            <TouchableOpacity
              onPress={handleDismiss}
              style={styles.closeButton}
              accessibilityRole="button"
              accessibilityLabel="Close rating modal"
              hitSlop={8}
            >
              <X size={20} color={colors.foreground} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
          >
            {isSuccess ? (
              /* ── Success state ─────────────────────────────────── */
              <View style={styles.successContainer}>
                <Text style={styles.successEmoji}>Thank you!</Text>
                <Text style={styles.successTitle}>Review submitted</Text>
                <Text style={styles.successSub}>
                  Your rating has been submitted and is pending review.
                </Text>
              </View>
            ) : (
              /* ── Form state ─────────────────────────────────────── */
              <>
                <Text style={styles.prompt}>
                  How was your session with{' '}
                  <Text style={styles.chwNameInline}>{chwName}</Text>?
                </Text>

                {/* Star selector */}
                <View style={styles.starSection}>
                  <StarSelector
                    rating={rating}
                    onSelect={setRating}
                    disabled={isSubmitting}
                  />
                  {rating > 0 && (
                    <Text style={styles.ratingLabelText}>{ratingLabel(rating)}</Text>
                  )}
                </View>

                {/* Text input */}
                <View style={styles.textSection}>
                  <Text style={styles.textLabel}>
                    Share more (optional)
                  </Text>
                  <TextInput
                    value={text}
                    onChangeText={(v) => setText(v.slice(0, MAX_TEXT_LENGTH))}
                    placeholder={`What made this session stand out? (max ${MAX_TEXT_LENGTH} chars)`}
                    placeholderTextColor={colors.mutedForeground}
                    multiline
                    numberOfLines={4}
                    maxLength={MAX_TEXT_LENGTH}
                    style={styles.textInput}
                    textAlignVertical="top"
                    editable={!isSubmitting}
                    accessibilityLabel="Review text input"
                  />
                  <Text
                    style={[
                      styles.charCounter,
                      text.length >= MAX_TEXT_LENGTH && styles.charCounterAtLimit,
                    ]}
                  >
                    {text.length} / {MAX_TEXT_LENGTH}
                  </Text>
                </View>
              </>
            )}
          </ScrollView>

          {/* Footer action button — hidden in success state */}
          {!isSuccess && (
            <View style={styles.footer}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={handleDismiss}
                disabled={isSubmitting}
                accessibilityRole="button"
                accessibilityLabel="Cancel rating"
              >
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.submitBtn,
                  (isSubmitting || rating === 0) && styles.submitBtnDisabled,
                ]}
                onPress={() => { void handleSubmit(); }}
                disabled={isSubmitting || rating === 0}
                accessibilityRole="button"
                accessibilityLabel="Submit rating"
                accessibilityState={{ disabled: isSubmitting || rating === 0 }}
              >
                {isSubmitting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.submitBtnText}>Submit Rating</Text>
                )}
              </TouchableOpacity>
            </View>
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  kav: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: '#FFFFFF',
  },
  headerTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 20,
    lineHeight: 26,
    color: colors.foreground,
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    padding: 24,
    gap: 24,
  },
  prompt: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 16,
    lineHeight: 24,
    color: colors.foreground,
    textAlign: 'center',
  },
  chwNameInline: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    color: colors.primary,
  },
  starSection: {
    alignItems: 'center',
    gap: 8,
  },
  ratingLabelText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 15,
    color: colors.compassGold,
  },
  textSection: {
    gap: 6,
  },
  textLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: colors.mutedForeground,
  },
  textInput: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 15,
    color: colors.foreground,
    minHeight: 110,
  },
  charCounter: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: colors.mutedForeground,
    textAlign: 'right',
  },
  charCounterAtLimit: {
    color: colors.destructive,
  },
  footer: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: '#FFFFFF',
  },
  cancelBtn: {
    flex: 1,
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 15,
    color: colors.mutedForeground,
  },
  submitBtn: {
    flex: 2,
    height: 48,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitBtnDisabled: {
    opacity: 0.5,
  },
  submitBtnText: {
    fontFamily: 'PlusJakartaSans_700Bold',
    fontSize: 15,
    color: '#FFFFFF',
  },
  // ── Success state ──────────────────────────────────────────────────────
  successContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingVertical: 48,
  },
  successEmoji: {
    fontSize: 48,
  },
  successTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 22,
    color: colors.primary,
  },
  successSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 15,
    color: colors.mutedForeground,
    textAlign: 'center',
    lineHeight: 22,
    maxWidth: 280,
  },
});
