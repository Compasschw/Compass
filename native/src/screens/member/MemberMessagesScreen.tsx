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
} from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';

import { AppShell } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import {
  useSessions,
  useSessionMessages,
  useSessionSendMessage,
  type SessionData,
  type SessionMessageLocal,
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
  const scrollRef = useRef<ScrollView>(null);

  const sessionsQuery = useSessions();
  const sendMessage = useSessionSendMessage();

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

          <TouchableOpacity
            style={styles.iconBtn}
            accessibilityRole="button"
            accessibilityLabel="Call your CHW"
          >
            <Phone size={20} color="#6B7280" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.iconBtn}
            accessibilityRole="button"
            accessibilityLabel="Schedule an appointment"
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
