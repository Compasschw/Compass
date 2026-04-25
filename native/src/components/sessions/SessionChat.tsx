/**
 * SessionChat — real-time(-ish) in-session chat for CompassCHW (Phase 1).
 *
 * Wired to the session-scoped backend endpoints:
 *   GET  /sessions/{session_id}/messages?after=<id>  — cursor-based poll (4 s)
 *   POST /sessions/{session_id}/messages             — send text message
 *   POST /sessions/{session_id}/messages/read        — mark read (side effect only)
 *   POST /sessions/{session_id}/call                 — initiate Vonage masked call
 *
 * Features:
 *   - Message bubbles: own messages right-aligned (primary colour), other left (neutral)
 *   - Sender label above each bubble ("You" / their name from session data)
 *   - Relative timestamp below each bubble ("2m ago" / "12:34 PM")
 *   - Auto-scroll to bottom on mount and on new messages
 *   - Polling every 4 s via refetchInterval (only while the modal is mounted)
 *   - Optimistic send: bubble appears immediately; replaced on server response;
 *     "failed" state with retry tap on error
 *   - 1000-character limit with counter shown in the last 100 characters
 *   - Phone icon (lucide Phone) in header — calls Vonage bridge, shows inline toast
 *   - Read receipts fired when modal opens and when new messages arrive
 *   - Works for both CHW and Member perspectives based on auth context
 *
 * HIPAA: message bodies are never logged, never included in analytics events,
 * and error objects have their `body` field redacted before bubbling.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { MessageSquare, Phone, Send } from 'lucide-react-native';

import { useAuth } from '../../context/AuthContext';
import {
  useSession,
  useSessionMessages,
  useSessionSendMessage,
  useSessionMarkRead,
  useStartCall,
  type SessionMessageLocal,
} from '../../hooks/useApiQueries';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_CHARS = 1000;
const COUNTER_THRESHOLD = 100; // show counter when within this many chars of the limit

/** Session statuses that allow initiating a call. */
const CALLABLE_STATUSES = new Set(['scheduled', 'in_progress']);

// ─── Timestamp formatter ──────────────────────────────────────────────────────

/**
 * Returns a relative label ("2m ago", "Just now") or a clock time ("12:34 PM")
 * depending on how old the message is.
 */
function formatRelativeTime(isoString: string): string {
  try {
    const delta = Date.now() - new Date(isoString).getTime();
    const seconds = Math.floor(delta / 1000);
    if (seconds < 30) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    // Older than 1 hour — show wall-clock time
    return new Date(isoString).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

// ─── Inline toast ─────────────────────────────────────────────────────────────

interface InlineToastProps {
  message: string;
  isError: boolean;
}

function InlineToast({ message, isError }: InlineToastProps): React.JSX.Element {
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
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  success: {
    backgroundColor: `${colors.primary}10`,
    borderColor: `${colors.primary}40`,
  },
  error: {
    backgroundColor: `${colors.destructive}10`,
    borderColor: `${colors.destructive}40`,
  },
  text: {
    ...typography.bodySm,
    fontWeight: '500',
  },
  successText: { color: colors.primary },
  errorText: { color: colors.destructive },
});

// ─── MessageBubble ────────────────────────────────────────────────────────────

interface MessageBubbleProps {
  message: SessionMessageLocal;
  isOwn: boolean;
  /** Display name shown above the bubble for the other party. */
  otherPartyName: string;
  onRetry: (message: SessionMessageLocal) => void;
}

function MessageBubble({
  message,
  isOwn,
  otherPartyName,
  onRetry,
}: MessageBubbleProps): React.JSX.Element {
  const isFailed = message.status === 'failed';
  const isSending = message.status === 'sending';

  return (
    <View style={[b.wrapper, isOwn ? b.wrapperOwn : b.wrapperOther]}>
      {/* Sender label */}
      <Text style={[b.senderLabel, isOwn ? b.senderLabelOwn : b.senderLabelOther]}>
        {isOwn ? 'You' : otherPartyName}
      </Text>

      {/* Bubble */}
      <TouchableOpacity
        disabled={!isFailed}
        onPress={() => isFailed && onRetry(message)}
        activeOpacity={0.75}
        accessibilityRole={isFailed ? 'button' : undefined}
        accessibilityLabel={isFailed ? 'Message failed. Tap to retry.' : undefined}
        accessibilityHint={isFailed ? 'Double-tap to resend this message.' : undefined}
      >
        <View
          style={[
            b.bubble,
            isOwn ? b.bubbleOwn : b.bubbleOther,
            isFailed && b.bubbleFailed,
          ]}
        >
          <Text style={[b.bodyText, isOwn ? b.textOwn : b.textOther]}>
            {message.body}
          </Text>
          {isFailed && (
            <Text style={b.retryHint}>Tap to retry</Text>
          )}
        </View>
      </TouchableOpacity>

      {/* Timestamp row */}
      <View style={[b.metaRow, isOwn ? b.metaRowOwn : b.metaRowOther]}>
        {isSending && (
          <ActivityIndicator size="small" color={colors.mutedForeground} style={b.sendingIndicator} />
        )}
        <Text style={[b.timestamp, isOwn ? b.timestampOwn : b.timestampOther]}>
          {isSending ? 'Sending…' : formatRelativeTime(message.createdAt)}
        </Text>
      </View>
    </View>
  );
}

const b = StyleSheet.create({
  wrapper: {
    maxWidth: '80%',
    marginBottom: 14,
    gap: 3,
  },
  wrapperOwn: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  wrapperOther: { alignSelf: 'flex-start', alignItems: 'flex-start' },

  senderLabel: {
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 2,
    paddingHorizontal: 4,
  },
  senderLabelOwn: { color: colors.mutedForeground, textAlign: 'right' },
  senderLabelOther: { color: colors.mutedForeground, textAlign: 'left' },

  bubble: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
  },
  bubbleOwn: {
    backgroundColor: colors.primary,
    borderBottomRightRadius: 4,
  },
  bubbleOther: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomLeftRadius: 4,
  },
  bubbleFailed: {
    opacity: 0.65,
  },

  bodyText: { ...typography.bodySm, lineHeight: 20 },
  textOwn: { color: colors.primaryForeground },
  textOther: { color: colors.foreground },

  retryHint: {
    marginTop: 4,
    fontSize: 10,
    fontWeight: '700',
    color: colors.destructive,
  },

  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 4,
  },
  metaRowOwn: { justifyContent: 'flex-end' },
  metaRowOther: { justifyContent: 'flex-start' },

  timestamp: { fontSize: 10, color: colors.mutedForeground },
  timestampOwn: { textAlign: 'right' },
  timestampOther: { textAlign: 'left' },

  sendingIndicator: { width: 10, height: 10 },
});

// ─── Main component ───────────────────────────────────────────────────────────

export interface SessionChatProps {
  /** The session UUID — used directly against the session-scoped endpoints. */
  sessionId: string;
}

/**
 * Session chat thread component.
 *
 * Handles both CHW and Member perspectives: the `senderRole` field returned by
 * the API determines bubble alignment without needing a user-ID comparison.
 *
 * Optimistic updates:
 *   1. On send: append a local message with status="sending" and a temp ID.
 *   2. On success: replace the optimistic entry with the server-returned row.
 *   3. On failure: mark the entry status="failed"; user can tap to retry.
 *   The server poll (refetchInterval: 4s) continues running in the background
 *   and will eventually overwrite the local list with the authoritative state.
 */
export function SessionChat({ sessionId }: SessionChatProps): React.JSX.Element {
  const { userRole, userName } = useAuth();

  const [inputValue, setInputValue] = useState('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastIsError, setToastIsError] = useState(false);
  const [callInitiating, setCallInitiating] = useState(false);

  /**
   * Local optimistic message list. Starts empty; gets merged with server data.
   * We keep optimistic entries until the server confirms them (or until the
   * next successful poll replaces the whole list).
   */
  const [optimisticMessages, setOptimisticMessages] = useState<SessionMessageLocal[]>([]);

  const listRef = useRef<FlatList<SessionMessageLocal>>(null);

  // ── Data queries ────────────────────────────────────────────────────────────

  const sessionQuery = useSession(sessionId);
  const session = sessionQuery.data;

  const messagesQuery = useSessionMessages(sessionId);
  const sendMessage = useSessionSendMessage();
  const markRead = useSessionMarkRead();
  const startCall = useStartCall();

  // ── Derived state ────────────────────────────────────────────────────────────

  const myRole = userRole ?? 'member';
  const isCallable = session ? CALLABLE_STATUSES.has(session.status) : false;

  /**
   * Resolve the display name of the other party based on auth role and
   * session data. Falls back to "CHW" / "Member" if the name isn't populated.
   */
  const otherPartyName = useMemo<string>(() => {
    if (!session) return myRole === 'chw' ? 'Member' : 'CHW';
    return myRole === 'chw'
      ? (session.memberName ?? 'Member')
      : (session.chwName ?? 'CHW');
  }, [session, myRole]);

  /**
   * Merge server messages with optimistic entries.
   * Server messages take precedence: if the server has confirmed a message ID
   * that exists optimistically, the optimistic entry is dropped.
   * Optimistic "sending"/"failed" entries without a server counterpart are
   * appended at the end.
   */
  const serverMessages = useMemo<SessionMessageLocal[]>(
    () => (messagesQuery.data ?? []) as SessionMessageLocal[],
    [messagesQuery.data],
  );

  const mergedMessages = useMemo<SessionMessageLocal[]>(() => {
    if (optimisticMessages.length === 0) return serverMessages;

    const serverIds = new Set(serverMessages.map((m) => m.id));
    const pendingOptimistic = optimisticMessages.filter((m) => !serverIds.has(m.id));
    return [...serverMessages, ...pendingOptimistic];
  }, [serverMessages, optimisticMessages]);

  // ── Read receipts ────────────────────────────────────────────────────────────

  /**
   * Fire read receipt side effect. Runs when the messages list changes and
   * there are confirmed server messages to mark.
   * HIPAA: only the message ID is sent — no body content.
   */
  const lastServerMessageId = serverMessages[serverMessages.length - 1]?.id;
  const lastMarkedIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!lastServerMessageId) return;
    if (lastMarkedIdRef.current === lastServerMessageId) return;

    lastMarkedIdRef.current = lastServerMessageId;
    markRead.mutate({ sessionId, upToMessageId: lastServerMessageId });
  }, [sessionId, lastServerMessageId, markRead]);

  // ── Auto-scroll ──────────────────────────────────────────────────────────────

  const scrollToBottom = useCallback((animated: boolean) => {
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated });
    });
  }, []);

  // Scroll to bottom on initial load (non-animated) and on new messages (animated)
  const prevMessageCountRef = useRef(0);
  useEffect(() => {
    const count = mergedMessages.length;
    if (count === 0) return;

    const isInitialLoad = prevMessageCountRef.current === 0;
    scrollToBottom(!isInitialLoad);
    prevMessageCountRef.current = count;
  }, [mergedMessages.length, scrollToBottom]);

  // ── Toast helpers ────────────────────────────────────────────────────────────

  const showToast = useCallback((message: string, isError: boolean) => {
    setToastMessage(message);
    setToastIsError(isError);
    const timer = setTimeout(() => setToastMessage(null), 3_500);
    return () => clearTimeout(timer);
  }, []);

  // ── Send handler ─────────────────────────────────────────────────────────────

  const handleSend = useCallback(async () => {
    const trimmed = inputValue.trim();
    if (!trimmed || sendMessage.isPending) return;

    const tempId = `optimistic_${Date.now()}`;
    const optimisticEntry: SessionMessageLocal = {
      id: tempId,
      senderUserId: '',          // unknown client-side; server provides authoritative
      senderRole: myRole as 'chw' | 'member',
      body: trimmed,
      createdAt: new Date().toISOString(),
      status: 'sending',
    };

    // 1. Append optimistic entry immediately
    setOptimisticMessages((prev) => [...prev, optimisticEntry]);
    setInputValue('');

    try {
      // 2. Fire request; get back authoritative row
      const confirmed = await sendMessage.mutateAsync({ sessionId, body: trimmed });

      // 3. Replace optimistic entry with confirmed row (status=undefined → confirmed)
      setOptimisticMessages((prev) =>
        prev
          .filter((m) => m.id !== tempId)
          .concat({ ...confirmed, status: undefined }),
      );
    } catch {
      // 4. Mark as failed. HIPAA: do not include the body in any error log.
      setOptimisticMessages((prev) =>
        prev.map((m) =>
          m.id === tempId ? { ...m, status: 'failed' } : m,
        ),
      );
    }
  }, [inputValue, sessionId, myRole, sendMessage]);

  // ── Retry handler ────────────────────────────────────────────────────────────

  const handleRetry = useCallback(
    (failedMessage: SessionMessageLocal) => {
      // Remove the failed entry and re-populate the input for the user to resend
      setOptimisticMessages((prev) => prev.filter((m) => m.id !== failedMessage.id));
      setInputValue(failedMessage.body);
    },
    [],
  );

  // ── Call handler ─────────────────────────────────────────────────────────────

  const handleCall = useCallback(async () => {
    if (!isCallable || callInitiating) return;
    setCallInitiating(true);
    try {
      await startCall.mutateAsync(sessionId);
      showToast('Calling now — both your phones will ring.', false);
    } catch (err) {
      const detail =
        err instanceof Error && err.message ? err.message : 'Could not start the call. Try again.';
      showToast(detail, true);
    } finally {
      setCallInitiating(false);
    }
  }, [isCallable, callInitiating, sessionId, startCall, showToast]);

  // ── Render item ──────────────────────────────────────────────────────────────

  const renderItem = useCallback(
    ({ item }: { item: SessionMessageLocal }) => {
      const isOwn = item.senderRole === myRole;
      return (
        <MessageBubble
          message={item}
          isOwn={isOwn}
          otherPartyName={otherPartyName}
          onRetry={handleRetry}
        />
      );
    },
    [myRole, otherPartyName, handleRetry],
  );

  const keyExtractor = useCallback(
    (item: SessionMessageLocal) => item.id,
    [],
  );

  // ── Character counter ────────────────────────────────────────────────────────

  const charCount = inputValue.length;
  const showCharCounter = charCount >= MAX_CHARS - COUNTER_THRESHOLD;

  const isSendDisabled =
    !inputValue.trim() || sendMessage.isPending;

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      style={c.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
    >
      <View style={c.container}>
        {/* Inner header — phone icon on the right */}
        <View style={c.header}>
          <View style={c.headerLeft}>
            <MessageSquare size={14} color={colors.mutedForeground} />
            <Text style={c.headerLabel}>Session Chat</Text>
          </View>
          <TouchableOpacity
            style={[
              c.phoneButton,
              !isCallable && c.phoneButtonDisabled,
            ]}
            onPress={() => { void handleCall(); }}
            disabled={!isCallable || callInitiating}
            accessibilityRole="button"
            accessibilityLabel="Start phone call"
            accessibilityHint={
              isCallable
                ? 'Initiates a masked phone call with both parties.'
                : 'Calling is only available for scheduled or in-progress sessions.'
            }
            accessibilityState={{ disabled: !isCallable || callInitiating }}
          >
            {callInitiating ? (
              <ActivityIndicator size="small" color={isCallable ? colors.primary : colors.mutedForeground} />
            ) : (
              <Phone
                size={16}
                color={isCallable ? colors.primary : colors.mutedForeground}
              />
            )}
          </TouchableOpacity>
        </View>

        {/* Toast slot */}
        {toastMessage !== null && (
          <InlineToast message={toastMessage} isError={toastIsError} />
        )}

        {/* Message list */}
        {messagesQuery.isLoading ? (
          <View style={c.emptyState}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : mergedMessages.length === 0 ? (
          <View style={c.emptyState}>
            <View style={c.emptyIconCircle}>
              <MessageSquare size={20} color={colors.mutedForeground} />
            </View>
            <Text style={c.emptyTitle}>No messages yet</Text>
            <Text style={c.emptySubtext}>Start the conversation below.</Text>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={mergedMessages}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            contentContainerStyle={c.listContent}
            showsVerticalScrollIndicator={false}
            onContentSizeChange={() => scrollToBottom(false)}
            accessibilityRole="list"
            accessibilityLabel="Message history"
            accessibilityLiveRegion="polite"
          />
        )}

        {/* Input area — always visible */}
        <View style={c.inputArea}>
          {showCharCounter && (
            <Text
              style={[
                c.charCounter,
                charCount >= MAX_CHARS && c.charCounterLimit,
              ]}
              accessibilityLabel={`${MAX_CHARS - charCount} characters remaining`}
            >
              {MAX_CHARS - charCount}
            </Text>
          )}
          <View style={c.inputRow}>
            <TextInput
              style={c.input}
              value={inputValue}
              onChangeText={(text) => setInputValue(text.slice(0, MAX_CHARS))}
              placeholder="Type a message…"
              placeholderTextColor={colors.mutedForeground}
              multiline
              maxLength={MAX_CHARS}
              returnKeyType="send"
              blurOnSubmit
              onSubmitEditing={() => { void handleSend(); }}
              accessibilityLabel="Message input"
            />
            <TouchableOpacity
              style={[c.sendButton, isSendDisabled && c.sendButtonDisabled]}
              onPress={() => { void handleSend(); }}
              disabled={isSendDisabled}
              accessibilityRole="button"
              accessibilityLabel="Send message"
              accessibilityState={{ disabled: isSendDisabled }}
              activeOpacity={0.75}
            >
              {sendMessage.isPending ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Send size={16} color={colors.primaryForeground} />
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const c = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: colors.background },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerLabel: {
    ...typography.label,
    fontWeight: '700',
    color: colors.mutedForeground,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  phoneButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: `${colors.primary}12`,
    borderWidth: 1,
    borderColor: `${colors.primary}30`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  phoneButtonDisabled: {
    backgroundColor: colors.background,
    borderColor: colors.border,
  },

  listContent: { padding: 16, paddingBottom: 8 },

  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 40,
  },
  emptyIconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: `${colors.secondary}18`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: { ...typography.bodyMd, fontWeight: '700', color: colors.foreground },
  emptySubtext: {
    ...typography.bodySm,
    color: colors.mutedForeground,
    textAlign: 'center',
  },

  inputArea: {
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: Platform.OS === 'ios' ? 10 : 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
  },
  charCounter: {
    alignSelf: 'flex-end',
    ...typography.label,
    color: colors.mutedForeground,
    marginBottom: 4,
    paddingHorizontal: 4,
  },
  charCounterLimit: {
    color: colors.destructive,
    fontWeight: '700',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    backgroundColor: colors.background,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    ...typography.bodyMd,
    color: colors.foreground,
    maxHeight: 96,      // approx 4 lines
    minHeight: 44,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  sendButtonDisabled: { opacity: 0.35 },
});
