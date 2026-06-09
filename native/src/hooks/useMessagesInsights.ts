/**
 * useMessagesInsights — client-side derived analytics for the CHWMessagesScreen right rail.
 *
 * All logic is pure computation over the messages list already fetched by
 * useSessionMessages — no additional backend calls are required.
 *
 * Exports:
 *   useEngagementStatus  — derives "Highly Engaged" / "Engaged" / "Quiet" from
 *                          the member's recent reply timeline.
 *   useCompassInsight    — returns a single-sentence contextual insight string
 *                          based on reply patterns, best-response window, and
 *                          unanswered message staleness.
 */

import { useMemo } from 'react';
import type { SessionMessageLocal } from './useApiQueries';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Visual engagement tier for the header pill. */
export type EngagementStatus = 'highly_engaged' | 'engaged' | 'quiet';

/**
 * Pill variant mapping for each engagement tier.
 * Callers pass this directly to <Pill variant={...} />.
 */
export type EngagementPillVariant = 'emerald' | 'gray' | 'amber';

export interface EngagementResult {
  status: EngagementStatus;
  label: string;
  pillVariant: EngagementPillVariant;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** 24 hours in milliseconds — threshold for "responded recently". */
const MS_24H = 24 * 60 * 60 * 1_000;

/** 7 days in milliseconds — threshold for "no recent member reply". */
const MS_7D = 7 * 24 * 60 * 60 * 1_000;

// ─── Engagement status ────────────────────────────────────────────────────────

/**
 * Derives an engagement tier from the message history between CHW and member.
 *
 * Rules (in precedence order):
 *   1. "Highly Engaged" — member replied to the last 3 CHW messages within 24 h each.
 *   2. "Quiet"          — no member reply in the last 7 days.
 *   3. "Engaged"        — everything else.
 *
 * Returns "Engaged" (neutral) when the message list is empty or has fewer than 3
 * CHW-initiated messages.
 *
 * @param messages - Full merged messages list (server + optimistic) sorted ascending.
 * @param chwUserId - The CHW's user ID string to identify CHW-authored messages.
 */
export function deriveEngagementStatus(
  messages: SessionMessageLocal[],
  chwUserId: string,
): EngagementResult {
  if (messages.length === 0) {
    return { status: 'engaged', label: 'Engaged', pillVariant: 'gray' };
  }

  const now = Date.now();

  // Check "Quiet" — no member reply in last 7 days
  const lastMemberMsg = [...messages]
    .reverse()
    .find((m) => m.senderRole === 'member');

  if (!lastMemberMsg) {
    // Member has never replied
    return { status: 'quiet', label: 'Quiet', pillVariant: 'amber' };
  }

  const lastMemberReplyAge = now - Date.parse(lastMemberMsg.createdAt);
  if (lastMemberReplyAge > MS_7D) {
    return { status: 'quiet', label: 'Quiet', pillVariant: 'amber' };
  }

  // Check "Highly Engaged" — member replied to last 3 CHW messages within 24h each
  // Find the last 3 CHW messages and check if there is a member reply within 24h after each.
  const chwMessages = messages.filter(
    (m) => m.senderRole === 'chw' && m.status !== 'sending' && m.status !== 'failed',
  );

  if (chwMessages.length >= 3) {
    const lastThreeChwMsgs = chwMessages.slice(-3);
    const allRepliedQuickly = lastThreeChwMsgs.every((chwMsg) => {
      const chwSentAt = Date.parse(chwMsg.createdAt);
      // Find the next member reply after this CHW message
      const nextMemberReply = messages.find(
        (m) =>
          m.senderRole === 'member' &&
          Date.parse(m.createdAt) > chwSentAt,
      );
      if (!nextMemberReply) return false;
      const replyDelay = Date.parse(nextMemberReply.createdAt) - chwSentAt;
      return replyDelay <= MS_24H;
    });

    if (allRepliedQuickly) {
      return { status: 'highly_engaged', label: 'Highly Engaged', pillVariant: 'emerald' };
    }
  }

  return { status: 'engaged', label: 'Engaged', pillVariant: 'gray' };
}

/**
 * Hook wrapper around deriveEngagementStatus.
 * Memoizes on messages array reference and chwUserId.
 */
export function useEngagementStatus(
  messages: SessionMessageLocal[],
  chwUserId: string,
): EngagementResult {
  return useMemo(
    () => deriveEngagementStatus(messages, chwUserId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, chwUserId],
  );
}

// ─── Compass insight ──────────────────────────────────────────────────────────

/**
 * Derives a single contextual insight sentence from the message history.
 *
 * Priority order:
 *   1. Member has CHW messages left unread > 6 h → follow-up by phone suggestion.
 *   2. Member has enough history to derive a best-response hour window → send-timing tip.
 *   3. No messages yet / intro state → rapport-building tip.
 *   4. Default fallback (general engagement tip).
 *
 * @param messages - Full merged message list sorted ascending.
 * @param memberFirstName - First name for personalised copy.
 */
export function deriveCompassInsight(
  messages: SessionMessageLocal[],
  memberFirstName: string,
): string {
  const now = Date.now();

  // Rule 1: member has not responded to last CHW message and it's been > 6h
  const confirmedMessages = messages.filter(
    (m) => m.status !== 'sending' && m.status !== 'failed',
  );
  const lastMsg = confirmedMessages[confirmedMessages.length - 1];
  const hasAnyMemberMsg = confirmedMessages.some((m) => m.senderRole === 'member');

  if (confirmedMessages.length === 0) {
    return 'Send a brief intro to build rapport — short SMS messages outperform long ones for new members.';
  }

  if (lastMsg && lastMsg.senderRole === 'chw') {
    const staleness = now - Date.parse(lastMsg.createdAt);
    const stalenessHours = Math.round(staleness / (60 * 60 * 1_000));
    if (staleness > 6 * 60 * 60 * 1_000) {
      return `${memberFirstName} hasn't responded to your last message (${stalenessHours}h ago). Consider following up by phone.`;
    }
  }

  // Rule 2: derive best-response hour window from member replies
  const memberReplies = confirmedMessages.filter((m) => m.senderRole === 'member');
  if (memberReplies.length >= 3) {
    const replyHours = memberReplies.map((m) => new Date(m.createdAt).getHours());
    const avgHour = Math.round(replyHours.reduce((a, b) => a + b, 0) / replyHours.length);
    const windowEnd = (avgHour + 2) % 24;

    const formatHour = (h: number): string => {
      const period = h >= 12 ? 'PM' : 'AM';
      const display = h === 0 ? 12 : h > 12 ? h - 12 : h;
      return `${display} ${period}`;
    };

    // Estimate average response time in minutes
    const responseTimes: number[] = [];
    for (const memberMsg of memberReplies) {
      const memberMsgAt = Date.parse(memberMsg.createdAt);
      // Find the last CHW message before this member reply
      const prevChwMsg = [...confirmedMessages]
        .reverse()
        .find((m) => m.senderRole === 'chw' && Date.parse(m.createdAt) < memberMsgAt);
      if (prevChwMsg) {
        const delta = (memberMsgAt - Date.parse(prevChwMsg.createdAt)) / (60 * 1_000);
        if (delta > 0 && delta < 24 * 60) {
          responseTimes.push(delta);
        }
      }
    }

    if (responseTimes.length > 0) {
      const avgMinutes = Math.round(
        responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length,
      );
      const timeLabel = avgMinutes < 60 ? `${avgMinutes} min` : `${Math.round(avgMinutes / 60)}h`;
      return `${memberFirstName} typically responds within ${timeLabel} between ${formatHour(avgHour)}–${formatHour(windowEnd)}. Consider sending the resource link this evening.`;
    }
  }

  if (!hasAnyMemberMsg) {
    return 'Send a brief intro to build rapport — short SMS messages outperform long ones for new members.';
  }

  return `Keep the momentum going — ${memberFirstName} is an active responder. Short, clear messages work best.`;
}

/**
 * Hook wrapper around deriveCompassInsight.
 * Memoizes on messages array reference.
 */
export function useCompassInsight(
  messages: SessionMessageLocal[],
  memberFirstName: string,
): string {
  return useMemo(
    () => deriveCompassInsight(messages, memberFirstName),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, memberFirstName],
  );
}
