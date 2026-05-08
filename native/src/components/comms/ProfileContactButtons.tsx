/**
 * ProfileContactButtons — drop-in "Call" and "Message" action row.
 *
 * Used on both the CHW-facing MemberProfile and the member-facing CHW Profile
 * screens. Props determine which backend endpoint to hit and how to find the
 * correct peer in the in-app messaging conversation.
 *
 * Call flow:
 *   1. Tap "Call" → confirm dialog explains the masked-number + no-recording
 *      contract, then POSTs to the appropriate endpoint.
 *   2. Success → display confirmation toast.
 *   3. 429 → rate-limit toast with remaining quota context.
 *   4. 403 → no-relationship toast (guard message).
 *   5. Network/5xx → generic error toast.
 *
 * Message flow:
 *   1. Tap "Message" → POST /conversations/find-or-create with the peer's id.
 *   2. Navigate to the SessionChat screen using the returned conversation_id.
 *      (Navigation target: `SessionChat` in CHWSessionsStack with conversationId
 *       param, or equivalent member stack screen — caller handles navigation
 *       via the `onNavigateToConversation` callback to stay stack-agnostic.)
 *
 * Disabled state:
 *   When sharedSessionCount === 0 both buttons render as disabled with an
 *   explanatory tooltip-style subtitle instead of the "Soon" pill from
 *   the previous placeholder version.
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { MessageSquare, Phone } from 'lucide-react-native';

import { api, ApiError } from '../../api/client';
import { colors } from '../../theme/colors';
import { fonts } from '../../theme/typography';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Role of the user being contacted — determines which backend endpoint to use.
 *   'member' → caller is a CHW → POST /api/v1/chw/members/{id}/call
 *   'chw'    → caller is a member → POST /api/v1/member/chws/{id}/call
 */
export type TargetUserRole = 'member' | 'chw';

export interface ProfileContactButtonsProps {
  /** UUID of the user to call or message. */
  targetUserId: string;
  /** Role of the target user (determines which endpoint to use). */
  targetUserRole: TargetUserRole;
  /**
   * Number of sessions the current user shares with this target.
   * When 0, both buttons are disabled and show a relationship-gate message.
   */
  sharedSessionCount: number;
  /**
   * Display name of the target user — used in the call confirm dialog.
   * Defaults to 'this person' when not provided.
   */
  targetDisplayName?: string;
  /**
   * Callback fired when the "Message" tap resolves a conversation id.
   * The parent screen is responsible for navigating to the conversation
   * (this keeps the component stack-agnostic).
   *
   * @param conversationId UUID string of the found/created conversation.
   */
  onNavigateToConversation: (conversationId: string) => void;
}

// ─── API response shapes ──────────────────────────────────────────────────────

interface AdHocCallResponse {
  provider_session_id: string;
  rate_limit_remaining: number;
}

interface ConversationResponse {
  id: string;
  chw_id: string;
  member_id: string;
  session_id: string | null;
  created_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _callEndpoint(targetUserId: string, targetUserRole: TargetUserRole): string {
  if (targetUserRole === 'member') {
    // CHW → member call
    return `/chw/members/${targetUserId}/call`;
  }
  // member → CHW call
  return `/member/chws/${targetUserId}/call`;
}

function _showToast(message: string): void {
  /**
   * Cross-platform toast. On native we use a short Alert.alert; on web we use
   * window.alert. For a production app with a toast library (react-native-toast-message
   * or burnt), swap this implementation without touching call sites.
   */
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.alert(message);
  } else {
    Alert.alert('', message, [{ text: 'OK' }], { cancelable: true });
  }
}

function _extractErrorMessage(error: unknown): { message: string; isRateLimit: boolean; isForbidden: boolean } {
  if (error instanceof ApiError) {
    return {
      message: error.detail,
      isRateLimit: error.status === 429,
      isForbidden: error.status === 403,
    };
  }
  return {
    message: 'Something went wrong. Please try again.',
    isRateLimit: false,
    isForbidden: false,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ProfileContactButtons({
  targetUserId,
  targetUserRole,
  sharedSessionCount,
  targetDisplayName = 'this person',
  onNavigateToConversation,
}: ProfileContactButtonsProps): React.JSX.Element {
  const [callLoading, setCallLoading] = useState(false);
  const [messageLoading, setMessageLoading] = useState(false);

  const isRelationshipEstablished = sharedSessionCount > 0;

  // ── Call handler ─────────────────────────────────────────────────────────────

  const handleCallPress = useCallback((): void => {
    if (!isRelationshipEstablished) {
      _showToast(
        'Calling is only available after your first session together. Schedule a session to unlock direct contact.',
      );
      return;
    }

    const firstName = targetDisplayName.split(' ')[0] ?? targetDisplayName;

    Alert.alert(
      `Call ${firstName}`,
      `This will call ${firstName} through a masked number. Neither of you will see the other's real phone number. The call is not recorded.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Call Now',
          onPress: async (): Promise<void> => {
            setCallLoading(true);
            try {
              const endpoint = _callEndpoint(targetUserId, targetUserRole);
              const response = await api<AdHocCallResponse>(endpoint, {
                method: 'POST',
                body: JSON.stringify({ reason: 'Profile quick-call' }),
              });
              const remaining = response.rate_limit_remaining;
              _showToast(
                `Connecting your call to ${firstName}. ${remaining} call${remaining !== 1 ? 's' : ''} remaining today.`,
              );
            } catch (error: unknown) {
              const { message, isRateLimit, isForbidden } = _extractErrorMessage(error);
              if (isRateLimit) {
                _showToast(
                  `You've reached your daily call limit with ${firstName}. Try again tomorrow.`,
                );
              } else if (isForbidden) {
                _showToast(
                  `You don't have permission to call ${firstName} yet. A completed session is required.`,
                );
              } else {
                _showToast(`Call failed: ${message}`);
              }
            } finally {
              setCallLoading(false);
            }
          },
        },
      ],
    );
  }, [isRelationshipEstablished, targetUserId, targetUserRole, targetDisplayName]);

  // ── Message handler ───────────────────────────────────────────────────────────

  const handleMessagePress = useCallback(async (): Promise<void> => {
    if (!isRelationshipEstablished) {
      _showToast(
        'Messaging is only available after your first session together. Schedule a session to unlock direct contact.',
      );
      return;
    }

    setMessageLoading(true);
    try {
      const response = await api<ConversationResponse>(
        '/conversations/find-or-create',
        {
          method: 'POST',
          body: JSON.stringify({ peer_id: targetUserId }),
        },
      );
      onNavigateToConversation(response.id);
    } catch (error: unknown) {
      const { message } = _extractErrorMessage(error);
      _showToast(`Could not open conversation: ${message}`);
    } finally {
      setMessageLoading(false);
    }
  }, [isRelationshipEstablished, targetUserId, onNavigateToConversation]);

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <View style={styles.wrapper}>
      <View
        style={styles.actionRow}
        accessibilityRole="group"
        accessibilityLabel="Quick contact actions"
      >
        {/* ── Call button ── */}
        <TouchableOpacity
          style={[
            styles.actionBtn,
            isRelationshipEstablished ? styles.actionBtnActive : styles.actionBtnDisabled,
          ]}
          onPress={handleCallPress}
          disabled={callLoading}
          accessibilityRole="button"
          accessibilityLabel={
            isRelationshipEstablished
              ? `Call ${targetDisplayName}`
              : `Call ${targetDisplayName} — requires a shared session`
          }
          accessibilityState={{ disabled: callLoading || !isRelationshipEstablished }}
        >
          {callLoading ? (
            <ActivityIndicator
              size="small"
              color={isRelationshipEstablished ? colors.primary : '#94A3B8'}
            />
          ) : (
            <Phone
              size={16}
              color={isRelationshipEstablished ? colors.primary : '#94A3B8'}
            />
          )}
          <Text
            style={[
              styles.actionBtnText,
              isRelationshipEstablished
                ? styles.actionBtnTextActive
                : styles.actionBtnTextDisabled,
            ]}
          >
            Call
          </Text>
        </TouchableOpacity>

        {/* ── Message button ── */}
        <TouchableOpacity
          style={[
            styles.actionBtn,
            isRelationshipEstablished ? styles.actionBtnActive : styles.actionBtnDisabled,
          ]}
          onPress={handleMessagePress}
          disabled={messageLoading}
          accessibilityRole="button"
          accessibilityLabel={
            isRelationshipEstablished
              ? `Message ${targetDisplayName}`
              : `Message ${targetDisplayName} — requires a shared session`
          }
          accessibilityState={{ disabled: messageLoading || !isRelationshipEstablished }}
        >
          {messageLoading ? (
            <ActivityIndicator
              size="small"
              color={isRelationshipEstablished ? colors.primary : '#94A3B8'}
            />
          ) : (
            <MessageSquare
              size={16}
              color={isRelationshipEstablished ? colors.primary : '#94A3B8'}
            />
          )}
          <Text
            style={[
              styles.actionBtnText,
              isRelationshipEstablished
                ? styles.actionBtnTextActive
                : styles.actionBtnTextDisabled,
            ]}
          >
            Message
          </Text>
        </TouchableOpacity>
      </View>

      {/* ── Relationship-gate caption ── */}
      {!isRelationshipEstablished && (
        <Text style={styles.gateCaption} accessibilityRole="text">
          Direct contact unlocks after your first session together.
        </Text>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  wrapper: {
    gap: 8,
    marginBottom: 20,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 13,
    borderRadius: 13,
  },
  actionBtnActive: {
    backgroundColor: colors.primary + '15',
    borderWidth: 1,
    borderColor: colors.primary + '40',
  },
  actionBtnDisabled: {
    backgroundColor: '#F1F5F9',
    borderWidth: 1,
    borderColor: '#DDD6CC',
  },
  actionBtnText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
  },
  actionBtnTextActive: {
    color: colors.primary,
  },
  actionBtnTextDisabled: {
    color: '#94A3B8',
  },
  gateCaption: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#94A3B8',
    textAlign: 'center',
    fontStyle: 'italic',
  },
});
