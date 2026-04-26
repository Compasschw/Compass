/**
 * SessionChatWithFollowup — wraps SessionChat and adds the post-session
 * "Review extracted items" CTA for CHW users.
 *
 * This component owns the extraction + navigation logic so SessionChat itself
 * stays narrowly focused on messaging. The CTA renders below the chat thread
 * and above the keyboard area once session.status === "completed".
 *
 * HIPAA: no session content is included in any log or error message here.
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { ClipboardList } from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { SessionChat } from './SessionChat';
import { useSession } from '../../hooks/useApiQueries';
import { useExtractSessionFollowups } from '../../hooks/useFollowupQueries';
import { useAuth } from '../../context/AuthContext';
import { colors } from '../../theme/colors';
import { fonts } from '../../theme/typography';
import type { CHWSessionsStackParamList } from '../../navigation/CHWTabNavigator';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface SessionChatWithFollowupProps {
  sessionId: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Drop-in replacement for SessionChat in CHW contexts.
 * Member contexts should continue to use SessionChat directly.
 */
export function SessionChatWithFollowup({
  sessionId,
}: SessionChatWithFollowupProps): React.JSX.Element {
  const { userRole } = useAuth();
  const isCHW = userRole === 'chw';

  const sessionQuery = useSession(sessionId);
  const session = sessionQuery.data;
  const isCompleted = session?.status === 'completed';

  const extractFollowups = useExtractSessionFollowups();
  const navigation = useNavigation<NativeStackNavigationProp<CHWSessionsStackParamList>>();
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractError, setExtractError] = useState(false);

  const handleReviewFollowups = useCallback(async () => {
    if (isExtracting) return;
    setIsExtracting(true);
    setExtractError(false);
    try {
      await extractFollowups.mutateAsync(sessionId);
      navigation.navigate('SessionReview', {
        sessionId,
        memberName: session?.memberName ?? 'Member',
      });
    } catch {
      // HIPAA: error is generic — no session content logged.
      setExtractError(true);
    } finally {
      setIsExtracting(false);
    }
  }, [isExtracting, extractFollowups, sessionId, session, navigation]);

  return (
    <View style={s.flex}>
      {/* Chat fills remaining space */}
      <SessionChat sessionId={sessionId} />

      {/* CTA — only visible to CHW when session is complete */}
      {isCHW && isCompleted ? (
        <View style={s.ctaWrapper}>
          {extractError ? (
            <Text style={s.errorText}>
              Could not extract items. Tap to try again.
            </Text>
          ) : null}
          <TouchableOpacity
            style={[s.ctaBtn, isExtracting && s.ctaBtnLoading]}
            onPress={() => { void handleReviewFollowups(); }}
            disabled={isExtracting}
            accessibilityRole="button"
            accessibilityLabel="Extract and review follow-up items from this session"
            activeOpacity={0.8}
          >
            {isExtracting ? (
              <ActivityIndicator size="small" color={colors.primaryForeground} />
            ) : (
              <ClipboardList size={16} color={colors.primaryForeground} />
            )}
            <Text style={s.ctaText}>
              {isExtracting ? 'Extracting items…' : 'Review extracted items'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  flex: { flex: 1 },
  ctaWrapper: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: Platform.OS === 'ios' ? 4 : 8,
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 6,
  },
  ctaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 12,
  },
  ctaBtnLoading: {
    opacity: 0.75,
  },
  ctaText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: colors.primaryForeground,
  },
  errorText: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.destructive,
    textAlign: 'center',
  },
});
