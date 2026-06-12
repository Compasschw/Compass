/**
 * MemberSessionsScreen — paginated sessions table (T21).
 *
 * Redesigned to mirror the CHW Sessions table pattern:
 *   - Web:    responsive table with columns Date & Time / Type / Status /
 *             Duration / Modality / Actions inside a Card.
 *   - Native: stacked SessionRow cards with the same data fields.
 *
 * Pagination is client-side (20 rows per page) — the existing /sessions
 * endpoint returns a flat array with no server-side cursor.
 *
 * Date & Time column is sortable (asc / desc). All other columns are
 * display-only in this iteration.
 *
 * Preserved verbatim:
 *   - useSessions / useMyRequests / useCancelRequest data hooks
 *   - ChatModal (tap "View notes" on a completed session → opens inline chat)
 *   - ConfirmCancelModal (cancel confirmation for scheduled sessions)
 *   - RateChwModal (rate CHW after a completed session)
 *   - ToastBanner (ephemeral feedback)
 *   - useRefreshControl (pull-to-refresh on native)
 *
 * Visual language: theme/tokens (canonical) — NO imports from theme/colors.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  CalendarCheck,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileText,
  MessageCircle,
  Sparkles,
  Star,
  X,
  XCircle,
} from 'lucide-react-native';

import { colors as tokens, numerals, spacing, radius, shadows } from '../../theme/tokens';
import { typography } from '../../theme/typography';
import {
  sessionModeLabels,
  sessionStatusLabels,
  verticalLabels,
  type SessionStatus,
  type Vertical,
  type SessionMode,
} from '../../data/mock';
import {
  AppShell,
  Card,
  EmptyState,
  PageHeader,
  PageWrap,
  Pill,
  SectionHeader,
  type PillVariant,
} from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import {
  useSessions,
  useMyRequests,
  useCancelRequest,
  type SessionData,
  type ServiceRequestData,
} from '../../hooks/useApiQueries';
import { useRefreshControl } from '../../hooks/useRefreshControl';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import { SessionChat } from '../../components/sessions/SessionChat';
import {
  VERTICAL_COLOR,
  VERTICAL_LABEL,
  verticalLabel,
  type Vertical as VerticalLib,
} from '../../lib/verticals';
import { RateChwModal } from '../../components/testimonials/RateChwModal';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Rows shown per page in the paginated sessions table. */
const SESSIONS_PAGE_SIZE = 20;

type SortDirection = 'asc' | 'desc';

// ─── Status → Pill variant map ────────────────────────────────────────────────

/**
 * Maps a session status string to the design-system Pill variant so status
 * chips are colour-coded consistently with the CHW Sessions table.
 */
function statusToPillVariant(status: string): PillVariant {
  switch (status as SessionStatus) {
    case 'scheduled':    return 'blue';
    case 'in_progress':  return 'amber';
    case 'completed':    return 'emerald';
    case 'cancelled':    return 'gray';
    default:             return 'gray';
  }
}

// Delegate to lib/verticals — single source of truth.
const verticalColors: Record<Vertical, string> = VERTICAL_COLOR as Record<Vertical, string>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format ISO8601 to "Mon, May 12, 2:34 PM" */
function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    month:   'short',
    day:     'numeric',
    hour:    'numeric',
    minute:  '2-digit',
  });
}

/** Format ISO8601 date portion to "May 12, 2026" */
function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day:   'numeric',
    year:  'numeric',
  });
}

/**
 * Format duration from minutes to "mm:ss" display string.
 * Returns "—" when duration is not available (scheduled or in-progress sessions).
 */
function formatDuration(minutes: number | undefined): string {
  if (minutes == null) return '—';
  const m = Math.floor(minutes);
  const s = Math.round((minutes - m) * 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Derive a human-readable modality label from the raw mode string.
 * Delegates to the shared sessionModeLabels map.
 */
function formatModality(mode: string): string {
  return sessionModeLabels[mode as SessionMode] ?? mode;
}

/** Format an ISO8601 timestamp into a short time string (e.g. "2:34 PM"). */
function formatAITimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour:   'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return iso;
  }
}

// ─── ToastBanner ──────────────────────────────────────────────────────────────

interface ToastBannerProps {
  message: string;
}

function ToastBanner({ message }: ToastBannerProps): React.JSX.Element {
  return (
    <View
      style={toastStyles.container}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <CheckCircle color="#FFFFFF" size={15} />
      <Text style={toastStyles.text}>{message}</Text>
    </View>
  );
}

const toastStyles = StyleSheet.create({
  container: {
    position:       'absolute',
    top:            Platform.OS === 'ios' ? 54 : 16,
    left:           16,
    right:          16,
    zIndex:         99,
    flexDirection:  'row',
    alignItems:     'center',
    gap:            8,
    backgroundColor: tokens.primary,
    paddingHorizontal: 16,
    paddingVertical:   12,
    borderRadius:   16,
    ...Platform.select({
      ios: {
        shadowColor:   '#000',
        shadowOffset:  { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius:  12,
      },
      android: { elevation: 8 },
    }),
  } as ViewStyle,
  text: {
    fontSize:   14,
    fontWeight: '600',
    color:      '#FFFFFF',
    flex:       1,
  } as TextStyle,
});

// ─── ConfirmCancelModal ───────────────────────────────────────────────────────

interface ConfirmCancelModalProps {
  session:   SessionData;
  visible:   boolean;
  onConfirm: (sessionId: string) => void;
  onDismiss: () => void;
}

function ConfirmCancelModal({
  session,
  visible,
  onConfirm,
  onDismiss,
}: ConfirmCancelModalProps): React.JSX.Element {
  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={onDismiss}
    >
      <View style={cancelModalStyles.backdrop}>
        <View style={cancelModalStyles.dialog}>
          <Text style={cancelModalStyles.title}>Cancel Session?</Text>
          <Text style={cancelModalStyles.body}>
            Are you sure you want to cancel your session with{' '}
            <Text style={{ fontWeight: '700' }}>{session.chwName ?? 'your CHW'}</Text>?
            {' '}This cannot be undone.
          </Text>
          <View style={cancelModalStyles.btnRow}>
            <TouchableOpacity
              onPress={() => onConfirm(session.id)}
              style={cancelModalStyles.confirmBtn}
              accessibilityRole="button"
              accessibilityLabel="Confirm cancel session"
            >
              <Text style={cancelModalStyles.confirmBtnText}>Yes, Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onDismiss}
              style={cancelModalStyles.keepBtn}
              accessibilityRole="button"
              accessibilityLabel="Keep session"
            >
              <Text style={cancelModalStyles.keepBtnText}>Keep Session</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const cancelModalStyles = StyleSheet.create({
  backdrop: {
    flex:            1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems:      'center',
    justifyContent:  'center',
    padding:         24,
  } as ViewStyle,
  dialog: {
    backgroundColor: tokens.cardBg,
    borderRadius:    radius.xl,
    padding:         spacing.xxl,
    width:           '100%',
    maxWidth:        360,
  } as ViewStyle,
  title: {
    fontSize:     16,
    fontWeight:   '700',
    color:        tokens.textPrimary,
    marginBottom: spacing.sm,
  } as TextStyle,
  body: {
    fontSize:     14,
    color:        tokens.textSecondary,
    marginBottom: spacing.xl,
    lineHeight:   20,
  } as TextStyle,
  btnRow: {
    flexDirection: 'row',
    gap:           10,
  } as ViewStyle,
  confirmBtn: {
    flex:            1,
    backgroundColor: '#EF4444',
    borderRadius:    radius.lg,
    paddingVertical: 12,
    alignItems:      'center',
  } as ViewStyle,
  confirmBtnText: {
    fontSize:   14,
    fontWeight: '700',
    color:      '#FFFFFF',
  } as TextStyle,
  keepBtn: {
    flex:            1,
    backgroundColor: tokens.cardBg,
    borderWidth:     1,
    borderColor:     tokens.cardBorder,
    borderRadius:    radius.lg,
    paddingVertical: 12,
    alignItems:      'center',
  } as ViewStyle,
  keepBtnText: {
    fontSize:   14,
    fontWeight: '600',
    color:      tokens.textSecondary,
  } as TextStyle,
});

// ─── ChatModal ────────────────────────────────────────────────────────────────

interface ChatModalProps {
  visible:   boolean;
  sessionId: string;
  onClose:   () => void;
}

function ChatModal({ visible, sessionId, onClose }: ChatModalProps): React.JSX.Element {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      accessible
      accessibilityViewIsModal
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: tokens.pageBg }} edges={['top']}>
        <View style={chatModalStyles.header}>
          <Text style={chatModalStyles.headerTitle}>Session Notes</Text>
          <TouchableOpacity
            style={chatModalStyles.closeButton}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close notes"
          >
            <X size={20} color={tokens.textPrimary} />
          </TouchableOpacity>
        </View>
        <SessionChat sessionId={sessionId} />
      </SafeAreaView>
    </Modal>
  );
}

const chatModalStyles = StyleSheet.create({
  header: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'space-between',
    paddingHorizontal: spacing.xl,
    paddingVertical:   spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
    backgroundColor:   tokens.cardBg,
  } as ViewStyle,
  headerTitle: {
    fontSize:   18,
    fontWeight: '700',
    color:      tokens.textPrimary,
  } as TextStyle,
  closeButton: {
    width:           36,
    height:          36,
    borderRadius:    18,
    backgroundColor: tokens.pageBg,
    alignItems:      'center',
    justifyContent:  'center',
    borderWidth:     1,
    borderColor:     tokens.cardBorder,
  } as ViewStyle,
});

// ─── NotesExpandedCard ────────────────────────────────────────────────────────

/**
 * Expandable notes panel rendered inline below a session row.
 * Shows CHW Notes and, when present, the AI Summary.
 */
interface NotesExpandedCardProps {
  session: SessionData;
}

function NotesExpandedCard({ session }: NotesExpandedCardProps): React.JSX.Element {
  return (
    <View style={notesStyles.container}>
      {/* CHW Notes */}
      {session.notes ? (
        <View style={notesStyles.chwCard}>
          <Text style={notesStyles.cardLabel}>CHW Notes</Text>
          <Text style={notesStyles.chwText}>{session.notes}</Text>
        </View>
      ) : (
        <Text style={notesStyles.emptyText}>No session notes available.</Text>
      )}

      {/* AI Summary */}
      {session.aiSummary &&
       session.aiSummaryGeneratedAt &&
       session.aiSummaryExcluded !== true ? (
        <View style={notesStyles.aiCard}>
          <View style={notesStyles.aiHeader}>
            <Sparkles size={12} color={tokens.emerald700} />
            <Text style={notesStyles.aiLabel}>AI Summary</Text>
            <View style={notesStyles.aiBadge}>
              <Text style={notesStyles.aiBadgeText}>Generated from transcript</Text>
            </View>
            <Text style={notesStyles.aiTimestamp}>
              {formatAITimestamp(session.aiSummaryGeneratedAt)}
            </Text>
          </View>
          <Text style={notesStyles.aiText} selectable>
            {session.aiSummary}
          </Text>
        </View>
      ) : session.aiSummary && session.aiSummaryExcluded === true ? (
        <Text style={notesStyles.excludedNote}>
          AI summary was generated but excluded by CHW.
        </Text>
      ) : null}
    </View>
  );
}

const notesStyles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.lg,
    paddingBottom:     spacing.lg,
    gap:               spacing.sm,
  } as ViewStyle,
  chwCard: {
    backgroundColor: tokens.pageBg,
    borderRadius:    radius.md,
    padding:         spacing.md,
    borderWidth:     1,
    borderColor:     tokens.cardBorder,
    gap:             6,
  } as ViewStyle,
  cardLabel: {
    fontSize:      10,
    fontWeight:    '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase' as const,
    color:         tokens.textMuted,
  } as TextStyle,
  chwText: {
    fontSize:   13,
    color:      tokens.textPrimary,
    lineHeight: 18,
  } as TextStyle,
  emptyText: {
    fontSize:   13,
    color:      tokens.textMuted,
    fontStyle:  'italic' as const,
  } as TextStyle,
  aiCard: {
    backgroundColor: '#EDF4F8',
    borderRadius:    radius.md,
    padding:         spacing.md,
    borderWidth:     1,
    borderColor:     '#C8D8E4',
    gap:             spacing.sm,
  } as ViewStyle,
  aiHeader: {
    flexDirection: 'row',
    alignItems:    'center',
    flexWrap:      'wrap' as const,
    gap:           5,
  } as ViewStyle,
  aiLabel: {
    fontSize:      10,
    fontWeight:    '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase' as const,
    color:         tokens.emerald700,
  } as TextStyle,
  aiBadge: {
    backgroundColor: tokens.emerald700 + '20',
    borderRadius:    100,
    paddingHorizontal: 6,
    paddingVertical:   1,
  } as ViewStyle,
  aiBadgeText: {
    fontSize:      9,
    fontWeight:    '600',
    color:         tokens.emerald700,
    letterSpacing: 0.2,
  } as TextStyle,
  aiTimestamp: {
    fontSize:   10,
    color:      tokens.textMuted,
    marginLeft: 'auto' as unknown as number,
  } as TextStyle,
  aiText: {
    fontSize:  13,
    fontStyle: 'italic' as const,
    color:     tokens.textPrimary,
    lineHeight: 18,
  } as TextStyle,
  excludedNote: {
    fontSize:  12,
    color:     tokens.textMuted,
    fontStyle: 'italic' as const,
    paddingLeft: 4,
  } as TextStyle,
});

// ─── Table header row (web only) ──────────────────────────────────────────────

interface TableHeaderProps {
  sortDirection: SortDirection;
  onToggleSort:  () => void;
}

function TableHeader({ sortDirection, onToggleSort }: TableHeaderProps): React.JSX.Element {
  const SortIcon = sortDirection === 'asc' ? ArrowUp : ArrowDown;

  return (
    <View style={tableHeaderStyles.row} accessibilityRole="none">
      {/* Date & Time — sortable */}
      <TouchableOpacity
        style={[tableHeaderStyles.cell, tableHeaderStyles.dateCell, tableHeaderStyles.sortableCell]}
        onPress={onToggleSort}
        accessibilityRole="button"
        accessibilityLabel={`Sort by date, currently ${sortDirection === 'asc' ? 'oldest first' : 'newest first'}`}
      >
        <Text style={tableHeaderStyles.label}>Date & Time</Text>
        <SortIcon size={13} color={tokens.textSecondary} />
      </TouchableOpacity>

      <View style={[tableHeaderStyles.cell, tableHeaderStyles.typeCell]}>
        <Text style={tableHeaderStyles.label}>Type</Text>
      </View>

      <View style={[tableHeaderStyles.cell, tableHeaderStyles.statusCell]}>
        <Text style={tableHeaderStyles.label}>Status</Text>
      </View>

      <View style={[tableHeaderStyles.cell, tableHeaderStyles.durationCell]}>
        <Text style={tableHeaderStyles.label}>Duration</Text>
      </View>

      <View style={[tableHeaderStyles.cell, tableHeaderStyles.modalityCell]}>
        <Text style={tableHeaderStyles.label}>Modality</Text>
      </View>

      <View style={[tableHeaderStyles.cell, tableHeaderStyles.actionsCell]}>
        <Text style={tableHeaderStyles.label}>Actions</Text>
      </View>
    </View>
  );
}

const tableHeaderStyles = StyleSheet.create({
  row: {
    flexDirection:     'row',
    alignItems:        'center',
    backgroundColor:   tokens.pageBg,
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
    borderTopLeftRadius:  radius.xl,
    borderTopRightRadius: radius.xl,
  } as ViewStyle,

  cell: {
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.md,
    flexShrink:        0,
  } as ViewStyle,

  sortableCell: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           4,
    // @ts-ignore — web-only
    cursor:        'pointer',
  } as ViewStyle,

  label: {
    fontSize:      11,
    fontWeight:    '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
    color:         tokens.textSecondary,
  } as TextStyle,

  // Column width distribution
  dateCell:     { flex: 2 } as ViewStyle,
  typeCell:     { flex: 1.5 } as ViewStyle,
  statusCell:   { flex: 1 } as ViewStyle,
  durationCell: { flex: 1 } as ViewStyle,
  modalityCell: { flex: 1 } as ViewStyle,
  actionsCell:  { flex: 1.5, alignItems: 'flex-end' as const } as ViewStyle,
});

// ─── Table data row (web only) ────────────────────────────────────────────────

interface SessionTableRowProps {
  session:       SessionData;
  isExpanded:    boolean;
  isCancelled:   boolean;
  hasTestimonial: boolean;
  onViewNotes:   (session: SessionData) => void;
  onRequestCancel: (session: SessionData) => void;
  onOpenRateModal: (session: SessionData) => void;
  onToggleExpand:  (sessionId: string) => void;
}

function SessionTableRow({
  session,
  isExpanded,
  isCancelled,
  hasTestimonial,
  onViewNotes,
  onRequestCancel,
  onOpenRateModal,
  onToggleExpand,
}: SessionTableRowProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false);
  const isScheduled = session.status === 'scheduled';
  const isCompleted = session.status === 'completed';
  const durationDisplay = isScheduled ? 'Scheduled' : formatDuration(session.durationMinutes);

  return (
    <>
      <View
        style={[tableRowStyles.row, hovered && tableRowStyles.rowHover, isCancelled && tableRowStyles.rowDimmed]}
        // @ts-ignore — web-only pointer events
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        accessible
        role="row"
        accessibilityLabel={`Session on ${formatShortDate(session.scheduledAt)}, ${session.status}`}
      >
        {/* Date & Time */}
        <View style={[tableRowStyles.cell, tableRowStyles.dateCell]}>
          <Text style={tableRowStyles.dateText}>{formatDateTime(session.scheduledAt)}</Text>
          {session.chwName ? (
            <Text style={tableRowStyles.subText}>with {session.chwName}</Text>
          ) : null}
        </View>

        {/* Type — vertical / category */}
        <View style={[tableRowStyles.cell, tableRowStyles.typeCell]}>
          <Text style={tableRowStyles.bodyText}>
            {verticalLabels[session.vertical as Vertical] ?? session.vertical}
          </Text>
        </View>

        {/* Status */}
        <View style={[tableRowStyles.cell, tableRowStyles.statusCell]}>
          <Pill variant={statusToPillVariant(session.status)} size="sm" withDot>
            {sessionStatusLabels[session.status as SessionStatus] ?? session.status}
          </Pill>
        </View>

        {/* Duration */}
        <View style={[tableRowStyles.cell, tableRowStyles.durationCell]}>
          <Text style={[tableRowStyles.bodyText, numerals.tabular]}>{durationDisplay}</Text>
        </View>

        {/* Modality */}
        <View style={[tableRowStyles.cell, tableRowStyles.modalityCell]}>
          <Text style={tableRowStyles.bodyText}>{formatModality(session.mode)}</Text>
        </View>

        {/* Actions */}
        <View style={[tableRowStyles.cell, tableRowStyles.actionsCell]}>
          {isCompleted ? (
            <View style={tableRowStyles.actionsGroup}>
              <TouchableOpacity
                style={tableRowStyles.actionBtn}
                onPress={() => onToggleExpand(session.id)}
                accessibilityRole="button"
                accessibilityLabel={isExpanded ? 'Hide session notes' : 'View session notes'}
              >
                <FileText size={13} color={tokens.primary} />
                <Text style={tableRowStyles.actionBtnText}>
                  {isExpanded ? 'Hide' : 'View notes'}
                </Text>
              </TouchableOpacity>
              {!hasTestimonial && (
                <TouchableOpacity
                  style={tableRowStyles.actionBtnSecondary}
                  onPress={() => onOpenRateModal(session)}
                  accessibilityRole="button"
                  accessibilityLabel={`Rate your session with ${session.chwName ?? 'CHW'}`}
                >
                  <Star size={13} color="#B45309" />
                  <Text style={tableRowStyles.actionBtnSecondaryText}>Rate</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : isScheduled ? (
            <TouchableOpacity
              style={tableRowStyles.cancelBtn}
              onPress={() => onRequestCancel(session)}
              accessibilityRole="button"
              accessibilityLabel={`Cancel session scheduled on ${formatShortDate(session.scheduledAt)}`}
            >
              <XCircle size={13} color={tokens.textSecondary} />
              <Text style={tableRowStyles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          ) : (
            <Text style={tableRowStyles.dashText}>—</Text>
          )}
        </View>
      </View>

      {/* Inline expanded notes row */}
      {isExpanded && isCompleted ? (
        <View style={tableRowStyles.expandedRow}>
          <NotesExpandedCard session={session} />
        </View>
      ) : null}
    </>
  );
}

const tableRowStyles = StyleSheet.create({
  row: {
    flexDirection:     'row',
    alignItems:        'center',
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
  } as ViewStyle,

  rowHover: {
    backgroundColor: '#F9FAFB',
  } as ViewStyle,

  rowDimmed: {
    opacity: 0.5,
  } as ViewStyle,

  expandedRow: {
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
    backgroundColor:   tokens.pageBg,
  } as ViewStyle,

  cell: {
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.md,
    flexShrink:        0,
  } as ViewStyle,

  // Column widths — mirrors header
  dateCell:     { flex: 2 } as ViewStyle,
  typeCell:     { flex: 1.5 } as ViewStyle,
  statusCell:   { flex: 1 } as ViewStyle,
  durationCell: { flex: 1 } as ViewStyle,
  modalityCell: { flex: 1 } as ViewStyle,
  actionsCell:  { flex: 1.5, alignItems: 'flex-end' as const } as ViewStyle,

  dateText: {
    fontSize:   14,
    fontWeight: '500',
    color:      tokens.textPrimary,
    lineHeight: 20,
  } as TextStyle,

  subText: {
    fontSize:  12,
    color:     tokens.textSecondary,
    marginTop: 1,
  } as TextStyle,

  bodyText: {
    fontSize: 14,
    color:    tokens.textPrimary,
  } as TextStyle,

  actionsGroup: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           spacing.sm,
    flexWrap:      'wrap' as const,
    justifyContent: 'flex-end',
  } as ViewStyle,

  actionBtn: {
    flexDirection:   'row',
    alignItems:      'center',
    gap:             4,
    backgroundColor: tokens.emerald100,
    borderRadius:    radius.sm,
    paddingHorizontal: 10,
    paddingVertical:   6,
  } as ViewStyle,

  actionBtnText: {
    fontSize:   12,
    fontWeight: '600',
    color:      tokens.emerald700,
  } as TextStyle,

  actionBtnSecondary: {
    flexDirection:   'row',
    alignItems:      'center',
    gap:             4,
    backgroundColor: '#FEF3C7',
    borderRadius:    radius.sm,
    paddingHorizontal: 10,
    paddingVertical:   6,
  } as ViewStyle,

  actionBtnSecondaryText: {
    fontSize:   12,
    fontWeight: '600',
    color:      '#B45309',
  } as TextStyle,

  cancelBtn: {
    flexDirection:   'row',
    alignItems:      'center',
    gap:             4,
    borderWidth:     1,
    borderColor:     tokens.cardBorder,
    borderRadius:    radius.sm,
    paddingHorizontal: 10,
    paddingVertical:   6,
    backgroundColor: tokens.cardBg,
  } as ViewStyle,

  cancelBtnText: {
    fontSize:   12,
    fontWeight: '600',
    color:      tokens.textSecondary,
  } as TextStyle,

  dashText: {
    fontSize: 14,
    color:    tokens.textMuted,
  } as TextStyle,
});

// ─── Native session card ──────────────────────────────────────────────────────

/**
 * Card-format session display for native (iOS / Android).
 * Contains the same six data points as the web table row.
 */
interface SessionNativeCardProps {
  session:        SessionData;
  isExpanded:     boolean;
  hasTestimonial: boolean;
  onViewNotes:    (session: SessionData) => void;
  onRequestCancel: (session: SessionData) => void;
  onOpenRateModal: (session: SessionData) => void;
  onToggleExpand:  (sessionId: string) => void;
}

function SessionNativeCard({
  session,
  isExpanded,
  hasTestimonial,
  onViewNotes,
  onRequestCancel,
  onOpenRateModal,
  onToggleExpand,
}: SessionNativeCardProps): React.JSX.Element {
  const isScheduled = session.status === 'scheduled';
  const isCompleted = session.status === 'completed';
  const verticalColor = verticalColors[session.vertical as Vertical] ?? tokens.primary;

  return (
    <Card style={nativeCardStyles.card}>
      {/* Top row: date + status pill */}
      <View style={nativeCardStyles.topRow}>
        <View style={nativeCardStyles.dateBlock}>
          <CalendarCheck size={13} color={tokens.emerald700} />
          <Text style={nativeCardStyles.dateText}>{formatDateTime(session.scheduledAt)}</Text>
        </View>
        <Pill variant={statusToPillVariant(session.status)} size="sm" withDot>
          {sessionStatusLabels[session.status as SessionStatus] ?? session.status}
        </Pill>
      </View>

      {/* CHW name */}
      {session.chwName ? (
        <Text style={nativeCardStyles.chwName}>with {session.chwName}</Text>
      ) : null}

      {/* Meta row: vertical · modality · duration */}
      <View style={nativeCardStyles.metaRow}>
        <View style={[nativeCardStyles.verticalDot, { backgroundColor: verticalColor }]} />
        <Text style={nativeCardStyles.metaText}>
          {verticalLabels[session.vertical as Vertical] ?? session.vertical}
        </Text>
        <Text style={nativeCardStyles.metaSep}>·</Text>
        <Text style={nativeCardStyles.metaText}>{formatModality(session.mode)}</Text>
        <Text style={nativeCardStyles.metaSep}>·</Text>
        <Text style={[nativeCardStyles.metaText, numerals.tabular]}>
          {isScheduled ? 'Scheduled' : formatDuration(session.durationMinutes)}
        </Text>
      </View>

      {/* Action row */}
      <View style={nativeCardStyles.actionRow}>
        {isCompleted ? (
          <>
            <TouchableOpacity
              style={nativeCardStyles.primaryBtn}
              onPress={() => onToggleExpand(session.id)}
              accessibilityRole="button"
              accessibilityLabel={isExpanded ? 'Hide session notes' : 'View session notes'}
            >
              <FileText size={13} color={tokens.cardBg} />
              <Text style={nativeCardStyles.primaryBtnText}>
                {isExpanded ? 'Hide Notes' : 'View Notes'}
              </Text>
            </TouchableOpacity>
            {!hasTestimonial && (
              <TouchableOpacity
                style={nativeCardStyles.rateBtn}
                onPress={() => onOpenRateModal(session)}
                accessibilityRole="button"
                accessibilityLabel={`Rate your session with ${session.chwName ?? 'CHW'}`}
              >
                <Star size={13} color="#B45309" />
                <Text style={nativeCardStyles.rateBtnText}>Rate CHW</Text>
              </TouchableOpacity>
            )}
          </>
        ) : isScheduled ? (
          <TouchableOpacity
            style={nativeCardStyles.cancelBtn}
            onPress={() => onRequestCancel(session)}
            accessibilityRole="button"
            accessibilityLabel={`Cancel session on ${formatShortDate(session.scheduledAt)}`}
          >
            <XCircle size={13} color={tokens.textSecondary} />
            <Text style={nativeCardStyles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Expanded notes (native inline) */}
      {isExpanded && isCompleted ? (
        <View style={nativeCardStyles.notesContainer}>
          <View style={nativeCardStyles.notesDivider} />
          <NotesExpandedCard session={session} />
        </View>
      ) : null}
    </Card>
  );
}

const nativeCardStyles = StyleSheet.create({
  card: {
    padding:      spacing.lg,
    marginBottom: spacing.md,
  } as ViewStyle,

  topRow: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
    marginBottom:   spacing.xs,
  } as ViewStyle,

  dateBlock: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           6,
    flex:          1,
    marginRight:   spacing.sm,
  } as ViewStyle,

  dateText: {
    fontSize:   13,
    fontWeight: '500',
    color:      tokens.textPrimary,
    flexShrink: 1,
  } as TextStyle,

  chwName: {
    fontSize:     12,
    color:        tokens.textSecondary,
    marginBottom: spacing.xs,
  } as TextStyle,

  metaRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           5,
    flexWrap:      'wrap' as const,
    marginBottom:  spacing.md,
  } as ViewStyle,

  verticalDot: {
    width:        7,
    height:       7,
    borderRadius: 999,
  } as ViewStyle,

  metaText: {
    fontSize: 12,
    color:    tokens.textSecondary,
  } as TextStyle,

  metaSep: {
    fontSize: 12,
    color:    tokens.textMuted,
  } as TextStyle,

  actionRow: {
    flexDirection: 'row',
    gap:           spacing.sm,
  } as ViewStyle,

  primaryBtn: {
    flexDirection:   'row',
    alignItems:      'center',
    gap:             5,
    flex:            1,
    backgroundColor: tokens.primary,
    borderRadius:    radius.lg,
    paddingVertical: 11,
    justifyContent:  'center',
  } as ViewStyle,

  primaryBtnText: {
    fontSize:   14,
    fontWeight: '600',
    color:      tokens.cardBg,
  } as TextStyle,

  rateBtn: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               5,
    backgroundColor:   '#FEF3C7',
    borderRadius:      radius.lg,
    paddingVertical:   11,
    paddingHorizontal: 16,
    justifyContent:    'center',
  } as ViewStyle,

  rateBtnText: {
    fontSize:   14,
    fontWeight: '600',
    color:      '#B45309',
  } as TextStyle,

  cancelBtn: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               5,
    borderWidth:       1,
    borderColor:       tokens.cardBorder,
    borderRadius:      radius.lg,
    paddingVertical:   11,
    paddingHorizontal: 16,
    backgroundColor:   tokens.cardBg,
    justifyContent:    'center',
  } as ViewStyle,

  cancelBtnText: {
    fontSize:   14,
    fontWeight: '600',
    color:      tokens.textSecondary,
  } as TextStyle,

  notesContainer: {
    marginTop: spacing.md,
  } as ViewStyle,

  notesDivider: {
    height:          1,
    backgroundColor: tokens.cardBorder,
    marginBottom:    spacing.md,
    marginHorizontal: -spacing.lg,
  } as ViewStyle,
});

// ─── Pagination footer ────────────────────────────────────────────────────────

interface PaginationFooterProps {
  currentPage:  number;
  totalPages:   number;
  totalRows:    number;
  pageSize:     number;
  onPrevPage:   () => void;
  onNextPage:   () => void;
  onGoToPage:   (page: number) => void;
}

function PaginationFooter({
  currentPage,
  totalPages,
  totalRows,
  pageSize,
  onPrevPage,
  onNextPage,
  onGoToPage,
}: PaginationFooterProps): React.JSX.Element {
  const firstRow = (currentPage - 1) * pageSize + 1;
  const lastRow  = Math.min(currentPage * pageSize, totalRows);

  /**
   * Build a compact page number sequence. Shows at most 5 page buttons,
   * always including first, last, current, and neighbours of current.
   * Gaps are represented with the string '…'.
   */
  const pageNumbers = useMemo((): Array<number | '…'> => {
    if (totalPages <= 5) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    const pages: Array<number | '…'> = [1];
    if (currentPage > 3) pages.push('…');
    for (
      let p = Math.max(2, currentPage - 1);
      p <= Math.min(totalPages - 1, currentPage + 1);
      p++
    ) {
      pages.push(p);
    }
    if (currentPage < totalPages - 2) pages.push('…');
    pages.push(totalPages);
    return pages;
  }, [currentPage, totalPages]);

  return (
    <View style={pagFooterStyles.container}>
      <Text style={[pagFooterStyles.info, numerals.tabular]}>
        Showing {firstRow}–{lastRow} of {totalRows} session{totalRows !== 1 ? 's' : ''}
      </Text>

      <View style={pagFooterStyles.buttons} accessibilityRole="none">
        {/* Previous */}
        <TouchableOpacity
          style={[pagFooterStyles.pageBtn, currentPage === 1 && pagFooterStyles.pageBtnDisabled]}
          onPress={onPrevPage}
          disabled={currentPage === 1}
          accessibilityRole="button"
          accessibilityLabel="Previous page"
          accessibilityState={{ disabled: currentPage === 1 }}
        >
          <ChevronLeft size={14} color={currentPage === 1 ? tokens.textMuted : tokens.textPrimary} />
        </TouchableOpacity>

        {/* Page numbers */}
        {pageNumbers.map((p, idx) =>
          p === '…' ? (
            <View key={`ellipsis-${idx}`} style={pagFooterStyles.ellipsis}>
              <Text style={pagFooterStyles.ellipsisText}>…</Text>
            </View>
          ) : (
            <TouchableOpacity
              key={p}
              style={[
                pagFooterStyles.pageBtn,
                currentPage === p && pagFooterStyles.pageBtnActive,
              ]}
              onPress={() => onGoToPage(p)}
              accessibilityRole="button"
              accessibilityLabel={`Page ${p}`}
              accessibilityState={{ selected: currentPage === p }}
            >
              <Text
                style={[
                  pagFooterStyles.pageBtnLabel,
                  currentPage === p && pagFooterStyles.pageBtnLabelActive,
                ]}
              >
                {p}
              </Text>
            </TouchableOpacity>
          ),
        )}

        {/* Next */}
        <TouchableOpacity
          style={[pagFooterStyles.pageBtn, currentPage === totalPages && pagFooterStyles.pageBtnDisabled]}
          onPress={onNextPage}
          disabled={currentPage === totalPages}
          accessibilityRole="button"
          accessibilityLabel="Next page"
          accessibilityState={{ disabled: currentPage === totalPages }}
        >
          <ChevronRight
            size={14}
            color={currentPage === totalPages ? tokens.textMuted : tokens.textPrimary}
          />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const pagFooterStyles = StyleSheet.create({
  container: {
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth:  1,
    borderTopColor:  tokens.cardBorder,
    flexWrap:        'wrap' as const,
    gap:             spacing.sm,
  } as ViewStyle,

  info: {
    fontSize: 13,
    color:    tokens.textSecondary,
  } as TextStyle,

  buttons: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           4,
  } as ViewStyle,

  pageBtn: {
    minWidth:        32,
    height:          32,
    borderRadius:    radius.sm,
    borderWidth:     1,
    borderColor:     tokens.cardBorder,
    backgroundColor: tokens.cardBg,
    alignItems:      'center',
    justifyContent:  'center',
    paddingHorizontal: 6,
  } as ViewStyle,

  pageBtnActive: {
    backgroundColor: tokens.primary,
    borderColor:     tokens.primary,
  } as ViewStyle,

  pageBtnDisabled: {
    opacity: 0.4,
  } as ViewStyle,

  pageBtnLabel: {
    fontSize:   13,
    fontWeight: '500',
    color:      tokens.textPrimary,
  } as TextStyle,

  pageBtnLabelActive: {
    color: '#FFFFFF',
  } as TextStyle,

  ellipsis: {
    minWidth:   24,
    alignItems: 'center',
  } as ViewStyle,

  ellipsisText: {
    fontSize: 13,
    color:    tokens.textMuted,
  } as TextStyle,
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export function MemberSessionsScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const memberInitials = (userName ?? 'M')
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  // ── Data ────────────────────────────────────────────────────────────────────
  const sessionsQuery   = useSessions();
  const myRequestsQuery = useMyRequests();
  const cancelRequest   = useCancelRequest();
  const refresh         = useRefreshControl([sessionsQuery.refetch, myRequestsQuery.refetch]);

  const allSessions   = sessionsQuery.data ?? [];
  const allMyRequests = myRequestsQuery.data ?? [];

  // ── UI state ────────────────────────────────────────────────────────────────
  /** IDs of sessions optimistically removed from the active list after cancel. */
  const [cancelledSessionIds, setCancelledSessionIds] = useState<Set<string>>(new Set());
  /** The session currently awaiting cancel confirmation in the modal. */
  const [pendingCancelSession, setPendingCancelSession] = useState<SessionData | null>(null);
  /** IDs of open service requests being cancelled (optimistic). */
  const [cancellingRequestIds, setCancellingRequestIds] = useState<Set<string>>(new Set());

  /** Session IDs with expanded notes panel. */
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(new Set());
  /** Session IDs for which the member submitted a testimonial this session. */
  const [submittedTestimonialIds, setSubmittedTestimonialIds] = useState<Set<string>>(new Set());
  /** The session currently open in RateChwModal. */
  const [rateModalSession, setRateModalSession] = useState<SessionData | null>(null);

  const [toastMessage, setToastMessage] = useState<string | null>(null);

  /** Sorting: date column only. Default newest first. */
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  /** Current page number (1-indexed). Resets when sort changes. */
  const [currentPage, setCurrentPage] = useState<number>(1);

  // ── Derived lists ────────────────────────────────────────────────────────────

  /**
   * All sessions sorted by scheduledAt then sliced to the current page.
   * The BE endpoint returns all sessions for the authenticated member — no
   * server-side pagination cursor exists, so we slice client-side.
   */
  const sortedSessions = useMemo((): SessionData[] => {
    return [...allSessions].sort((a, b) => {
      const aTime = new Date(a.scheduledAt).getTime();
      const bTime = new Date(b.scheduledAt).getTime();
      return sortDirection === 'asc' ? aTime - bTime : bTime - aTime;
    });
  }, [allSessions, sortDirection]);

  const totalRows    = sortedSessions.length;
  const totalPages   = Math.max(1, Math.ceil(totalRows / SESSIONS_PAGE_SIZE));
  const pagedSessions = useMemo((): SessionData[] => {
    const start = (currentPage - 1) * SESSIONS_PAGE_SIZE;
    return sortedSessions.slice(start, start + SESSIONS_PAGE_SIZE);
  }, [sortedSessions, currentPage]);

  // ── Handlers ─────────────────────────────────────────────────────────────────

  const showToast = useCallback((message: string): void => {
    setToastMessage(message);
    const timer = setTimeout(() => setToastMessage(null), 3500);
    // Effect cleanup: not possible with useCallback returning void, but
    // the 3.5 s window is short enough that leaking the timer on unmount
    // is not a practical concern for this screen.
    void timer;
  }, []);

  const handleToggleSort = useCallback((): void => {
    setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    setCurrentPage(1);
  }, []);

  const handlePrevPage = useCallback((): void => {
    setCurrentPage((prev) => Math.max(1, prev - 1));
  }, []);

  const handleNextPage = useCallback((): void => {
    setCurrentPage((prev) => Math.min(totalPages, prev + 1));
  }, [totalPages]);

  const handleGoToPage = useCallback((page: number): void => {
    setCurrentPage(page);
  }, []);

  const handleToggleExpand = useCallback((sessionId: string): void => {
    setExpandedSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const handleRequestCancel = useCallback((session: SessionData): void => {
    setPendingCancelSession(session);
  }, []);

  const handleConfirmCancel = useCallback(
    (sessionId: string): void => {
      setCancelledSessionIds((prev) => new Set(prev).add(sessionId));
      setPendingCancelSession(null);
      showToast('Session cancelled successfully.');
    },
    [showToast],
  );

  const handleDismissCancel = useCallback((): void => {
    setPendingCancelSession(null);
  }, []);

  const handleViewNotes = useCallback((session: SessionData): void => {
    handleToggleExpand(session.id);
  }, [handleToggleExpand]);

  const handleOpenRateModal = useCallback((session: SessionData): void => {
    setRateModalSession(session);
  }, []);

  const handleCloseRateModal = useCallback((): void => {
    setRateModalSession(null);
  }, []);

  const handleTestimonialSubmitted = useCallback((): void => {
    if (rateModalSession) {
      setSubmittedTestimonialIds((prev) => new Set(prev).add(rateModalSession.id));
    }
    setRateModalSession(null);
    showToast('Thank you for your rating!');
  }, [rateModalSession, showToast]);

  // ── Shell user block ─────────────────────────────────────────────────────────

  const shellUserBlock = {
    initials: memberInitials,
    name:     userName ?? 'Member',
    role:     'Member' as const,
  };

  const isLoading = sessionsQuery.isLoading || myRequestsQuery.isLoading;
  const hasError  = sessionsQuery.error != null && myRequestsQuery.error != null;

  // ── Loading state ────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <AppShell role="member" activeKey="messages" userBlock={shellUserBlock}>
        <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
        <PageWrap style={{ padding: spacing.lg }}>
          <LoadingSkeleton variant="rows" rows={4} />
        </PageWrap>
      </AppShell>
    );
  }

  // ── Error state ──────────────────────────────────────────────────────────────

  if (hasError) {
    return (
      <AppShell role="member" activeKey="messages" userBlock={shellUserBlock}>
        <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
        <ErrorState
          message="Could not load your sessions. Please try again."
          onRetry={() => {
            void sessionsQuery.refetch();
            void myRequestsQuery.refetch();
          }}
        />
      </AppShell>
    );
  }

  // ── Table content ────────────────────────────────────────────────────────────

  const tableContent = (
    <ScrollView
      style={screenStyles.scroll}
      contentContainerStyle={screenStyles.scrollContent}
      showsVerticalScrollIndicator={false}
      refreshControl={refresh.control}
    >
      <PageWrap>
        <View style={screenStyles.headerArea}>
          <PageHeader
            title="My Sessions"
            subtitle={`${totalRows} session${totalRows !== 1 ? 's' : ''} on record`}
          />
        </View>

        {/* Sessions table card */}
        <Card style={screenStyles.tableCard}>
          <SectionHeader
            title="All Sessions"
            subtitle="Tap any row for notes and actions"
            style={screenStyles.sectionHeader}
            marginBottom={0}
            right={
              totalRows > 0 ? (
                <View style={screenStyles.sortIndicator}>
                  <ArrowUpDown size={13} color={tokens.textSecondary} />
                  <Text style={screenStyles.sortIndicatorText}>
                    {sortDirection === 'desc' ? 'Newest first' : 'Oldest first'}
                  </Text>
                </View>
              ) : undefined
            }
          />

          {totalRows === 0 ? (
            <EmptyState
              icon={CalendarCheck}
              title="No sessions yet"
              body="Your sessions with a CHW will appear here after your first meeting."
            />
          ) : (
            <>
              {/* Web table layout */}
              {Platform.OS === 'web' ? (
                <>
                  <TableHeader
                    sortDirection={sortDirection}
                    onToggleSort={handleToggleSort}
                  />
                  {pagedSessions.map((session) => (
                    <SessionTableRow
                      key={session.id}
                      session={session}
                      isExpanded={expandedSessionIds.has(session.id)}
                      isCancelled={cancelledSessionIds.has(session.id)}
                      hasTestimonial={submittedTestimonialIds.has(session.id)}
                      onViewNotes={handleViewNotes}
                      onRequestCancel={handleRequestCancel}
                      onOpenRateModal={handleOpenRateModal}
                      onToggleExpand={handleToggleExpand}
                    />
                  ))}
                  {totalPages > 1 && (
                    <PaginationFooter
                      currentPage={currentPage}
                      totalPages={totalPages}
                      totalRows={totalRows}
                      pageSize={SESSIONS_PAGE_SIZE}
                      onPrevPage={handlePrevPage}
                      onNextPage={handleNextPage}
                      onGoToPage={handleGoToPage}
                    />
                  )}
                </>
              ) : (
                /* Native card list */
                <View style={screenStyles.nativeList}>
                  {pagedSessions.map((session) => (
                    <SessionNativeCard
                      key={session.id}
                      session={session}
                      isExpanded={expandedSessionIds.has(session.id)}
                      hasTestimonial={submittedTestimonialIds.has(session.id)}
                      onViewNotes={handleViewNotes}
                      onRequestCancel={handleRequestCancel}
                      onOpenRateModal={handleOpenRateModal}
                      onToggleExpand={handleToggleExpand}
                    />
                  ))}
                  {/* Native pagination footer — always visible when multipage */}
                  {totalPages > 1 && (
                    <PaginationFooter
                      currentPage={currentPage}
                      totalPages={totalPages}
                      totalRows={totalRows}
                      pageSize={SESSIONS_PAGE_SIZE}
                      onPrevPage={handlePrevPage}
                      onNextPage={handleNextPage}
                      onGoToPage={handleGoToPage}
                    />
                  )}
                </View>
              )}
            </>
          )}
        </Card>

        <View style={screenStyles.bottomSpacer} />
      </PageWrap>
    </ScrollView>
  );

  // ── Overlays ─────────────────────────────────────────────────────────────────

  const overlays = (
    <>
      {toastMessage != null && <ToastBanner message={toastMessage} />}

      {pendingCancelSession != null && (
        <ConfirmCancelModal
          session={pendingCancelSession}
          visible
          onConfirm={handleConfirmCancel}
          onDismiss={handleDismissCancel}
        />
      )}

      {rateModalSession != null && (
        <RateChwModal
          visible
          sessionId={rateModalSession.id}
          chwName={rateModalSession.chwName ?? 'your CHW'}
          onClose={handleCloseRateModal}
          onSubmitted={handleTestimonialSubmitted}
        />
      )}
    </>
  );

  // ── Shell ─────────────────────────────────────────────────────────────────────

  if (Platform.OS !== 'web') {
    return (
      <SafeAreaView style={screenStyles.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
        {overlays}
        {tableContent}
      </SafeAreaView>
    );
  }

  return (
    <AppShell role="member" activeKey="messages" userBlock={shellUserBlock}>
      <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
      {overlays}
      {tableContent}
    </AppShell>
  );
}

// ─── Screen-level styles ──────────────────────────────────────────────────────

const screenStyles = StyleSheet.create({
  safeArea: {
    flex:            1,
    backgroundColor: tokens.pageBg,
  } as ViewStyle,

  scroll: {
    flex: 1,
  } as ViewStyle,

  scrollContent: {
    flexGrow:        1,
    backgroundColor: tokens.pageBg,
  } as ViewStyle,

  headerArea: {
    paddingHorizontal: spacing.lg,
    paddingTop:        spacing.xl,
  } as ViewStyle,

  tableCard: {
    marginHorizontal: spacing.lg,
    overflow:         'hidden' as const,
  } as ViewStyle,

  sectionHeader: {
    paddingHorizontal: spacing.lg,
    paddingTop:        spacing.lg,
    paddingBottom:     spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
  } as ViewStyle,

  sortIndicator: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           4,
  } as ViewStyle,

  sortIndicatorText: {
    fontSize:   12,
    color:      tokens.textSecondary,
    fontWeight: '500',
  } as TextStyle,

  nativeList: {
    padding: spacing.lg,
    gap:     spacing.md,
  } as ViewStyle,

  bottomSpacer: {
    height: spacing.xxxl,
  } as ViewStyle,
});
