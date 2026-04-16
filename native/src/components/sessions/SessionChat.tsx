/**
 * SessionChat — in-session chat component using mock conversation data.
 *
 * Features:
 *  - Inverted FlatList for chat-style message ordering (newest at bottom)
 *  - Sent messages: right-aligned, primary background
 *  - Received messages: left-aligned, card background with border
 *  - Timestamps on each bubble
 *  - TextInput at bottom with Send button
 *  - Empty state: "No messages yet"
 */

import React, { useState, useCallback, useRef } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Send, MessageSquare } from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionChatProps {
  /** Session ID — used to identify which mock conversation to display */
  sessionId: string;
}

interface ChatMessage {
  id: string;
  body: string;
  createdAt: string;
  /** true = CHW sent (right-aligned), false = member sent (left-aligned) */
  isOwn: boolean;
}

// ─── Mock conversation data ───────────────────────────────────────────────────

/**
 * Returns mock conversation messages for a given session ID.
 * In production this would be fetched from the API.
 */
function getMockMessages(sessionId: string): ChatMessage[] {
  const baseMessages: ChatMessage[] = [
    {
      id: 'msg-001',
      body: "Hi Rosa! I'm Maria. Looking forward to our session today — I've reviewed your housing situation and have some resources ready.",
      createdAt: '2026-04-03T09:55:00Z',
      isOwn: true,
    },
    {
      id: 'msg-002',
      body: "Thank you so much, Maria. I'm a bit nervous but ready. The eviction notice came yesterday.",
      createdAt: '2026-04-03T09:56:30Z',
      isOwn: false,
    },
    {
      id: 'msg-003',
      body: "I understand — that's very stressful. We'll go through the ERAP application step by step. I also have the tenant rights hotline number for you.",
      createdAt: '2026-04-03T09:57:15Z',
      isOwn: true,
    },
    {
      id: 'msg-004',
      body: 'That sounds really helpful. Should I have my lease agreement with me?',
      createdAt: '2026-04-03T09:58:00Z',
      isOwn: false,
    },
    {
      id: 'msg-005',
      body: 'Yes, please! And also any correspondence from your landlord. See you at 10:00.',
      createdAt: '2026-04-03T09:59:00Z',
      isOwn: true,
    },
  ];

  // Vary the mock messages slightly per session ID for realistic demo variety
  if (sessionId === 'sess-002') {
    return [
      {
        id: 'msg-d001',
        body: "Marcus, great work on the 60-day milestone. I've identified three Medi-Cal IOP programs near you.",
        createdAt: '2026-03-31T13:55:00Z',
        isOwn: true,
      },
      {
        id: 'msg-d002',
        body: "Thanks Darnell. Pacific Clinics was the one my sponsor mentioned too. Can we start there?",
        createdAt: '2026-03-31T13:57:00Z',
        isOwn: false,
      },
      {
        id: 'msg-d003',
        body: "Absolutely. I'll pull up their intake form now. They have Monday and Wednesday evening slots available.",
        createdAt: '2026-03-31T13:58:30Z',
        isOwn: true,
      },
    ];
  }

  return baseMessages;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Formats an ISO timestamp to a short human-readable time string (e.g. "9:55 AM").
 */
function formatMessageTime(isoString: string): string {
  try {
    return new Date(isoString).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

// ─── MessageBubble ────────────────────────────────────────────────────────────

interface MessageBubbleProps {
  body: string;
  createdAt: string;
  isOwn: boolean;
}

function MessageBubble({ body, createdAt, isOwn }: MessageBubbleProps): React.JSX.Element {
  return (
    <View style={[b.wrapper, isOwn ? b.wrapperOwn : b.wrapperOther]}>
      <View style={[b.bubble, isOwn ? b.bubbleOwn : b.bubbleOther]}>
        <Text style={[b.bodyText, isOwn ? b.bodyTextOwn : b.bodyTextOther]}>
          {body}
        </Text>
      </View>
      <Text style={[b.timestamp, isOwn ? b.timestampOwn : b.timestampOther]}>
        {formatMessageTime(createdAt)}
      </Text>
    </View>
  );
}

const b = StyleSheet.create({
  wrapper: {
    maxWidth: '80%',
    marginBottom: 12,
    gap: 3,
  },
  wrapperOwn: {
    alignSelf: 'flex-end',
    alignItems: 'flex-end',
  },
  wrapperOther: {
    alignSelf: 'flex-start',
    alignItems: 'flex-start',
  },
  bubble: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
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
  bodyText: {
    ...typography.bodySm,
    lineHeight: 20,
  },
  bodyTextOwn: {
    color: '#FFFFFF',
  },
  bodyTextOther: {
    color: colors.foreground,
  },
  timestamp: {
    fontSize: 10,
    color: colors.mutedForeground,
    paddingHorizontal: 4,
  },
  timestampOwn: {
    textAlign: 'right',
  },
  timestampOther: {
    textAlign: 'left',
  },
});

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * Session chat with mock data. In production, replace getMockMessages with
 * an API-connected hook (useMessages / useSendMessage).
 */
export function SessionChat({ sessionId }: SessionChatProps): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>(() => getMockMessages(sessionId));
  const [inputValue, setInputValue] = useState('');
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const handleSend = useCallback((): void => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    const newMessage: ChatMessage = {
      id: `msg-local-${Date.now()}`,
      body: trimmed,
      createdAt: new Date().toISOString(),
      isOwn: true,
    };

    setMessages((prev) => [...prev, newMessage]);
    setInputValue('');

    // Scroll to end after state update
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, [inputValue]);

  const renderItem = useCallback(
    ({ item }: { item: ChatMessage }) => (
      <MessageBubble body={item.body} createdAt={item.createdAt} isOwn={item.isOwn} />
    ),
    [],
  );

  const keyExtractor = useCallback((item: ChatMessage) => item.id, []);

  return (
    <View style={c.container}>
      {/* Header */}
      <View style={c.header}>
        <Text style={c.headerLabel}>Session Chat</Text>
      </View>

      {/* Message list */}
      {messages.length === 0 ? (
        <View style={c.emptyState}>
          <View style={c.emptyIconCircle}>
            <MessageSquare size={20} color={colors.mutedForeground} />
          </View>
          <Text style={c.emptyTitle}>No messages yet</Text>
          <Text style={c.emptySubtext}>Start the conversation!</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={c.listContent}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          accessibilityRole="list"
          accessibilityLabel="Message history"
          accessibilityLiveRegion="polite"
        />
      )}

      {/* Input area */}
      <View style={c.inputArea}>
        <TextInput
          style={c.input}
          value={inputValue}
          onChangeText={setInputValue}
          placeholder="Type a message..."
          placeholderTextColor={colors.mutedForeground}
          multiline
          maxLength={500}
          returnKeyType="send"
          blurOnSubmit
          onSubmitEditing={handleSend}
          accessibilityLabel="Message input"
        />
        <TouchableOpacity
          style={[c.sendButton, !inputValue.trim() && c.sendButtonDisabled]}
          onPress={handleSend}
          disabled={!inputValue.trim()}
          accessibilityRole="button"
          accessibilityLabel="Send message"
          accessibilityState={{ disabled: !inputValue.trim() }}
          activeOpacity={0.75}
        >
          <Send size={16} color="#FFFFFF" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const c = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  headerLabel: {
    ...typography.label,
    fontWeight: '700',
    color: colors.mutedForeground,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  listContent: {
    padding: 16,
    paddingBottom: 8,
  },

  // Empty state
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
    backgroundColor: colors.secondary + '18',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    ...typography.bodyMd,
    fontWeight: '700',
    color: colors.foreground,
  },
  emptySubtext: {
    ...typography.bodySm,
    color: colors.mutedForeground,
    textAlign: 'center',
  },

  // Input area
  inputArea: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    backgroundColor: colors.background,
    paddingHorizontal: 14,
    paddingVertical: 10,
    ...typography.bodyMd,
    color: colors.foreground,
    maxHeight: 100,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  sendButtonDisabled: {
    opacity: 0.4,
  },
});
