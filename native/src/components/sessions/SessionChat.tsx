/**
 * SessionChat — real-time(-ish) in-session chat for CompassCHW.
 *
 * Wired to the backend via:
 *   - useMessages(conversationId)       — GET /conversations/:id/messages
 *   - useSendMessage()                  — POST /conversations/:id/messages
 *   - POST /upload/presigned-url        — S3 presign for attachments
 *   - GET /conversations/messages/:id/attachment-url — presigned download
 *
 * Features:
 *   - Text + file messages (one component handles both)
 *   - File picker via expo-document-picker (PDF, images, audio)
 *   - 20 MB client-side size cap (matches backend validation)
 *   - Empty state, error state, loading state
 *   - Polling every 5s while screen is mounted (cheap Phase-1 fanout;
 *     replace with WebSocket/push-based refresh post-MVP)
 */

import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { FileText, MessageSquare, Paperclip, Send } from 'lucide-react-native';

import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import {
  useConversations,
  useMessages,
  useSendMessage,
  type MessageData,
} from '../../hooks/useApiQueries';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';

export interface SessionChatProps {
  /** The session ID — we look up the linked conversation by session_id */
  sessionId: string;
}

/** Shape of the message with attachment field (extends backend MessageData). */
interface MessageWithAttachment extends MessageData {
  attachment?: {
    id: string;
    filename: string;
    sizeBytes: number;
    contentType: string;
    s3Key: string;
  } | null;
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB — matches backend

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
];

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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Presigned upload helper ─────────────────────────────────────────────────

interface PresignedUrlResponse {
  upload_url: string;
  s3_key: string;
}

async function presignUpload(
  filename: string,
  contentType: string,
  sizeBytes: number,
): Promise<PresignedUrlResponse> {
  return api<PresignedUrlResponse>('/upload/presigned-url', {
    method: 'POST',
    body: JSON.stringify({
      filename,
      content_type: contentType,
      size_bytes: sizeBytes,
      purpose: 'document',
    }),
  });
}

async function uploadToS3(
  uploadUrl: string,
  fileUri: string,
  contentType: string,
): Promise<void> {
  // RN fetch needs to stream from the file URI. `uri` scheme on iOS/Android
  // resolves to the sandboxed doc we just picked.
  const resp = await fetch(fileUri);
  const blob = await resp.blob();

  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: blob,
  });
  if (!put.ok) {
    throw new Error(`Upload failed: HTTP ${put.status}`);
  }
}

// ─── MessageBubble ────────────────────────────────────────────────────────────

interface MessageBubbleProps {
  message: MessageWithAttachment;
  isOwn: boolean;
}

function MessageBubble({ message, isOwn }: MessageBubbleProps): React.JSX.Element {
  const [downloading, setDownloading] = useState(false);

  const handleDownload = useCallback(async () => {
    if (!message.attachment) return;
    setDownloading(true);
    try {
      const resp = await api<{ url: string }>(
        `/conversations/messages/${message.id}/attachment-url`,
      );
      // Open in the system browser / default viewer. PDFs + images open inline;
      // audio launches the system player. On iOS we could also present QuickLook
      // for richer previews — deferred to post-MVP.
      await Linking.openURL(resp.url);
    } catch {
      Alert.alert('Could not download', 'The file link may have expired. Try again.');
    } finally {
      setDownloading(false);
    }
  }, [message]);

  return (
    <View style={[b.wrapper, isOwn ? b.wrapperOwn : b.wrapperOther]}>
      <View style={[b.bubble, isOwn ? b.bubbleOwn : b.bubbleOther]}>
        {message.attachment && (
          <TouchableOpacity
            style={[b.attachment, isOwn ? b.attachmentOwn : b.attachmentOther]}
            onPress={handleDownload}
            disabled={downloading}
            accessibilityRole="button"
            accessibilityLabel={`Download ${message.attachment.filename}`}
          >
            <View
              style={[
                b.attachmentIcon,
                isOwn ? b.attachmentIconOwn : b.attachmentIconOther,
              ]}
            >
              {downloading ? (
                <ActivityIndicator size="small" color={isOwn ? '#FFFFFF' : colors.primary} />
              ) : (
                <FileText size={18} color={isOwn ? '#FFFFFF' : colors.primary} />
              )}
            </View>
            <View style={b.attachmentMeta}>
              <Text
                style={[b.attachmentName, isOwn ? b.textOwn : b.textOther]}
                numberOfLines={1}
              >
                {message.attachment.filename}
              </Text>
              <Text style={[b.attachmentSize, isOwn ? b.textOwnMuted : b.textOtherMuted]}>
                {formatFileSize(message.attachment.sizeBytes)}
              </Text>
            </View>
          </TouchableOpacity>
        )}
        {message.body ? (
          <Text style={[b.bodyText, isOwn ? b.textOwn : b.textOther]}>
            {message.body}
          </Text>
        ) : null}
      </View>
      <Text style={[b.timestamp, isOwn ? b.timestampOwn : b.timestampOther]}>
        {formatMessageTime(message.createdAt)}
      </Text>
    </View>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export function SessionChat({ sessionId }: SessionChatProps): React.JSX.Element {
  const { userRole } = useAuth();
  const [inputValue, setInputValue] = useState('');
  const [uploading, setUploading] = useState(false);
  const listRef = useRef<FlatList<MessageWithAttachment>>(null);

  // Resolve conversation by session_id. The conversations list is small enough
  // to filter client-side — we only have at most one conversation per session.
  const conversationsQuery = useConversations();
  const conversation = conversationsQuery.data?.find((c) => c.sessionId === sessionId);
  const conversationId = conversation?.id ?? '';

  const messagesQuery = useMessages(conversationId);
  const sendMutation = useSendMessage();

  // Infer own-message side from the sender's role. We only have the sender_id
  // from the API, not the role. For a simple v1, we compare against auth role
  // by assumption: if the conversation shows chw_id === sender_id, it's own for CHWs.
  const myRoleKey = userRole === 'chw' ? 'chwId' : 'memberId';
  const myId = conversation ? conversation[myRoleKey] : '';

  const messages = (messagesQuery.data ?? []) as MessageWithAttachment[];

  const handleSend = useCallback(async () => {
    const trimmed = inputValue.trim();
    if (!trimmed || !conversationId) return;
    try {
      await sendMutation.mutateAsync({ conversationId, body: trimmed });
      setInputValue('');
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    } catch {
      Alert.alert('Could not send', 'Check your connection and try again.');
    }
  }, [inputValue, conversationId, sendMutation]);

  const handlePickFile = useCallback(async () => {
    if (!conversationId || uploading) return;

    const result = await DocumentPicker.getDocumentAsync({
      type: ALLOWED_MIME_TYPES,
      copyToCacheDirectory: true,
      multiple: false,
    });

    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];

    const contentType = asset.mimeType ?? 'application/octet-stream';
    const sizeBytes = asset.size ?? 0;

    if (!ALLOWED_MIME_TYPES.includes(contentType)) {
      Alert.alert('File type not allowed', `${contentType} is not supported.`);
      return;
    }
    if (sizeBytes > MAX_ATTACHMENT_BYTES) {
      Alert.alert('File too large', 'Maximum size is 20 MB.');
      return;
    }

    setUploading(true);
    try {
      const presigned = await presignUpload(asset.name, contentType, sizeBytes);
      await uploadToS3(presigned.upload_url, asset.uri, contentType);

      // Post the message with the attachment metadata
      await api('/conversations/' + conversationId + '/messages', {
        method: 'POST',
        body: JSON.stringify({
          body: `📎 ${asset.name}`,
          type: 'file',
          attachment_s3_key: presigned.s3_key,
          attachment_filename: asset.name,
          attachment_size_bytes: sizeBytes,
          attachment_content_type: contentType,
        }),
      });

      // Trigger a refetch of messages
      await messagesQuery.refetch();
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    } catch {
      Alert.alert('Upload failed', 'Could not send the file. Try again.');
    } finally {
      setUploading(false);
    }
  }, [conversationId, uploading, messagesQuery]);

  const renderItem = useCallback(
    ({ item }: { item: MessageWithAttachment }) => (
      <MessageBubble message={item} isOwn={item.senderId === myId} />
    ),
    [myId],
  );

  const keyExtractor = useCallback((item: MessageWithAttachment) => item.id, []);

  // Conversations hasn't linked to this session yet (CHW hasn't accepted),
  // or the user is offline. Treat as empty conversation.
  if (!conversationId && !conversationsQuery.isLoading) {
    return (
      <View style={c.container}>
        <View style={c.emptyState}>
          <View style={c.emptyIconCircle}>
            <MessageSquare size={20} color={colors.mutedForeground} />
          </View>
          <Text style={c.emptyTitle}>No chat for this session yet</Text>
          <Text style={c.emptySubtext}>
            Messaging opens once a CHW accepts the session.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={c.container}>
      <View style={c.header}>
        <Text style={c.headerLabel}>Session Chat</Text>
      </View>

      {messagesQuery.isLoading ? (
        <View style={c.emptyState}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : messages.length === 0 ? (
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

      <View style={c.inputArea}>
        <TouchableOpacity
          style={[c.attachButton, uploading && c.attachButtonDisabled]}
          onPress={handlePickFile}
          disabled={uploading || !conversationId}
          accessibilityRole="button"
          accessibilityLabel="Attach file"
        >
          {uploading ? (
            <ActivityIndicator size="small" color={colors.mutedForeground} />
          ) : (
            <Paperclip size={20} color={colors.mutedForeground} />
          )}
        </TouchableOpacity>

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
          style={[
            c.sendButton,
            (!inputValue.trim() || sendMutation.isPending || !conversationId) &&
              c.sendButtonDisabled,
          ]}
          onPress={handleSend}
          disabled={!inputValue.trim() || sendMutation.isPending || !conversationId}
          accessibilityRole="button"
          accessibilityLabel="Send message"
          activeOpacity={0.75}
        >
          {sendMutation.isPending ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Send size={16} color="#FFFFFF" />
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const b = StyleSheet.create({
  wrapper: {
    maxWidth: '80%',
    marginBottom: 12,
    gap: 3,
  },
  wrapperOwn: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  wrapperOther: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  bubble: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    gap: 8,
  },
  bubbleOwn: { backgroundColor: colors.primary, borderBottomRightRadius: 4 },
  bubbleOther: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomLeftRadius: 4,
  },
  bodyText: { ...typography.bodySm, lineHeight: 20 },
  textOwn: { color: '#FFFFFF' },
  textOther: { color: colors.foreground },
  textOwnMuted: { color: '#FFFFFFAA' },
  textOtherMuted: { color: colors.mutedForeground },
  timestamp: { fontSize: 10, color: colors.mutedForeground, paddingHorizontal: 4 },
  timestampOwn: { textAlign: 'right' },
  timestampOther: { textAlign: 'left' },

  attachment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 4,
    minWidth: 200,
  },
  attachmentOwn: {},
  attachmentOther: {},
  attachmentIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachmentIconOwn: { backgroundColor: '#FFFFFF25' },
  attachmentIconOther: { backgroundColor: `${colors.primary}15` },
  attachmentMeta: { flex: 1, minWidth: 0 },
  attachmentName: { ...typography.bodySm, fontWeight: '600' },
  attachmentSize: { fontSize: 11, marginTop: 2 },
});

const c = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
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
    backgroundColor: colors.secondary + '18',
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
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
  },
  attachButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  attachButtonDisabled: { opacity: 0.5 },
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
  sendButtonDisabled: { opacity: 0.4 },
});
