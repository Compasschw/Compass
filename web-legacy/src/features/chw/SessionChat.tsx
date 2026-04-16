import {
  useRef,
  useEffect,
  useState,
  useCallback,
  type KeyboardEvent,
  type FormEvent,
} from 'react';
import { Send, Loader2, MessageSquare } from 'lucide-react';
import { useMessages, useSendMessage, useConversations } from '../../api/hooks';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SessionChatProps {
  sessionId: string;
  chwId: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Sub-components ───────────────────────────────────────────────────────────

interface MessageBubbleProps {
  body: string;
  createdAt: string;
  isOwnMessage: boolean;
}

function MessageBubble({ body, createdAt, isOwnMessage }: MessageBubbleProps) {
  return (
    <div
      className={`flex flex-col gap-0.5 max-w-[80%] ${isOwnMessage ? 'items-end self-end' : 'items-start self-start'}`}
    >
      <div
        className={`px-3 py-2 rounded-[14px] text-sm leading-relaxed ${
          isOwnMessage
            ? 'bg-[#2C3E2D] text-white rounded-br-[4px]'
            : 'bg-[#FBF7F0] text-[#2C3E2D] border border-[rgba(44,62,45,0.08)] rounded-bl-[4px]'
        }`}
      >
        {body}
      </div>
      <time
        dateTime={createdAt}
        className="text-[10px] text-[#8B9B8D] px-1"
      >
        {formatMessageTime(createdAt)}
      </time>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function SessionChat({ sessionId, chwId }: SessionChatProps) {
  const [inputValue, setInputValue] = useState('');
  const scrollAnchorRef = useRef<HTMLDivElement>(null);

  const { data: conversations, isLoading: convsLoading } = useConversations();

  const conversationId =
    conversations?.find(
      (c) => c.session_id === sessionId
    )?.id ?? '';

  const {
    data: messages,
    isLoading: messagesLoading,
    isError,
  } = useMessages(conversationId);

  const { mutate: sendMessage, isPending: isSending } = useSendMessage(conversationId);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed || !conversationId || isSending) return;
    sendMessage(trimmed, {
      onSuccess: () => setInputValue(''),
    });
  }, [inputValue, conversationId, isSending, sendMessage]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      handleSend();
    },
    [handleSend]
  );

  const isLoading = convsLoading || (!!conversationId && messagesLoading);
  const hasNoConversation = !convsLoading && !conversationId;

  if (hasNoConversation) {
    return (
      <div className="mt-3 rounded-[12px] border border-[rgba(44,62,45,0.08)] bg-white p-4">
        <p className="text-xs text-[#8B9B8D] text-center">
          No chat linked to this session yet.
        </p>
      </div>
    );
  }

  return (
    <section
      aria-label="Session chat"
      className="mt-3 rounded-[14px] border border-[rgba(44,62,45,0.1)] bg-white overflow-hidden flex flex-col"
      style={{ minHeight: '200px', maxHeight: '340px' }}
    >
      {/* Header */}
      <div className="px-3 py-2 border-b border-[rgba(44,62,45,0.08)] shrink-0">
        <p className="text-[10px] font-semibold text-[#8B9B8D] uppercase tracking-wider">
          Chat
        </p>
      </div>

      {/* Message list */}
      <div
        role="log"
        aria-live="polite"
        aria-label="Message history"
        className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2"
      >
        {isLoading && (
          <div className="flex-1 flex items-center justify-center" role="status">
            <Loader2 size={20} className="text-[#6B8F71] animate-spin" />
          </div>
        )}

        {isError && (
          <p className="text-xs text-red-500 text-center py-4" role="alert">
            Failed to load messages. Please try again.
          </p>
        )}

        {!isLoading && !isError && (!messages || messages.length === 0) && (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 py-6" role="status">
            <div className="w-9 h-9 rounded-full bg-[rgba(107,143,113,0.12)] flex items-center justify-center">
              <MessageSquare size={16} className="text-[#6B8F71]" />
            </div>
            <p className="text-xs text-[#8B9B8D] text-center leading-relaxed">
              No messages yet.<br />Start the conversation!
            </p>
          </div>
        )}

        {!isLoading && !isError && messages?.map((msg) => (
          <MessageBubble
            key={msg.id}
            body={msg.body}
            createdAt={msg.created_at}
            isOwnMessage={msg.sender_id === chwId}
          />
        ))}

        <div ref={scrollAnchorRef} aria-hidden="true" />
      </div>

      {/* Input area */}
      <form
        onSubmit={handleSubmit}
        className="shrink-0 border-t border-[rgba(44,62,45,0.08)] px-3 py-2 flex items-end gap-2"
      >
        <textarea
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          rows={1}
          disabled={!conversationId || isSending}
          aria-label="Message input"
          className="flex-1 text-sm text-[#2C3E2D] bg-[#FAFAF9] border border-[rgba(44,62,45,0.1)] rounded-[12px] px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-[#6B8F71] placeholder:text-[#8B9B8D] disabled:opacity-50 leading-relaxed"
          style={{ maxHeight: '88px', overflowY: 'auto' }}
        />
        <button
          type="submit"
          disabled={!inputValue.trim() || !conversationId || isSending}
          aria-label="Send message"
          className="shrink-0 w-9 h-9 rounded-[12px] bg-[#6B8F71] hover:bg-[#5a7a60] active:bg-[#4e6b54] disabled:opacity-40 disabled:cursor-not-allowed text-white flex items-center justify-center transition-colors"
        >
          {isSending ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <Send size={15} />
          )}
        </button>
      </form>
    </section>
  );
}
