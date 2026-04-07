import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Star, MessageCircle, XCircle, CalendarCheck, CheckCircle, ChevronDown, ChevronUp, Inbox } from 'lucide-react';
import { Badge } from '../../shared/components/Badge';
import { VerticalIcon } from '../../shared/components/VerticalIcon';
import {
  sessions,
  sessionModeLabels,
  type Session,
  type SessionStatus,
} from '../../data/mock';

// ─── Constants ────────────────────────────────────────────────────────────────

type TabKey = 'active' | 'completed';

/** Mock: which member's view we are showing. */
const MOCK_MEMBER_NAME = 'Rosa Delgado';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

function getInitialsStyle(initials: string): string {
  const styles = [
    'bg-[#D0F0D0] text-[#00B050]',
    'bg-blue-100 text-[#0077B6]',
    'bg-purple-100 text-purple-700',
    'bg-amber-100 text-amber-700',
  ];
  return styles[initials.charCodeAt(0) % styles.length];
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface ToastProps {
  message: string;
}

function Toast({ message }: ToastProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-[#1A1A1A] text-white text-sm font-medium px-4 py-3 rounded-[12px] shadow-lg max-w-[calc(100vw-2rem)]"
    >
      <CheckCircle size={16} className="text-[#00B050] shrink-0" aria-hidden="true" />
      {message}
    </div>
  );
}

interface ConfirmCancelDialogProps {
  sessionId: string;
  chwName: string;
  onConfirm: (id: string) => void;
  onDismiss: () => void;
}

function ConfirmCancelDialog({
  sessionId,
  chwName,
  onConfirm,
  onDismiss,
}: ConfirmCancelDialogProps) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-dialog-heading"
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div className="bg-white rounded-[16px] w-full max-w-sm p-6 shadow-xl">
        <h2
          id="cancel-dialog-heading"
          className="text-base font-bold text-[#1A1A1A] mb-2"
        >
          Cancel Session?
        </h2>
        <p className="text-sm text-[#555555] mb-5">
          Are you sure you want to cancel your session with{' '}
          <strong>{chwName}</strong>? This cannot be undone.
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => onConfirm(sessionId)}
            className="flex-1 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold py-2.5 rounded-[8px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400"
          >
            Yes, Cancel
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="flex-1 bg-white border border-[#E5E7EB] hover:bg-[#F8FAFB] text-[#555555] text-sm font-semibold py-2.5 rounded-[8px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#AAAAAA]"
          >
            Keep Session
          </button>
        </div>
      </div>
    </div>
  );
}

interface StarRatingInputProps {
  sessionId: string;
  currentRating: number;
  onRate: (sessionId: string, rating: number) => void;
}

function StarRatingInput({ sessionId, currentRating, onRate }: StarRatingInputProps) {
  const [hovered, setHovered] = useState<number>(0);

  const displayRating = hovered > 0 ? hovered : currentRating;

  return (
    <div className="flex items-center gap-1" aria-label={`Rate this session, currently ${currentRating} stars`}>
      {Array.from({ length: 5 }, (_, i) => {
        const starValue = i + 1;
        const isFilled = starValue <= displayRating;
        const isRated = currentRating > 0;

        return (
          <button
            key={i}
            type="button"
            onClick={() => !isRated && onRate(sessionId, starValue)}
            onMouseEnter={() => !isRated && setHovered(starValue)}
            onMouseLeave={() => !isRated && setHovered(0)}
            disabled={isRated}
            aria-label={`${starValue} star${starValue !== 1 ? 's' : ''}`}
            className={[
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#00B050] rounded',
              isRated ? 'cursor-default' : 'cursor-pointer',
            ].join(' ')}
          >
            <Star
              size={18}
              className={
                isFilled
                  ? 'text-yellow-400 fill-yellow-400'
                  : 'text-[#E5E7EB] fill-[#E5E7EB]'
              }
              aria-hidden="true"
            />
          </button>
        );
      })}
      {currentRating > 0 && (
        <span className="ml-1 text-xs text-[#555555] font-medium">
          {currentRating}.0
        </span>
      )}
    </div>
  );
}

// ─── Active Session Card ───────────────────────────────────────────────────────

interface ActiveSessionCardProps {
  session: Session;
  onMessage: (chwName: string) => void;
  onRequestCancel: (sessionId: string) => void;
}

function ActiveSessionCard({
  session,
  onMessage,
  onRequestCancel,
}: ActiveSessionCardProps) {
  const initials = getInitials(session.chwName);
  const initStyle = getInitialsStyle(initials);

  return (
    <article
      className="bg-white rounded-[12px] border border-[#E5E7EB] p-4"
      aria-label={`Active session with ${session.chwName}`}
    >
      {/* Top row: avatar + CHW info + badges */}
      <div className="flex items-start gap-3 mb-3">
        <div
          className={`w-10 h-10 rounded-full ${initStyle} flex items-center justify-center font-bold text-xs shrink-0`}
          aria-hidden="true"
        >
          {initials}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-0.5">
            <p className="text-sm font-bold text-[#1A1A1A]">{session.chwName}</p>
            <Badge variant="session-status" value={session.status as SessionStatus} />
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <div
              className="w-5 h-5 rounded-[4px] bg-[#F8FAFB] border border-[#E5E7EB] flex items-center justify-center shrink-0"
              aria-hidden="true"
            >
              <VerticalIcon vertical={session.vertical} size={12} />
            </div>
            <Badge variant="vertical" value={session.vertical} />
            <span className="text-xs text-[#AAAAAA]">
              {sessionModeLabels[session.mode]}
            </span>
          </div>
        </div>
      </div>

      {/* Date/time */}
      <div className="flex items-center gap-2 mb-3 px-1">
        <CalendarCheck size={14} className="text-[#0077B6] shrink-0" aria-hidden="true" />
        <span className="text-xs text-[#555555]">{formatDate(session.scheduledAt)}</span>
      </div>

      {/* Notes preview */}
      {session.notes && (
        <p className="text-xs text-[#AAAAAA] italic px-1 mb-3 line-clamp-1">
          {session.notes}
        </p>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onMessage(session.chwName.split(' ')[0])}
          className="flex-1 flex items-center justify-center gap-1.5 bg-[#0077B6] hover:bg-[#005A8C] active:bg-[#00466E] text-white text-xs font-semibold py-2.5 rounded-[8px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0077B6]"
          aria-label={`Message ${session.chwName}`}
        >
          <MessageCircle size={13} aria-hidden="true" />
          Message CHW
        </button>
        <button
          type="button"
          onClick={() => onRequestCancel(session.id)}
          className="flex items-center justify-center gap-1.5 bg-white border border-[#E5E7EB] hover:bg-[#F8FAFB] text-[#555555] text-xs font-semibold px-4 py-2.5 rounded-[8px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#AAAAAA]"
          aria-label={`Cancel session with ${session.chwName}`}
        >
          <XCircle size={13} aria-hidden="true" />
          Cancel
        </button>
      </div>
    </article>
  );
}

// ─── Completed Session Card ────────────────────────────────────────────────────

interface CompletedSessionCardProps {
  session: Session;
  rating: number;
  isExpanded: boolean;
  onRate: (sessionId: string, rating: number) => void;
  onToggleExpand: (sessionId: string) => void;
  onBookAgain: () => void;
}

function CompletedSessionCard({
  session,
  rating,
  isExpanded,
  onRate,
  onToggleExpand,
  onBookAgain,
}: CompletedSessionCardProps) {
  const initials = getInitials(session.chwName);
  const initStyle = getInitialsStyle(initials);

  return (
    <article
      className="bg-white rounded-[12px] border border-[#E5E7EB] p-4"
      aria-label={`Completed session with ${session.chwName}`}
    >
      {/* Top row */}
      <div className="flex items-start gap-3 mb-3">
        <div
          className={`w-10 h-10 rounded-full ${initStyle} flex items-center justify-center font-bold text-xs shrink-0`}
          aria-hidden="true"
        >
          {initials}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-0.5">
            <p className="text-sm font-bold text-[#1A1A1A]">{session.chwName}</p>
            <Badge variant="session-status" value={session.status as SessionStatus} />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="vertical" value={session.vertical} />
            <span className="text-xs text-[#AAAAAA]">
              {sessionModeLabels[session.mode]}
            </span>
          </div>
        </div>
      </div>

      {/* Date + duration */}
      <div className="flex items-center gap-4 mb-3 px-1">
        <span className="text-xs text-[#555555]">
          {formatShortDate(session.scheduledAt)}
        </span>
        {session.durationMinutes && (
          <>
            <span className="text-xs text-[#AAAAAA]">·</span>
            <span className="text-xs text-[#555555]">
              {session.durationMinutes} min
            </span>
          </>
        )}
      </div>

      {/* Rating */}
      <div className="flex items-center justify-between mb-3 px-1">
        <span className="text-xs font-semibold text-[#1A1A1A]">
          {rating > 0 ? 'Your rating' : 'Rate this session'}
        </span>
        <StarRatingInput
          sessionId={session.id}
          currentRating={rating}
          onRate={onRate}
        />
      </div>

      {/* Expandable notes */}
      {session.notes && (
        <div className="border-t border-[#E5E7EB] pt-3 mb-3">
          <button
            type="button"
            onClick={() => onToggleExpand(session.id)}
            className="flex items-center gap-1 text-xs font-medium text-[#0077B6] hover:text-[#005A8C] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0077B6] rounded"
            aria-expanded={isExpanded}
            aria-controls={`notes-${session.id}`}
          >
            {isExpanded ? (
              <>
                <ChevronUp size={13} aria-hidden="true" /> Hide notes
              </>
            ) : (
              <>
                <ChevronDown size={13} aria-hidden="true" /> View session notes
              </>
            )}
          </button>

          {isExpanded && (
            <p
              id={`notes-${session.id}`}
              className="text-xs text-[#555555] leading-relaxed mt-2 bg-[#F8FAFB] rounded-[8px] p-3"
            >
              {session.notes}
            </p>
          )}
        </div>
      )}

      {/* Book again */}
      <button
        type="button"
        onClick={onBookAgain}
        className="w-full flex items-center justify-center gap-1.5 bg-white border border-[#00B050] text-[#00B050] hover:bg-[#D0F0D0]/30 active:bg-[#D0F0D0]/60 text-xs font-semibold py-2.5 rounded-[8px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00B050]"
        aria-label={`Book another session with ${session.chwName}`}
      >
        Book Again
      </button>
    </article>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * MemberSessions — the community member's session history and management page.
 *
 * Sections:
 * - Active tab: scheduled + in_progress sessions with message/cancel actions
 * - Completed tab: past sessions with star ratings, expandable notes, book again
 * - Empty states for each tab
 */
export function MemberSessions() {
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<TabKey>('active');
  const [cancellingSessionId, setCancellingSessionId] = useState<string | null>(null);
  const [cancelledIds, setCancelledIds] = useState<Set<string>>(new Set());
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(new Set());
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Filter sessions for this member only
  const memberSessions = sessions.filter((s) => s.memberName === MOCK_MEMBER_NAME);

  const activeSessions = memberSessions.filter(
    (s) =>
      (s.status === 'scheduled' || s.status === 'in_progress') &&
      !cancelledIds.has(s.id),
  );

  const completedSessions = memberSessions.filter((s) => s.status === 'completed');

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    const timer = setTimeout(() => setToastMessage(null), 3500);
    return () => clearTimeout(timer);
  }, []);

  const handleMessage = useCallback(
    (firstName: string) => {
      showToast(`Message sent to ${firstName}. They'll respond soon.`);
    },
    [showToast],
  );

  const handleRequestCancel = useCallback((sessionId: string) => {
    setCancellingSessionId(sessionId);
  }, []);

  const handleConfirmCancel = useCallback(
    (sessionId: string) => {
      setCancelledIds((prev) => new Set(prev).add(sessionId));
      setCancellingSessionId(null);
      showToast('Session cancelled successfully.');
    },
    [showToast],
  );

  const handleDismissCancel = useCallback(() => {
    setCancellingSessionId(null);
  }, []);

  const handleRate = useCallback((sessionId: string, rating: number) => {
    setRatings((prev) => ({ ...prev, [sessionId]: rating }));
  }, []);

  const handleToggleExpand = useCallback((sessionId: string) => {
    setExpandedNotes((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const handleBookAgain = useCallback(() => {
    navigate('/member/find');
  }, [navigate]);

  const cancellingSession = cancellingSessionId
    ? sessions.find((s) => s.id === cancellingSessionId)
    : null;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Toast */}
      {toastMessage && <Toast message={toastMessage} />}

      {/* Cancel confirmation dialog */}
      {cancellingSession && (
        <ConfirmCancelDialog
          sessionId={cancellingSession.id}
          chwName={cancellingSession.chwName}
          onConfirm={handleConfirmCancel}
          onDismiss={handleDismissCancel}
        />
      )}

      {/* Page header */}
      <div>
        <h2 className="text-2xl font-semibold text-[#0077B6]">My Sessions</h2>
        <p className="text-sm text-[#555555] mt-1">
          View and manage your CHW sessions
        </p>
      </div>

      {/* Tab bar */}
      <div
        role="tablist"
        aria-label="Session tabs"
        className="flex gap-1 bg-[#F8FAFB] border border-[#E5E7EB] rounded-[10px] p-1"
      >
        {(
          [
            { key: 'active' as TabKey, label: 'Active', count: activeSessions.length },
            {
              key: 'completed' as TabKey,
              label: 'Completed',
              count: completedSessions.length,
            },
          ] as const
        ).map(({ key, label, count }) => {
          const isActive = activeTab === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveTab(key)}
              className={[
                'flex-1 flex items-center justify-center gap-2 py-2 text-sm font-semibold rounded-[8px] transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00B050]',
                isActive
                  ? 'bg-white text-[#1A1A1A] shadow-sm'
                  : 'text-[#AAAAAA] hover:text-[#555555]',
              ].join(' ')}
            >
              {label}
              {count > 0 && (
                <span
                  className={[
                    'inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-bold',
                    isActive
                      ? 'bg-[#00B050] text-white'
                      : 'bg-[#E5E7EB] text-[#555555]',
                  ].join(' ')}
                  aria-label={`${count} ${label.toLowerCase()} sessions`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {activeTab === 'active' ? (
        <section aria-label="Active sessions">
          {activeSessions.length > 0 ? (
            <div className="space-y-3">
              {activeSessions.map((session) => (
                <ActiveSessionCard
                  key={session.id}
                  session={session}
                  onMessage={handleMessage}
                  onRequestCancel={handleRequestCancel}
                />
              ))}
            </div>
          ) : (
            <div
              className="bg-white rounded-[12px] border border-[#E5E7EB] p-10 flex flex-col items-center gap-3 text-center"
              role="status"
            >
              <div className="w-12 h-12 rounded-full bg-[#F8FAFB] border border-[#E5E7EB] flex items-center justify-center">
                <Inbox size={22} className="text-[#AAAAAA]" aria-hidden="true" />
              </div>
              <p className="text-sm font-semibold text-[#1A1A1A]">
                No active sessions
              </p>
              <p className="text-xs text-[#AAAAAA] max-w-xs">
                No sessions yet. Find a CHW to get started!
              </p>
              <button
                type="button"
                onClick={() => navigate('/member/find')}
                className="mt-1 bg-[#00B050] hover:bg-[#008F40] text-white text-sm font-semibold px-5 py-2.5 rounded-[8px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00B050]"
              >
                Find a CHW
              </button>
            </div>
          )}
        </section>
      ) : (
        <section aria-label="Completed sessions">
          {completedSessions.length > 0 ? (
            <div className="space-y-3">
              {completedSessions.map((session) => (
                <CompletedSessionCard
                  key={session.id}
                  session={session}
                  rating={ratings[session.id] ?? 0}
                  isExpanded={expandedNotes.has(session.id)}
                  onRate={handleRate}
                  onToggleExpand={handleToggleExpand}
                  onBookAgain={handleBookAgain}
                />
              ))}
            </div>
          ) : (
            <div
              className="bg-white rounded-[12px] border border-[#E5E7EB] p-10 flex flex-col items-center gap-3 text-center"
              role="status"
            >
              <div className="w-12 h-12 rounded-full bg-[#F8FAFB] border border-[#E5E7EB] flex items-center justify-center">
                <Inbox size={22} className="text-[#AAAAAA]" aria-hidden="true" />
              </div>
              <p className="text-sm font-semibold text-[#1A1A1A]">
                No completed sessions
              </p>
              <p className="text-xs text-[#AAAAAA] max-w-xs">
                Your completed sessions will appear here after your first meeting.
              </p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
