/**
 * CHWMessagesScreen — 3-pane SMS inbox for Community Health Workers.
 *
 * Layout (web, ≥1280px):
 *   [Thread list 320px] | [Conversation pane flex] | [Member context rail 288px]
 *
 * Responsive collapse:
 *   <1280px  → right rail hidden; thread list + conversation both visible
 *   <900px   → only conversation visible (back button reveals thread list)
 *
 * Data wiring:
 *   - Thread list: useSessions() — each session = one thread (member + CHW).
 *   - Messages: useSessionMessages(sessionId) — polls every 4s.
 *   - Send: useSessionSendMessage() mutation.
 *
 * Only rendered on web. Native falls through to the existing CHWSessionsScreen
 * (which the navigator still registers as "Sessions" in the stack for native).
 *
 * Hard constraints:
 *   - Do NOT modify DashboardSidebar.
 *   - Do NOT add new backend endpoints.
 *   - Do NOT claim TLS+at-rest is E2E encryption.
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
  useWindowDimensions,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import {
  Search,
  Phone,
  CalendarPlus,
  Paperclip,
  Link as LinkIcon,
  Send,
  Sparkles,
  List,
  NotebookPen,
  Flag,
  Home,
  Utensils,
  Car,
  ArrowLeft,
  AlertCircle,
} from 'lucide-react-native';
import { OpenQuestionsDrawer } from '../../components/chw/OpenQuestionsDrawer';

import { AppShell, Card, Pill } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import {
  useSessions,
  useSessionMessages,
  useSessionSendMessage,
  type SessionData,
  type SessionMessageLocal,
  type SessionMessageData,
} from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';

// ─── Breakpoints ──────────────────────────────────────────────────────────────

const BP_HIDE_RAIL  = 1280; // right rail hidden below this
const BP_HIDE_LIST  = 900;  // thread list hidden below this (mobile-web)

// ─── Quick-reply templates (presentation only) ────────────────────────────────

const QUICK_TEMPLATES = [
  { label: 'Appointment reminder',      emoji: '📅' },
  { label: 'Document upload reminder',  emoji: '📄' },
  { label: 'Resource link',             emoji: '🔗' },
  { label: 'Follow-up check-in',        emoji: '👋' },
  { label: 'Reschedule',                emoji: '⏰' },
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

function formatThreadTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  if (diffDays === 1) return 'Yesterday';
  return `${diffDays} days`;
}

function formatMessageTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDateSeparator(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor(
    (now.setHours(0, 0, 0, 0) - d.setHours(0, 0, 0, 0)) / (1000 * 60 * 60 * 24),
  );
  if (diffDays === 0) return `Today · ${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  if (diffDays === 1) return 'Yesterday';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Group messages into date buckets for day-separator rendering. */
function groupByDay(messages: SessionMessageLocal[]): Array<{ date: string; messages: SessionMessageLocal[] }> {
  const buckets: Record<string, SessionMessageLocal[]> = {};
  for (const msg of messages) {
    const key = new Date(msg.createdAt).toDateString();
    (buckets[key] ??= []).push(msg);
  }
  return Object.entries(buckets).map(([date, msgs]) => ({ date, messages: msgs }));
}

// ─── Avatar chip ──────────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  '#d1fae5', '#dbeafe', '#ede9fe', '#fef3c7', '#ffe4e6',
  '#cffafe', '#e0e7ff', '#ffedd5',
];
const AVATAR_TEXT_COLORS = [
  '#047857', '#1d4ed8', '#6d28d9', '#b45309', '#be123c',
  '#0891b2', '#4338ca', '#c2410c',
];

function avatarColor(name: string): { bg: string; text: string } {
  const idx = name.charCodeAt(0) % AVATAR_COLORS.length;
  return { bg: AVATAR_COLORS[idx] ?? '#d1fae5', text: AVATAR_TEXT_COLORS[idx] ?? '#047857' };
}

// ─── Thread row ───────────────────────────────────────────────────────────────

interface ThreadRowProps {
  session: SessionData;
  isActive: boolean;
  lastMessage: SessionMessageData | null;
  unread: boolean;
  onSelect: (session: SessionData) => void;
}

function ThreadRow({
  session,
  isActive,
  lastMessage,
  unread,
  onSelect,
}: ThreadRowProps): React.JSX.Element {
  const name = session.memberName ?? 'Unknown Member';
  const initials = getInitials(name);
  const { bg, text } = avatarColor(name);
  const preview = lastMessage?.body ?? session.notes ?? 'No messages yet';
  const ts = formatThreadTime(lastMessage?.createdAt ?? session.scheduledAt);

  return (
    <TouchableOpacity
      onPress={() => onSelect(session)}
      style={[styles.threadRow, isActive && styles.threadRowActive]}
      accessibilityRole="button"
      accessibilityLabel={`Thread with ${name}${unread ? ', unread' : ''}`}
      accessibilityState={{ selected: isActive }}
    >
      <View style={[styles.avatar40, { backgroundColor: bg }]}>
        <Text style={[styles.avatarText40, { color: text }]}>{initials}</Text>
      </View>
      <View style={styles.threadInfo}>
        <View style={styles.threadTopRow}>
          <Text style={styles.threadName} numberOfLines={1}>{name}</Text>
          <Text style={styles.threadTime}>{ts}</Text>
        </View>
        <Text style={styles.threadPreview} numberOfLines={1}>{preview}</Text>
      </View>
      {unread ? <View style={styles.unreadDot} /> : null}
    </TouchableOpacity>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────

interface BubbleProps {
  message: SessionMessageLocal;
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
          {message.status === 'failed' ? ' · Failed' : ''}
        </Text>
      </View>
    </View>
  );
}

// ─── Conversation pane ────────────────────────────────────────────────────────

interface ConversationPaneProps {
  session: SessionData;
  onBack?: () => void;
  showBackButton: boolean;
}

function ConversationPane({
  session,
  onBack,
  showBackButton,
}: ConversationPaneProps): React.JSX.Element {
  const [draftText, setDraftText] = useState('');
  const [localMessages, setLocalMessages] = useState<SessionMessageLocal[]>([]);
  const scrollRef = useRef<ScrollView>(null);

  const messagesQuery = useSessionMessages(session.id);
  const sendMessage = useSessionSendMessage();

  const memberName = session.memberName ?? 'Unknown Member';
  const initials = getInitials(memberName);
  const { bg, text } = avatarColor(memberName);

  // Merge server messages with local optimistic messages
  const mergedMessages = useMemo<SessionMessageLocal[]>(() => {
    const server: SessionMessageLocal[] = (messagesQuery.data ?? []).map((m) => ({ ...m }));
    // Keep only locally-optimistic messages not yet confirmed by server
    const serverIds = new Set(server.map((m) => m.id));
    const pendingLocal = localMessages.filter((m) => !serverIds.has(m.id));
    return [...server, ...pendingLocal].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
  }, [messagesQuery.data, localMessages]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, [mergedMessages.length]);

  const handleSend = useCallback(async () => {
    const trimmed = draftText.trim();
    if (!trimmed) return;

    // Optimistic message
    const optimisticId = `local-${Date.now()}`;
    const optimistic: SessionMessageLocal = {
      id: optimisticId,
      senderUserId: '',
      senderRole: 'chw',
      body: trimmed,
      type: 'text',
      createdAt: new Date().toISOString(),
      status: 'sending',
    };
    setLocalMessages((prev) => [...prev, optimistic]);
    setDraftText('');

    try {
      await sendMessage.mutateAsync({ sessionId: session.id, body: trimmed });
      // On success, server messages will replace the optimistic one via query invalidation
      setLocalMessages((prev) => prev.filter((m) => m.id !== optimisticId));
    } catch {
      setLocalMessages((prev) =>
        prev.map((m) => (m.id === optimisticId ? { ...m, status: 'failed' as const } : m)),
      );
    }
  }, [draftText, session.id, sendMessage]);

  const handleTemplatePress = useCallback((label: string) => {
    setDraftText((prev) => (prev ? `${prev} ${label}` : label));
  }, []);

  const grouped = groupByDay(mergedMessages);

  return (
    <View style={styles.convPane} accessibilityRole="main">
      {/* Header */}
      <View style={styles.convHeader}>
        {showBackButton && onBack ? (
          <TouchableOpacity
            onPress={onBack}
            style={styles.backButton}
            accessibilityRole="button"
            accessibilityLabel="Back to thread list"
          >
            <ArrowLeft size={20} color="#374151" />
          </TouchableOpacity>
        ) : null}
        <View style={[styles.avatar44, { backgroundColor: bg }]}>
          <Text style={[styles.avatarText44, { color: text }]}>{initials}</Text>
        </View>
        <View style={styles.convHeaderInfo}>
          <View style={styles.convHeaderNameRow}>
            <Text style={styles.convHeaderName}>{memberName}</Text>
            <Pill variant="emerald" size="sm">Highly Engaged</Pill>
          </View>
          <Text style={styles.convHeaderMeta}>
            {session.mode ? `${session.mode.replace('_', ' ')} · ` : ''}Active Member
          </Text>
        </View>
        <TouchableOpacity
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="Call member"
        >
          <Phone size={20} color="#6B7280" />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="Schedule appointment"
        >
          <CalendarPlus size={20} color="#6B7280" />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.openProfileBtn}
          accessibilityRole="link"
          accessibilityLabel={`Open ${memberName}'s profile`}
        >
          <Text style={styles.openProfileText}>Open Profile →</Text>
        </TouchableOpacity>
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
          <LoadingSkeleton variant="rows" rows={4} />
        ) : messagesQuery.error ? (
          <ErrorState
            message="Could not load messages."
            onRetry={() => void messagesQuery.refetch()}
          />
        ) : grouped.length === 0 ? (
          <View style={styles.emptyMessages}>
            <Text style={styles.emptyMessagesText}>No messages yet. Say hello!</Text>
          </View>
        ) : (
          grouped.map(({ date, messages: dayMsgs }) => (
            <View key={date}>
              <View style={styles.dateSeparatorRow}>
                <Text style={styles.dateSeparatorText}>
                  {formatDateSeparator(dayMsgs[0]?.createdAt ?? date)}
                </Text>
              </View>
              {dayMsgs.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  isMe={msg.senderRole === 'chw'}
                />
              ))}
            </View>
          ))
        )}
      </ScrollView>

      {/* Quick templates */}
      <View style={styles.templatesBar} accessibilityRole="toolbar" accessibilityLabel="Quick reply templates">
        <Text style={styles.templatesLabel}>Templates:</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.templatesScroll}>
          {QUICK_TEMPLATES.map(({ label, emoji }) => (
            <TouchableOpacity
              key={label}
              style={styles.templateChip}
              onPress={() => handleTemplatePress(label)}
              accessibilityRole="button"
              accessibilityLabel={`Insert template: ${label}`}
            >
              <Text style={styles.templateChipText}>{emoji} {label}</Text>
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
            accessibilityLabel="Attach file"
          >
            <Paperclip size={20} color="#6B7280" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.composerIconBtn}
            accessibilityRole="button"
            accessibilityLabel="Insert link"
          >
            <LinkIcon size={20} color="#6B7280" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.composerIconBtn}
            accessibilityRole="button"
            accessibilityLabel="Schedule appointment"
          >
            <CalendarPlus size={20} color="#6B7280" />
          </TouchableOpacity>
          <TextInput
            style={styles.composerInput}
            value={draftText}
            onChangeText={setDraftText}
            placeholder={`Reply to ${memberName}…`}
            placeholderTextColor="#9CA3AF"
            multiline
            numberOfLines={2}
            accessibilityLabel="Message input"
            onSubmitEditing={() => void handleSend()}
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
        <Text style={styles.composerMeta}>
          📱 SMS via Vonage masked number
        </Text>
      </View>
    </View>
  );
}

// ─── Right context rail ───────────────────────────────────────────────────────

interface ContextRailProps {
  session: SessionData;
  onOpenSuggestedQuestions: () => void;
}

function ContextRail({ session, onOpenSuggestedQuestions }: ContextRailProps): React.JSX.Element {
  return (
    <ScrollView
      style={styles.contextRailOuter}
      contentContainerStyle={styles.contextRail}
      showsVerticalScrollIndicator={false}
      accessibilityRole="complementary"
      accessibilityLabel="Member context"
    >
      <Text style={styles.railSectionLabel}>Member context</Text>

      {/* Active Journey */}
      <Card style={styles.railCard}>
        <Text style={styles.railCardMeta}>Active Journey</Text>
        <Text style={styles.railCardTitle}>
          {session.vertical?.replace('_', ' ') ?? 'General'} · 60%
        </Text>
        <View style={styles.progressBar} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: 60 }}>
          <View style={[styles.progressFill, { width: '60%' }]} />
        </View>
        <View style={styles.railWarningRow}>
          <AlertCircle size={12} color="#92400E" />
          <Text style={styles.railWarningText}>Current step: Upload Documents (due in 2 days)</Text>
        </View>
      </Card>

      {/* Top Resource Needs */}
      <Card style={styles.railCard}>
        <Text style={styles.railSubLabel}>Top Resource Needs</Text>
        <View style={styles.needsRows}>
          <NeedRow icon={<Home size={14} color="#EF4444" />} label="Housing" level="High" levelVariant="red" />
          <NeedRow icon={<Utensils size={14} color="#F97316" />} label="Food Assistance" level="High" levelVariant="red" />
          <NeedRow icon={<Car size={14} color="#F59E0B" />} label="Transportation" level="Med" levelVariant="amber" />
        </View>
      </Card>

      {/* Compass Insight */}
      <Card style={[styles.railCard, styles.insightCard]}>
        <View style={styles.insightHeader}>
          <Sparkles size={14} color="#16a34a" />
          <Text style={styles.insightTitle}>Compass Insight</Text>
        </View>
        <Text style={styles.insightText}>
          This member typically responds within 30 minutes between 4–7 PM. Consider sending the resource link this evening.
        </Text>
      </Card>

      {/* Quick Actions */}
      <View>
        <Text style={styles.railSectionLabel}>Quick Actions</Text>
        <QuickActionBtn
          icon={<List size={16} color="#6B7280" />}
          label="Open Suggested Questions"
          onPress={onOpenSuggestedQuestions}
        />
        <QuickActionBtn
          icon={<NotebookPen size={16} color="#6B7280" />}
          label="Add Case Note"
        />
        <QuickActionBtn
          icon={<Flag size={16} color="#6B7280" />}
          label="Flag this Thread"
        />
      </View>
    </ScrollView>
  );
}

interface NeedRowProps {
  icon: React.ReactNode;
  label: string;
  level: string;
  levelVariant: 'red' | 'amber' | 'emerald';
}

function NeedRow({ icon, label, level, levelVariant }: NeedRowProps): React.JSX.Element {
  return (
    <View style={styles.needRow}>
      {icon}
      <Text style={styles.needLabel}>{label}</Text>
      <View style={styles.needBadgeSpacer} />
      <Pill variant={levelVariant} size="sm">{level}</Pill>
    </View>
  );
}

interface QuickActionBtnProps {
  icon: React.ReactNode;
  label: string;
  onPress?: () => void;
}

function QuickActionBtn({ icon, label, onPress }: QuickActionBtnProps): React.JSX.Element {
  return (
    <TouchableOpacity
      style={styles.quickActionBtn}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {icon}
      <Text style={styles.quickActionText}>{label}</Text>
    </TouchableOpacity>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

/**
 * CHWMessagesScreen — 3-pane messaging inbox.
 * Rendered as the root of the SessionsStack on web; the navigator continues to
 * expose CHWSessionsScreen for individual session detail flows.
 */
export function CHWMessagesScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const { width } = useWindowDimensions();
  const sessionsQuery = useSessions();

  const [selectedSession, setSelectedSession] = useState<SessionData | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTab, setFilterTab] = useState<'all' | 'unread' | 'flagged'>('all');
  // On narrow viewports the thread list can be toggled
  const [showThreadList, setShowThreadList] = useState(true);
  // Open Questions drawer — only shown when a member thread is active
  const [questionsDrawerOpen, setQuestionsDrawerOpen] = useState(false);

  const hideRail = width < BP_HIDE_RAIL;
  const hideList = width < BP_HIDE_LIST;

  const memberInitials = (userName ?? 'CHW')
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  const shellUserBlock = {
    initials: memberInitials,
    name: userName ?? 'CHW',
    role: 'CHW' as const,
  };

  // All sessions for the CHW — each session is a "thread" with a member
  const allSessions: SessionData[] = sessionsQuery.data ?? [];

  // Filter to sessions that have a member (i.e., have messages to show)
  const filteredSessions = useMemo(() => {
    let list = allSessions.filter((s) => s.memberName);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((s) => (s.memberName ?? '').toLowerCase().includes(q));
    }
    // For now unread/flagged are presentation-only (no backend field); all sessions show
    return list;
  }, [allSessions, searchQuery]);

  // Auto-select first thread when list loads (desktop behaviour)
  useEffect(() => {
    if (filteredSessions.length > 0 && !selectedSession) {
      setSelectedSession(filteredSessions[0] ?? null);
    }
  }, [filteredSessions, selectedSession]);

  const handleSelectSession = useCallback((session: SessionData) => {
    setSelectedSession(session);
    // Close the questions drawer when switching threads — context has changed.
    setQuestionsDrawerOpen(false);
    // On narrow viewport, switch to conversation view
    if (hideList) {
      setShowThreadList(false);
    }
  }, [hideList]);

  const handleBack = useCallback(() => {
    setShowThreadList(true);
  }, []);

  if (sessionsQuery.isLoading) {
    return (
      <AppShell role="chw" activeKey="messages" userBlock={shellUserBlock} disableMainScroll>
        <View style={styles.loadingWrap}>
          <LoadingSkeleton variant="rows" rows={6} />
        </View>
      </AppShell>
    );
  }

  if (sessionsQuery.error) {
    return (
      <AppShell role="chw" activeKey="messages" userBlock={shellUserBlock} disableMainScroll>
        <ErrorState
          message="Could not load messages. Please try again."
          onRetry={() => void sessionsQuery.refetch()}
        />
      </AppShell>
    );
  }

  const shouldShowList = !hideList || showThreadList;
  const shouldShowConv = !hideList || !showThreadList;

  return (
    <AppShell
      role="chw"
      activeKey="messages"
      userBlock={shellUserBlock}
      disableMainScroll
    >
      <View style={styles.root}>
        {/* Thread list */}
        {shouldShowList ? (
          <View style={styles.threadList} accessibilityRole="navigation" accessibilityLabel="Message threads">
            {/* Header */}
            <View style={styles.threadListHeader}>
              <Text style={styles.threadListTitle}>Messages</Text>
              {/* Search */}
              <View style={styles.searchWrap}>
                <View style={styles.searchIcon}>
                  <Search size={16} color="#9CA3AF" />
                </View>
                <TextInput
                  style={styles.searchInput}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder="Search threads…"
                  placeholderTextColor="#9CA3AF"
                  accessibilityLabel="Search message threads"
                />
              </View>
              {/* Filter chips */}
              <View style={styles.filterRow}>
                {(['all', 'unread', 'flagged'] as const).map((key) => (
                  <TouchableOpacity
                    key={key}
                    style={[styles.filterChip, filterTab === key && styles.filterChipActive]}
                    onPress={() => setFilterTab(key)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: filterTab === key }}
                    accessibilityLabel={`Filter: ${key}`}
                  >
                    <Text style={[styles.filterChipText, filterTab === key && styles.filterChipTextActive]}>
                      {key === 'all' ? `All (${filteredSessions.length})` : key.charAt(0).toUpperCase() + key.slice(1)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Thread rows */}
            <ScrollView style={styles.threadScrollView} showsVerticalScrollIndicator={false}>
              {filteredSessions.length === 0 ? (
                <View style={styles.emptyThreads}>
                  <Text style={styles.emptyThreadsText}>No threads found.</Text>
                </View>
              ) : (
                filteredSessions.map((session) => (
                  <ThreadRow
                    key={session.id}
                    session={session}
                    isActive={selectedSession?.id === session.id}
                    lastMessage={null}
                    unread={false}
                    onSelect={handleSelectSession}
                  />
                ))
              )}
            </ScrollView>
          </View>
        ) : null}

        {/* Conversation pane */}
        {shouldShowConv && selectedSession ? (
          <ConversationPane
            key={selectedSession.id}
            session={selectedSession}
            onBack={handleBack}
            showBackButton={hideList}
          />
        ) : shouldShowConv ? (
          <View style={styles.noSelectionPlaceholder}>
            <Text style={styles.noSelectionText}>Select a thread to start messaging</Text>
          </View>
        ) : null}

        {/* Right context rail — hidden below BP_HIDE_RAIL */}
        {!hideRail && selectedSession ? (
          <ContextRail
            session={selectedSession}
            onOpenSuggestedQuestions={() => setQuestionsDrawerOpen(true)}
          />
        ) : null}
      </View>

      {/* Open Questions drawer — renders over the whole screen as a right overlay */}
      {selectedSession != null && (
        <OpenQuestionsDrawer
          visible={questionsDrawerOpen}
          onClose={() => setQuestionsDrawerOpen(false)}
          member={{
            name:                 selectedSession.memberName ?? 'Member',
            age:                  null,
            initials:             getInitials(selectedSession.memberName),
            engagementLabel:      'Active Member',
          }}
          journey={
            selectedSession.vertical
              ? {
                  templateName:    `${selectedSession.vertical.replace('_', ' ')} Journey`,
                  currentStepName: 'Current Step',
                  vertical:        selectedSession.vertical,
                }
              : undefined
          }
        />
      )}
    </AppShell>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Layout
  root: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: '#f9fafb',
    overflow: 'hidden',
  } as ViewStyle,
  loadingWrap: {
    padding: 24,
    flex: 1,
  } as ViewStyle,

  // Thread list
  threadList: {
    width: 320,
    borderRightWidth: 1,
    borderRightColor: '#E5E7EB',
    backgroundColor: '#fff',
    flexShrink: 0,
  } as ViewStyle,
  threadListHeader: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  } as ViewStyle,
  threadListTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 12,
  } as TextStyle,
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    paddingHorizontal: 10,
    marginBottom: 10,
  } as ViewStyle,
  searchIcon: {
    marginRight: 6,
    justifyContent: 'center',
  } as ViewStyle,
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: '#111827',
    paddingVertical: 8,
    outlineStyle: 'none',
  } as TextStyle,
  filterRow: {
    flexDirection: 'row',
    gap: 6,
  } as ViewStyle,
  filterChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  } as ViewStyle,
  filterChipActive: {
    backgroundColor: '#D1FAE5',
  } as ViewStyle,
  filterChipText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#6B7280',
  } as TextStyle,
  filterChipTextActive: {
    color: '#065F46',
    fontWeight: '600',
  } as TextStyle,
  threadScrollView: {
    flex: 1,
  } as ViewStyle,
  emptyThreads: {
    padding: 24,
    alignItems: 'center',
  } as ViewStyle,
  emptyThreadsText: {
    fontSize: 14,
    color: '#9CA3AF',
  } as TextStyle,

  // Thread row
  threadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,
  threadRowActive: {
    backgroundColor: '#ECFDF5',
    borderLeftWidth: 3,
    borderLeftColor: '#10B981',
    paddingLeft: 13,
  } as ViewStyle,
  avatar40: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  avatarText40: {
    fontSize: 13,
    fontWeight: '700',
  } as TextStyle,
  threadInfo: {
    flex: 1,
    minWidth: 0,
  } as ViewStyle,
  threadTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 3,
  } as ViewStyle,
  threadName: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  } as TextStyle,
  threadTime: {
    fontSize: 11,
    color: '#9CA3AF',
    flexShrink: 0,
  } as TextStyle,
  threadPreview: {
    fontSize: 12,
    color: '#6B7280',
  } as TextStyle,
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#10B981',
    flexShrink: 0,
  } as ViewStyle,

  // Conversation pane
  convPane: {
    flex: 1,
    flexDirection: 'column',
    backgroundColor: '#F9FAFB',
    overflow: 'hidden',
  } as ViewStyle,
  convHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  } as ViewStyle,
  backButton: {
    padding: 6,
    borderRadius: 8,
  } as ViewStyle,
  avatar44: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  avatarText44: {
    fontSize: 15,
    fontWeight: '700',
  } as TextStyle,
  convHeaderInfo: {
    flex: 1,
    minWidth: 0,
  } as ViewStyle,
  convHeaderNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 2,
  } as ViewStyle,
  convHeaderName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
  } as TextStyle,
  convHeaderMeta: {
    fontSize: 12,
    color: '#6B7280',
  } as TextStyle,
  iconBtn: {
    padding: 8,
    borderRadius: 8,
  } as ViewStyle,
  openProfileBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
  } as ViewStyle,
  openProfileText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
  } as TextStyle,

  // Messages
  messagesScroll: {
    flex: 1,
  } as ViewStyle,
  messagesContent: {
    padding: 20,
    gap: 4,
  } as ViewStyle,
  emptyMessages: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 40,
  } as ViewStyle,
  emptyMessagesText: {
    fontSize: 14,
    color: '#9CA3AF',
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

  // Templates bar
  templatesBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    gap: 10,
  } as ViewStyle,
  templatesLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#9CA3AF',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    flexShrink: 0,
  } as TextStyle,
  templatesScroll: {
    gap: 8,
    flexDirection: 'row',
  } as ViewStyle,
  templateChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#fff',
  } as ViewStyle,
  templateChipText: {
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
    gap: 6,
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
  composerMeta: {
    fontSize: 12,
    color: '#9CA3AF',
    marginTop: 8,
    textAlign: 'center',
  } as TextStyle,

  // No selection
  noSelectionPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  noSelectionText: {
    fontSize: 14,
    color: '#9CA3AF',
  } as TextStyle,

  // Context rail
  contextRailOuter: {
    width: 288,
    borderLeftWidth: 1,
    borderLeftColor: '#E5E7EB',
    backgroundColor: '#fff',
    flexShrink: 0,
  } as ViewStyle,
  contextRail: {
    padding: 20,
    gap: 12,
  } as ViewStyle,
  railCard: {
    padding: 14,
    gap: 6,
  } as ViewStyle,
  railSectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#9CA3AF',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  } as TextStyle,
  railSubLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#9CA3AF',
    marginBottom: 6,
  } as TextStyle,
  railCardMeta: {
    fontSize: 12,
    color: '#9CA3AF',
  } as TextStyle,
  railCardTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  } as TextStyle,
  progressBar: {
    height: 8,
    backgroundColor: '#F3F4F6',
    borderRadius: 4,
    overflow: 'hidden',
  } as ViewStyle,
  progressFill: {
    height: 8,
    backgroundColor: '#10B981',
    borderRadius: 4,
  } as ViewStyle,
  railWarningRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 4,
  } as ViewStyle,
  railWarningText: {
    fontSize: 12,
    color: '#92400E',
    flex: 1,
  } as TextStyle,
  needsRows: {
    gap: 8,
  } as ViewStyle,
  needRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  } as ViewStyle,
  needLabel: {
    fontSize: 14,
    color: '#111827',
    flex: 1,
  } as TextStyle,
  needBadgeSpacer: {
    flex: 1,
  } as ViewStyle,
  insightCard: {
    backgroundColor: '#F0FDF4',
  } as ViewStyle,
  insightHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  } as ViewStyle,
  insightTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#111827',
  } as TextStyle,
  insightText: {
    fontSize: 12,
    color: '#374151',
    lineHeight: 18,
  } as TextStyle,
  quickActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    marginBottom: 6,
  } as ViewStyle,
  quickActionText: {
    fontSize: 14,
    color: '#374151',
  } as TextStyle,
});
