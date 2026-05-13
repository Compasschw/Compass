/**
 * MemberMessagesScreen — single-thread view between a member and their CHW.
 *
 * Layout (matches member-messages.html mockup):
 *   - Header: CHW avatar (with online dot), name, "Active now" status,
 *             phone + calendar icon buttons, "View [CHW name]'s profile →" link
 *   - Messages thread: msg-me right green / msg-them left gray bubbles
 *   - Quick replies row: 4 preset chips
 *   - Composer: paperclip + textarea + Send button
 *   - Footer note: HIPAA compliance notice (TLS + at-rest, NOT E2E)
 *
 * Data wiring:
 *   - Assigned CHW: useSessions() — same pattern as MyCHWScreen.tsx.
 *     Latest session's chwId = "your CHW". No explicit assignment field exists.
 *   - Conversation / messages: useSessionMessages(latestSessionId) — polls 4s.
 *   - Send: useSessionSendMessage() with optimistic updates + rollback.
 *
 * If no session exists (no CHW assigned yet), shows a CTA to navigate to FindCHW.
 *
 * Hard constraint: do NOT claim "end-to-end encrypted" — TLS + at-rest is not E2E.
 */

import React, {
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
  Alert,
  ActivityIndicator,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import {
  Phone,
  CalendarPlus,
  Paperclip,
  Send,
  Lock,
  MessageSquare,
  CheckCircle,
  XCircle,
} from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';

import { AppShell } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import {
  useSessions,
  useSessionMessages,
  useSessionSendMessage,
  useStartCall,
  usePendingConsents,
  useApproveConsentRequest,
  useDenyConsentRequest,
  type SessionData,
  type SessionMessageLocal,
  type ConsentRequestData,
} from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';

// ─── Quick replies (hard-coded presentation) ──────────────────────────────────

const QUICK_REPLIES = [
  'Yes, that works',
  'Can we reschedule?',
  'I have a question',
  'Thank you 🙏',
] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getInitials(name: string | null | undefined): string {
  if (!name) return '??';
  return name
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();
}

function formatMessageTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDateSeparator(iso: string): string {
  const now = new Date();
  const d = new Date(iso);
  const diffDays = Math.floor(
    (now.setHours(0, 0, 0, 0) - d.setHours(0, 0, 0, 0)) / (1000 * 60 * 60 * 24),
  );
  if (diffDays === 0) {
    return `Today · ${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
  }
  if (diffDays === 1) return 'Yesterday';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function groupByDay(
  messages: SessionMessageLocal[],
): Array<{ key: string; messages: SessionMessageLocal[] }> {
  const buckets: Record<string, SessionMessageLocal[]> = {};
  for (const msg of messages) {
    const key = new Date(msg.createdAt).toDateString();
    (buckets[key] ??= []).push(msg);
  }
  return Object.entries(buckets).map(([key, msgs]) => ({ key, messages: msgs }));
}

// ─── Message bubble ───────────────────────────────────────────────────────────

interface BubbleProps {
  message: SessionMessageLocal;
  /** True when the message was sent by the member (current user). */
  isMe: boolean;
}

function MessageBubble({ message, isMe }: BubbleProps): React.JSX.Element {
  return (
    <View style={isMe ? styles.bubbleRowMe : styles.bubbleRowThem}>
      <View style={[styles.bubble, isMe ? styles.bubbleMe : styles.bubbleThem]}>
        {message.attachment ? (
          <View style={styles.attachmentRow}>
            <Paperclip size={14} color={isMe ? '#fff' : '#374151'} />
            <Text style={[styles.bubbleText, isMe ? styles.bubbleTextMe : styles.bubbleTextThem]}>
              {message.attachment.filename}
            </Text>
          </View>
        ) : (
          <Text style={[styles.bubbleText, isMe ? styles.bubbleTextMe : styles.bubbleTextThem]}>
            {message.body}
          </Text>
        )}
        <Text style={[styles.bubbleTime, isMe ? styles.bubbleTimeMe : styles.bubbleTimeThem]}>
          {formatMessageTime(message.createdAt)}
          {message.status === 'sending' ? ' · Sending…' : ''}
          {message.status === 'failed' ? ' · Failed to send' : ''}
        </Text>
      </View>
    </View>
  );
}

// ─── Inline toast ─────────────────────────────────────────────────────────────

interface MemberInlineToastProps {
  message: string;
  isError: boolean;
}

function MemberInlineToast({ message, isError }: MemberInlineToastProps): React.JSX.Element {
  return (
    <View
      style={[toastStyles.container, isError ? toastStyles.error : toastStyles.success]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Text style={[toastStyles.text, isError ? toastStyles.errorText : toastStyles.successText]}>
        {message}
      </Text>
    </View>
  );
}

const toastStyles = StyleSheet.create({
  container: {
    marginHorizontal: 16,
    marginBottom: 4,
    marginTop: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  success: {
    backgroundColor: '#f0fdf4',
    borderColor: '#bbf7d0',
  },
  error: {
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca',
  },
  text: {
    fontSize: 13,
    fontWeight: '500',
  },
  successText: { color: '#15803d' },
  errorText: { color: '#dc2626' },
});

// ─── Consent request banner ────────────────────────────────────────────────────

interface ConsentBannerProps {
  chwName: string | null;
  isPendingApprove: boolean;
  isPendingDeny: boolean;
  onAllow: () => void;
  onDeny: () => void;
}

/**
 * Banner shown above the conversation thread when the CHW has requested
 * permission to record the session for AI notes.
 *
 * Mirrors the consent request UI from SessionChat for the member side.
 * Uses the CHW's first name for personalization; falls back to "Your CHW".
 */
function ConsentBanner({
  chwName,
  isPendingApprove,
  isPendingDeny,
  onAllow,
  onDeny,
}: ConsentBannerProps): React.JSX.Element {
  const chwFirstName = chwName?.split(' ')[0] ?? 'Your CHW';
  const isLoading = isPendingApprove || isPendingDeny;

  return (
    <View style={consentBannerStyles.container} accessibilityRole="alert">
      <Text style={consentBannerStyles.message}>
        {chwFirstName} has requested permission to record this session for AI notes.
      </Text>
      <View style={consentBannerStyles.actions}>
        <TouchableOpacity
          style={[consentBannerStyles.allowBtn, isLoading && consentBannerStyles.btnDisabled]}
          onPress={onAllow}
          disabled={isLoading}
          accessibilityRole="button"
          accessibilityLabel="Allow recording"
          accessibilityState={{ disabled: isLoading }}
        >
          {isPendingApprove ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <CheckCircle size={14} color="#fff" />
          )}
          <Text style={consentBannerStyles.allowBtnText}>Allow</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[consentBannerStyles.denyBtn, isLoading && consentBannerStyles.btnDisabled]}
          onPress={onDeny}
          disabled={isLoading}
          accessibilityRole="button"
          accessibilityLabel="Deny recording"
          accessibilityState={{ disabled: isLoading }}
        >
          {isPendingDeny ? (
            <ActivityIndicator size="small" color="#374151" />
          ) : (
            <XCircle size={14} color="#374151" />
          )}
          <Text style={consentBannerStyles.denyBtnText}>Deny</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const consentBannerStyles = StyleSheet.create({
  container: {
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#fefce8',
    borderWidth: 1,
    borderColor: '#fde68a',
    gap: 10,
  } as ViewStyle,
  message: {
    fontSize: 14,
    color: '#92400E',
    lineHeight: 20,
  } as TextStyle,
  actions: {
    flexDirection: 'row',
    gap: 8,
  } as ViewStyle,
  allowBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#059669',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  } as ViewStyle,
  allowBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#fff',
  } as TextStyle,
  denyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#F3F4F6',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  } as ViewStyle,
  denyBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
  } as TextStyle,
  btnDisabled: {
    opacity: 0.6,
  } as ViewStyle,
});

// ─── No CHW yet state ─────────────────────────────────────────────────────────

interface NoCHWStateProps {
  onFindCHW: () => void;
  userBlock: { initials: string; name: string; role: 'Member' };
}

function NoCHWState({ onFindCHW, userBlock }: NoCHWStateProps): React.JSX.Element {
  return (
    <AppShell role="member" activeKey="messages" userBlock={userBlock}>
      <View style={styles.noCHWWrap}>
        <MessageSquare size={40} color="#9CA3AF" />
        <Text style={styles.noCHWTitle}>No CHW assigned yet</Text>
        <Text style={styles.noCHWSub}>
          You don't have a Community Health Worker yet. Find one to start messaging.
        </Text>
        <TouchableOpacity
          style={styles.findCHWBtn}
          onPress={onFindCHW}
          accessibilityRole="button"
          accessibilityLabel="Find a Community Health Worker"
        >
          <Text style={styles.findCHWBtnText}>Find a CHW →</Text>
        </TouchableOpacity>
      </View>
    </AppShell>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

/**
 * MemberMessagesScreen — the member's single-thread view with their CHW.
 *
 * Exported and wired into MemberTabNavigator as the root of the Sessions tab.
 */
export function MemberMessagesScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const navigation = useNavigation<any>(); // eslint-disable-line @typescript-eslint/no-explicit-any

  const [draftText, setDraftText] = useState('');
  const [localMessages, setLocalMessages] = useState<SessionMessageLocal[]>([]);
  const [callInitiating, setCallInitiating] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastIsError, setToastIsError] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const sessionsQuery = useSessions();
  const sendMessage = useSessionSendMessage();
  const startCall = useStartCall();
  const approveConsentRequest = useApproveConsentRequest();
  const denyConsentRequest = useDenyConsentRequest();

  const memberInitials = (userName ?? 'M')
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  const shellUserBlock = {
    initials: memberInitials,
    name: userName ?? 'Member',
    role: 'Member' as const,
  };

  // Resolve assigned CHW — same logic as MyCHWScreen.tsx
  const latestSession = useMemo<SessionData | null>(() => {
    const sessions = sessionsQuery.data ?? [];
    if (sessions.length === 0) return null;
    return [...sessions].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    )[0] ?? null;
  }, [sessionsQuery.data]);

  const chwName = latestSession?.chwName ?? null;
  const chwInitials = getInitials(chwName);
  const sessionId = latestSession?.id ?? '';

  const messagesQuery = useSessionMessages(sessionId);

  // ── Poll for pending consent requests (CHW asking for recording permission) ───
  // Polls every 3s while the session is in_progress, matching SessionChat behavior.
  const pendingConsentsQuery = usePendingConsents(sessionId, {
    enabled: latestSession?.status === 'in_progress' && sessionId.length > 0,
  });
  const pendingConsent: ConsentRequestData | null =
    (pendingConsentsQuery.data ?? [])[0] ?? null;

  // ── Toast helper ──────────────────────────────────────────────────────────────
  const showToast = useCallback((message: string, isError: boolean) => {
    setToastMessage(message);
    setToastIsError(isError);
    const timer = setTimeout(() => setToastMessage(null), 3_500);
    return () => clearTimeout(timer);
  }, []);

  // ── Call handler (mirrors SessionChat.handleCall) ─────────────────────────────
  /**
   * Initiates a Vonage masked-number call between member and their assigned CHW.
   * Vonage handles the masked-number routing automatically on the server side.
   */
  const handleCall = useCallback(async () => {
    if (callInitiating || !sessionId) return;
    const chwFirstName = chwName?.split(' ')[0] ?? 'your CHW';

    const doCall = async (): Promise<void> => {
      setCallInitiating(true);
      try {
        await startCall.mutateAsync(sessionId);
        showToast('Calling now — both phones will ring.', false);
      } catch (err) {
        const detail =
          err instanceof Error && err.message
            ? err.message
            : 'Could not start the call. Try again.';
        showToast(detail, true);
      } finally {
        setCallInitiating(false);
      }
    };

    // Web uses window.confirm; native uses Alert.alert
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const ok = window.confirm(`Start a call with ${chwFirstName}?`);
      if (ok) void doCall();
    } else {
      Alert.alert(
        'Start call?',
        `Start a masked call with ${chwFirstName}? Both phones will ring.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Call', onPress: () => void doCall() },
        ],
      );
    }
  }, [callInitiating, sessionId, chwName, startCall, showToast]);

  // ── Consent approval/denial handlers ─────────────────────────────────────────
  const handleApproveConsent = useCallback(async () => {
    if (!pendingConsent) return;
    try {
      // typedSignature: member's name serves as the HIPAA digital signature
      await approveConsentRequest.mutateAsync({
        requestId: pendingConsent.id,
        typedSignature: userName ?? 'Member',
      });
      showToast('Recording approved.', false);
    } catch {
      showToast('Could not approve. Please try again.', true);
    }
  }, [pendingConsent, approveConsentRequest, userName, showToast]);

  const handleDenyConsent = useCallback(async () => {
    if (!pendingConsent) return;
    try {
      await denyConsentRequest.mutateAsync(pendingConsent.id);
      showToast('Recording declined.', false);
    } catch {
      showToast('Could not submit response. Please try again.', true);
    }
  }, [pendingConsent, denyConsentRequest, showToast]);

  // Merge server + local optimistic messages
  const mergedMessages = useMemo<SessionMessageLocal[]>(() => {
    const server: SessionMessageLocal[] = (messagesQuery.data ?? []).map((m) => ({ ...m }));
    const serverIds = new Set(server.map((m) => m.id));
    const pendingLocal = localMessages.filter((m) => !serverIds.has(m.id));
    return [...server, ...pendingLocal].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
  }, [messagesQuery.data, localMessages]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, [mergedMessages.length]);

  const handleSend = useCallback(async () => {
    const trimmed = draftText.trim();
    if (!trimmed || !sessionId) return;

    const optimisticId = `local-${Date.now()}`;
    const optimistic: SessionMessageLocal = {
      id: optimisticId,
      senderUserId: '',
      senderRole: 'member',
      body: trimmed,
      type: 'text',
      createdAt: new Date().toISOString(),
      status: 'sending',
    };
    setLocalMessages((prev) => [...prev, optimistic]);
    setDraftText('');

    try {
      await sendMessage.mutateAsync({ sessionId, body: trimmed });
      setLocalMessages((prev) => prev.filter((m) => m.id !== optimisticId));
    } catch {
      setLocalMessages((prev) =>
        prev.map((m) =>
          m.id === optimisticId ? { ...m, status: 'failed' as const } : m,
        ),
      );
    }
  }, [draftText, sessionId, sendMessage]);

  const handleQuickReply = useCallback(
    (text: string) => {
      setDraftText(text);
    },
    [],
  );

  const handleFindCHW = useCallback(() => {
    navigation.navigate('FindCHW');
  }, [navigation]);

  // ── Loading state ─────────────────────────────────────────────────────────
  if (sessionsQuery.isLoading) {
    return (
      <AppShell role="member" activeKey="messages" userBlock={shellUserBlock} disableMainScroll>
        <View style={styles.loadingWrap}>
          <LoadingSkeleton variant="card" />
          <LoadingSkeleton variant="rows" rows={4} />
        </View>
      </AppShell>
    );
  }

  if (sessionsQuery.error) {
    return (
      <AppShell role="member" activeKey="messages" userBlock={shellUserBlock}>
        <ErrorState
          message="Could not load your messages. Please try again."
          onRetry={() => void sessionsQuery.refetch()}
        />
      </AppShell>
    );
  }

  // ── No CHW state ─────────────────────────────────────────────────────────
  if (!latestSession) {
    return <NoCHWState onFindCHW={handleFindCHW} userBlock={shellUserBlock} />;
  }

  const grouped = groupByDay(mergedMessages);

  return (
    <AppShell role="member" activeKey="messages" userBlock={shellUserBlock} disableMainScroll>
      <View style={styles.root}>
        {/* Conversation header */}
        <View style={styles.header} accessibilityRole="banner">
          {/* CHW avatar with online dot */}
          <View style={styles.avatarWrap}>
            <View style={styles.avatar48}>
              <Text style={styles.avatarText48}>{chwInitials}</Text>
            </View>
            <View style={styles.onlineDot} accessibilityLabel="Online" />
          </View>

          <View style={styles.headerInfo}>
            <Text style={styles.headerName}>{chwName ?? 'Your CHW'}</Text>
            <Text style={styles.headerStatus}>● Active now · Reply within 2h typically</Text>
          </View>

          {/* Phone button — initiates Vonage masked-number call to CHW */}
          <TouchableOpacity
            style={[styles.iconBtn, callInitiating && styles.iconBtnDisabled]}
            onPress={() => void handleCall()}
            disabled={callInitiating}
            accessibilityRole="button"
            accessibilityLabel={callInitiating ? 'Call initiating…' : 'Call your CHW'}
            accessibilityState={{ disabled: callInitiating }}
          >
            {callInitiating ? (
              <ActivityIndicator size="small" color="#6B7280" />
            ) : (
              <Phone size={20} color="#6B7280" />
            )}
          </TouchableOpacity>

          {/* CalendarPlus button — navigate to the member's Calendar tab */}
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={() => navigation.navigate('Calendar')}
            accessibilityRole="button"
            accessibilityLabel="Go to appointments"
          >
            <CalendarPlus size={20} color="#6B7280" />
          </TouchableOpacity>

          {chwName ? (
            <TouchableOpacity
              style={styles.profileLink}
              onPress={() => navigation.navigate('FindCHW')}
              accessibilityRole="link"
              accessibilityLabel={`View ${chwName}'s profile`}
            >
              <Text style={styles.profileLinkText}>View {chwName.split(' ')[0]}'s profile →</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {/* Inline toast — success/error feedback */}
        {toastMessage !== null ? (
          <MemberInlineToast message={toastMessage} isError={toastIsError} />
        ) : null}

        {/* Consent request banner — shown when CHW has requested recording permission */}
        {pendingConsent !== null ? (
          <ConsentBanner
            chwName={chwName}
            isPendingApprove={approveConsentRequest.isPending}
            isPendingDeny={denyConsentRequest.isPending}
            onAllow={() => void handleApproveConsent()}
            onDeny={() => void handleDenyConsent()}
          />
        ) : null}

        {/* Messages thread */}
        <ScrollView
          ref={scrollRef}
          style={styles.messagesScroll}
          contentContainerStyle={styles.messagesContent}
          showsVerticalScrollIndicator={false}
          accessibilityRole="list"
          accessibilityLabel="Message thread"
        >
          {messagesQuery.isLoading ? (
            <LoadingSkeleton variant="rows" rows={5} />
          ) : messagesQuery.error ? (
            <ErrorState
              message="Could not load messages."
              onRetry={() => void messagesQuery.refetch()}
            />
          ) : grouped.length === 0 ? (
            <View style={styles.emptyMessages}>
              <Text style={styles.emptyMessagesText}>
                No messages yet. Send a message to get started!
              </Text>
            </View>
          ) : (
            grouped.map(({ key, messages: dayMsgs }) => (
              <View key={key}>
                <View style={styles.dateSeparatorRow}>
                  <Text style={styles.dateSeparatorText}>
                    {formatDateSeparator(dayMsgs[0]?.createdAt ?? key)}
                  </Text>
                </View>
                {dayMsgs.map((msg) => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    isMe={msg.senderRole === 'member'}
                  />
                ))}
              </View>
            ))
          )}
        </ScrollView>

        {/* Quick replies */}
        <View
          style={styles.quickRepliesBar}
          accessibilityRole="toolbar"
          accessibilityLabel="Quick reply options"
        >
          <Text style={styles.quickRepliesLabel}>Quick replies:</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.quickRepliesScroll}
          >
            {QUICK_REPLIES.map((reply) => (
              <TouchableOpacity
                key={reply}
                style={styles.quickReplyChip}
                onPress={() => handleQuickReply(reply)}
                accessibilityRole="button"
                accessibilityLabel={`Quick reply: ${reply}`}
              >
                <Text style={styles.quickReplyText}>{reply}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        {/* Composer */}
        <View style={styles.composerWrap}>
          <View style={styles.composerInner}>
            <TouchableOpacity
              style={styles.composerIconBtn}
              accessibilityRole="button"
              accessibilityLabel="Attach a file"
            >
              <Paperclip size={20} color="#6B7280" />
            </TouchableOpacity>
            <TextInput
              style={styles.composerInput}
              value={draftText}
              onChangeText={setDraftText}
              placeholder={`Reply to ${chwName ?? 'your CHW'}…`}
              placeholderTextColor="#9CA3AF"
              multiline
              numberOfLines={2}
              accessibilityLabel="Message input"
            />
            <TouchableOpacity
              style={[styles.sendBtn, !draftText.trim() && styles.sendBtnDisabled]}
              onPress={() => void handleSend()}
              disabled={!draftText.trim() || sendMessage.isPending}
              accessibilityRole="button"
              accessibilityLabel="Send message"
            >
              <Send size={16} color="#fff" />
              <Text style={styles.sendBtnText}>Send</Text>
            </TouchableOpacity>
          </View>

          {/* HIPAA note — NOT "end-to-end encrypted": TLS+at-rest only */}
          <View style={styles.hipaaNote}>
            <Lock size={12} color="#9CA3AF" />
            <Text style={styles.hipaaText}>
              Messages are encrypted and HIPAA-compliant
            </Text>
          </View>
        </View>
      </View>
    </AppShell>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    flexDirection: 'column',
    backgroundColor: '#fff',
    overflow: 'hidden',
  } as ViewStyle,
  loadingWrap: {
    padding: 24,
    gap: 16,
  } as ViewStyle,

  // No CHW
  noCHWWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    padding: 32,
  } as ViewStyle,
  noCHWTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111827',
  } as TextStyle,
  noCHWSub: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 20,
  } as TextStyle,
  findCHWBtn: {
    marginTop: 8,
    backgroundColor: '#059669',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
  } as ViewStyle,
  findCHWBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fff',
  } as TextStyle,

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
    backgroundColor: '#fff',
  } as ViewStyle,
  avatarWrap: {
    position: 'relative',
    flexShrink: 0,
  } as ViewStyle,
  avatar48: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#059669',
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  avatarText48: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  } as TextStyle,
  onlineDot: {
    position: 'absolute',
    bottom: 1,
    right: 1,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#10B981',
    borderWidth: 2,
    borderColor: '#fff',
  } as ViewStyle,
  headerInfo: {
    flex: 1,
    minWidth: 0,
  } as ViewStyle,
  headerName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
  } as TextStyle,
  headerStatus: {
    fontSize: 12,
    fontWeight: '600',
    color: '#059669',
    marginTop: 1,
  } as TextStyle,
  iconBtn: {
    padding: 8,
    borderRadius: 8,
  } as ViewStyle,
  iconBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,
  profileLink: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
  } as ViewStyle,
  profileLinkText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
  } as TextStyle,

  // Messages
  messagesScroll: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  } as ViewStyle,
  messagesContent: {
    padding: 20,
    gap: 4,
  } as ViewStyle,
  emptyMessages: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 48,
  } as ViewStyle,
  emptyMessagesText: {
    fontSize: 14,
    color: '#9CA3AF',
    textAlign: 'center',
    lineHeight: 20,
  } as TextStyle,
  dateSeparatorRow: {
    alignItems: 'center',
    marginVertical: 12,
  } as ViewStyle,
  dateSeparatorText: {
    fontSize: 12,
    color: '#9CA3AF',
  } as TextStyle,
  bubbleRowMe: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: 6,
  } as ViewStyle,
  bubbleRowThem: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    marginBottom: 6,
  } as ViewStyle,
  bubble: {
    maxWidth: '75%',
    padding: 10,
    paddingHorizontal: 14,
    gap: 4,
  } as ViewStyle,
  bubbleMe: {
    backgroundColor: '#10B981',
    borderRadius: 18,
    borderBottomRightRadius: 4,
  } as ViewStyle,
  bubbleThem: {
    backgroundColor: '#F3F4F6',
    borderRadius: 18,
    borderBottomLeftRadius: 4,
  } as ViewStyle,
  bubbleText: {
    fontSize: 14,
    lineHeight: 20,
  } as TextStyle,
  bubbleTextMe: {
    color: '#fff',
  } as TextStyle,
  bubbleTextThem: {
    color: '#111827',
  } as TextStyle,
  bubbleTime: {
    fontSize: 10,
    marginTop: 2,
  } as TextStyle,
  bubbleTimeMe: {
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'right',
  } as TextStyle,
  bubbleTimeThem: {
    color: '#9CA3AF',
  } as TextStyle,
  attachmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  } as ViewStyle,

  // Quick replies
  quickRepliesBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    gap: 10,
  } as ViewStyle,
  quickRepliesLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#9CA3AF',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    flexShrink: 0,
  } as TextStyle,
  quickRepliesScroll: {
    flexDirection: 'row',
    gap: 8,
  } as ViewStyle,
  quickReplyChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#fff',
  } as ViewStyle,
  quickReplyText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#374151',
  } as TextStyle,

  // Composer
  composerWrap: {
    padding: 14,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
  } as ViewStyle,
  composerInner: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 16,
    padding: 10,
  } as ViewStyle,
  composerIconBtn: {
    padding: 6,
    borderRadius: 8,
  } as ViewStyle,
  composerInput: {
    flex: 1,
    fontSize: 14,
    color: '#111827',
    paddingVertical: 6,
    minHeight: 36,
    maxHeight: 100,
    outlineStyle: 'none',
  } as TextStyle,
  sendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#059669',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 12,
  } as ViewStyle,
  sendBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,
  sendBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  } as TextStyle,

  // HIPAA footer note
  hipaaNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    marginTop: 8,
  } as ViewStyle,
  hipaaText: {
    fontSize: 12,
    color: '#9CA3AF',
    textAlign: 'center',
  } as TextStyle,
});
