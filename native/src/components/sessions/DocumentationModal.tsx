/**
 * DocumentationModal — documents a completed session. Renders as either a
 * full-screen takeover (`presentation="fullscreen"`, the default) or an
 * on-brand overlay panel anchored over the caller's content
 * (`presentation="overlay"`) — see the Q4 note below.
 *
 * Visual language: shared design-system tokens (theme/tokens) + ui/ primitives
 * (Card, SectionHeader). Legacy beige/cream theme/colors palette removed.
 *
 * Sections (in render order):
 *  - Diagnosis Codes (Z-Codes): grouped by resource-need vertical (Housing,
 *    Utilities, Food Security, Transportation, Mental Health, Healthcare,
 *    Employment, Others) — tap-to-select codes, same chip-group visual
 *    language as the Resource Needs picker elsewhere in the app.
 *  - Procedure Code: picker from procedureCodes mock data
 *  - Session Notes: multiline TextInput (2000 char limit with counter)
 *  - Session Time: CHW-editable Session Start / Session End
 *    (MM/DD/YYYY hh:MM AM/PM, 12hr — matches the billing CSV export format
 *    exactly, see #21 in sessionDocumentation.ts) — pre-filled from
 *    sessionStartedAt/sessionEndedAt when known — plus a simple inline
 *    computed-units line ("Units: N") and a "Potential Earnings: $N" line
 *    (#22, flat $14/unit display estimate), or a not-billable notice when
 *    the session is under the 16-minute floor. Bottom of the form,
 *    immediately above Submit. NO platform-fee/net-payout breakdown is shown
 *    here (the old Gross/Net/Rate UnitsSummary card is gone — see Q1,
 *    2026-07-13).
 *  - Submit Documentation button
 *
 *  Draft persistence (#23): all of the above form state (notes, diagnosis
 *  codes, procedure code, session start/end) is persisted per-sessionId to
 *  AsyncStorage on change (debounced) and restored when the modal reopens
 *  for the same session — see the "Draft persistence" section below. Cleared
 *  on successful submit.
 *
 * 2026-07-12 redesign: Members Served, Member Goals Discussed, Resources
 * Referred, Follow-Up Needed, and AI Summary were removed (backend schema
 * defaults them); Session Start/End replace session duration as the
 * units-to-bill driver.
 *
 * 2026-07-13 "modal v2" redesign (Epics Q1-Q3):
 *  - Q1: Session Time moved to the bottom of the form (was at the top); the
 *    Gross/Net/Rate UnitsSummary card is deleted in favor of a plain inline
 *    "Units: N" line.
 *  - Q2: 16-minute billable floor — a session under 16 minutes computes to
 *    0 units and is NOT billable. Submission is BLOCKED for billing in that
 *    case (see `isBelowBillableFloor` gating in `isValid` below) — matches
 *    the backend's `validate_claim` rejecting a computed 0-unit claim, so
 *    the CHW can never file a <16-minute claim from either side.
 *  - Q3: Diagnosis Codes re-grouped from ICD-10 taxonomy categories
 *    (counseling/housing_economic/health_access/behavioral/legal) to the
 *    resource-need verticals used elsewhere in the app, via
 *    `data/diagnosisVerticalMap.ts`.
 *
 * 2026-07-13 "on-brand Messages overlay" (Epic Q4): presentation is now a
 * prop, `presentation?: 'fullscreen' | 'overlay'` (default `'fullscreen'` —
 * the pre-existing RN `Modal`/`pageSheet` takeover, unchanged for every
 * caller that doesn't pass the prop). `'overlay'` is opt-in, used only by
 * CHWMessagesScreen's live "Complete Session" flow: instead of an RN `Modal`
 * (which portals to a fresh document root on web), it renders as a plain
 * absolutely-positioned in-app panel — scrim + centered card, matching
 * AppDialogProvider / DocumentationModal's own in-app confirm/success panels
 * (`rgba(15, 23, 42, 0.45)` scrim, `tokens.cardBg` card, `radius.lg`) — so it
 * reads as part of the Messages page rather than a screen takeover. ALL form
 * internals (validation, 16-minute billable-floor gating, submit wiring) are
 * identical between the two presentations; only the outer chrome differs —
 * see `DocumentationModalShell` below.
 *
 * See src/utils/sessionDocumentation.ts for the pure parsing/bracket math.
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  X,
  ChevronDown,
  ChevronRight,
  Check,
  FileText,
  AlertTriangle,
} from 'lucide-react-native';
import { ResourceMentionInput } from '../resources/ResourceMentionInput';

import { colors as tokens, spacing, radius, shadows } from '../../theme/tokens';
import { typography } from '../../theme/typography';
import { Card, SectionHeader } from '../ui';
import { useCaseNotes } from '../../hooks/useApiQueries';
import {
  diagnosisCodes,
  procedureCodes,
  type SessionDocumentation,
} from '../../data/mock';
import {
  DIAGNOSIS_VERTICAL_GROUPS,
  diagnosisCodeGroup,
  diagnosisGroupColor,
  diagnosisGroupEmoji,
  diagnosisGroupLabel,
  type DiagnosisVerticalGroup,
} from '../../data/diagnosisVerticalMap';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  computePotentialEarnings,
  computeUnitsFromDuration,
  computeUnitsFromTimes,
  formatIsoForSessionDateTimeInput,
  formatSessionDateTimeInput,
  isBelowBillableFloor,
  MIN_BILLABLE_DURATION_MINUTES,
  parseSessionDateTimeInputToIso,
} from '../../utils/sessionDocumentation';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DocumentationModalProps {
  /** Controls modal visibility */
  visible: boolean;
  /** Called when the user dismisses without submitting */
  onClose: () => void;
  /** Session ID being documented */
  sessionId: string;
  /**
   * Member the session is with. Used to fetch the case notes the CHW wrote
   * during this session so the Session Notes field can be pre-filled with them
   * for review/editing. Optional so existing callers keep compiling.
   */
  memberId?: string;
  /**
   * Total session duration in minutes. Legacy fallback only: used to seed
   * the units-to-bill display when the Session Start/End fields are empty or
   * invalid (e.g. a caller that hasn't been wired to sessionStartedAt /
   * sessionEndedAt yet). Once both time fields are valid, the CHW-edited
   * times are authoritative — see ``computeUnitsFromTimes``. The backend
   * ignores any client-supplied units and recomputes from the same formula
   * regardless, so this prop only affects what the CHW sees before they've
   * filled in the times. ``null`` / undefined defaults to 1 unit.
   */
  durationMinutes?: number | null;
  /**
   * Session start time (ISO 8601), used to pre-fill the editable "Session
   * Start" field. ``null`` / undefined leaves the field blank for manual entry.
   */
  sessionStartedAt?: string | null;
  /**
   * Session end time (ISO 8601), used to pre-fill the editable "Session End"
   * field. ``null`` / undefined leaves the field blank for manual entry.
   */
  sessionEndedAt?: string | null;
  /** Called with the completed documentation data on submit */
  onSubmit: (data: SessionDocumentation) => void;
  /**
   * Visual presentation of the form shell.
   *  - `'fullscreen'` (default): the pre-existing RN `Modal` /
   *    `presentationStyle="pageSheet"` screen takeover. Every existing
   *    caller that doesn't pass this prop keeps this exact behavior.
   *  - `'overlay'`: an on-brand in-app overlay panel anchored over the
   *    caller's own content (scrim + centered card, no navigation-level
   *    modal) — opt-in, used by CHWMessagesScreen so documentation reads as
   *    part of the Messages page. Form internals, validation, and submit
   *    wiring are identical to `'fullscreen'`; only the outer chrome differs.
   */
  presentation?: 'fullscreen' | 'overlay';
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Session Notes cap. Roomy enough to hold this session's case notes (pre-filled
// for review/editing) plus the CHW's edits; the backend `summary` column is
// unbounded Text, so this is a UI guardrail only.
const NOTES_MAX = 2000;

// ─── Draft persistence (#23) ────────────────────────────────────────────────
//
// Persists the in-progress documentation form (notes, diagnosis codes,
// procedure code, session start/end times) to AsyncStorage keyed by
// sessionId, so navigating away from Messages (or anywhere else this modal
// is mounted) and back restores exactly what the CHW had typed rather than
// losing it. AsyncStorage (not localStorage directly) is used because it's
// the cross-platform (web + native) storage primitive already used
// elsewhere in this codebase (see AuthContext.tsx, CHWDashboardScreen.tsx) —
// on web it's backed by localStorage under the hood, on native by its own
// native persistence layer.
//
// Draft shape intentionally mirrors the CHW-editable form fields only (not
// derived values like unitsToBill, which are recomputed live from the times
// on restore) so there's a single source of truth for what "restoring a
// draft" means.

interface DocumentationDraft {
  chwNotes: string;
  selectedDiagnosisCodes: string[];
  selectedProcedureCode: string;
  sessionStartInput: string;
  sessionEndInput: string;
}

/** Debounce window (ms) between the CHW's last keystroke/selection and the
 *  draft actually being written to AsyncStorage — avoids a write on every
 *  single keystroke while notes are being typed. */
const DRAFT_SAVE_DEBOUNCE_MS = 500;

function draftStorageKey(sessionId: string): string {
  return `compass:documentationDraft:${sessionId}`;
}

/** True when a draft has no CHW-entered content worth persisting/restoring —
 *  guards against writing (and later "restoring") an all-empty draft that
 *  would just match the form's own fresh-mount defaults anyway. */
function isEmptyDraft(draft: DocumentationDraft): boolean {
  return (
    draft.chwNotes.trim().length === 0 &&
    draft.selectedDiagnosisCodes.length === 0 &&
    draft.sessionStartInput.length === 0 &&
    draft.sessionEndInput.length === 0
  );
}

/** Runtime shape guard for a value read back out of AsyncStorage — a stored
 *  draft is untrusted input (could be stale/corrupt from a previous app
 *  version), so this is validated field-by-field rather than trusted via a
 *  blind `as DocumentationDraft` cast. */
function isValidDraftShape(value: unknown): value is DocumentationDraft {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.chwNotes === 'string' &&
    Array.isArray(v.selectedDiagnosisCodes) &&
    v.selectedDiagnosisCodes.every((c) => typeof c === 'string') &&
    typeof v.selectedProcedureCode === 'string' &&
    typeof v.sessionStartInput === 'string' &&
    typeof v.sessionEndInput === 'string'
  );
}

/**
 * Reads and validates a persisted draft for `sessionId`. Returns `null` when
 * no draft exists, storage is unavailable, or the stored value is malformed
 * — every failure mode degrades to "no draft" rather than throwing, since a
 * draft is a nice-to-have convenience, never a hard requirement to open the
 * modal.
 */
async function readDraft(sessionId: string): Promise<DocumentationDraft | null> {
  try {
    const raw = await AsyncStorage.getItem(draftStorageKey(sessionId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isValidDraftShape(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persists a draft for `sessionId`. Silently swallows storage errors (e.g.
 *  private-browsing quota exceptions) — a failed draft save must never
 *  interrupt the CHW's documentation flow. */
async function writeDraft(sessionId: string, draft: DocumentationDraft): Promise<void> {
  try {
    await AsyncStorage.setItem(draftStorageKey(sessionId), JSON.stringify(draft));
  } catch {
    // Storage unavailable — ignore; the CHW's in-memory form state is
    // unaffected, only cross-navigation persistence is lost.
  }
}

/** Clears the persisted draft for `sessionId` — called on successful submit
 *  (the documentation is filed; there's nothing left to restore) and when a
 *  debounced save would otherwise persist an all-empty draft. */
async function clearDraft(sessionId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(draftStorageKey(sessionId));
  } catch {
    // Storage unavailable — ignore.
  }
}

// ─── DiagnosisCodeSection ─────────────────────────────────────────────────────
//
// Q3 (2026-07-13): grouped by resource-need vertical (data/diagnosisVerticalMap.ts)
// rather than the old ICD-10 taxonomy categories (counseling/housing_economic/
// health_access/behavioral/legal). Same expand/collapse-per-group interaction
// as before; only the grouping key, labels, and accent color changed — the
// chip-group visual language (colored accent, emoji, checkmark) matches the
// Resource Needs picker elsewhere in the app (see CHWCalendarScreen.tsx).

interface DiagnosisCodeSectionProps {
  selectedCodes: string[];
  onToggle: (code: string) => void;
}

function DiagnosisCodeSection({
  selectedCodes,
  onToggle,
}: DiagnosisCodeSectionProps): React.JSX.Element {
  const [expandedGroups, setExpandedGroups] = useState<Set<DiagnosisVerticalGroup>>(new Set());

  const codesByGroup = useMemo(() => {
    const map = new Map<DiagnosisVerticalGroup, typeof diagnosisCodes>();
    for (const group of DIAGNOSIS_VERTICAL_GROUPS) {
      map.set(
        group,
        diagnosisCodes.filter((d) => !d.isArchived && diagnosisCodeGroup(d.code) === group),
      );
    }
    return map;
  }, []);

  function toggleGroup(group: DiagnosisVerticalGroup): void {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  }

  return (
    <View style={sh.section}>
      <SectionHeader title="Diagnosis Codes (Z-Codes)" marginBottom={spacing.md} />

      {DIAGNOSIS_VERTICAL_GROUPS.map((group) => {
        const codes = codesByGroup.get(group) ?? [];
        // Groups with zero codes in the current picker catalog (e.g. no
        // active code currently maps to this vertical) are hidden rather
        // than rendered as an empty, always-collapsed card.
        if (codes.length === 0) return null;

        const isExpanded = expandedGroups.has(group);
        const selectedInGroup = codes.filter((c) => selectedCodes.includes(c.code)).length;
        const groupLabel = diagnosisGroupLabel(group);
        const groupColor = diagnosisGroupColor(group);
        const groupEmoji = diagnosisGroupEmoji(group);

        return (
          <Card key={group} style={sh.categoryCard}>
            <TouchableOpacity
              style={sh.categoryHeader}
              onPress={() => toggleGroup(group)}
              accessibilityRole="button"
              accessibilityState={{ expanded: isExpanded }}
              accessibilityLabel={`${groupLabel}${selectedInGroup > 0 ? `, ${selectedInGroup} selected` : ''}`}
              activeOpacity={0.7}
            >
              <View style={sh.categoryLabelRow}>
                <Text style={sh.categoryEmoji}>{groupEmoji}</Text>
                <Text style={sh.categoryLabel}>{groupLabel}</Text>
              </View>
              <View style={sh.categoryRightRow}>
                {selectedInGroup > 0 && (
                  <View style={[sh.categoryBadge, { backgroundColor: groupColor }]}>
                    <Text style={sh.categoryBadgeText}>{selectedInGroup}</Text>
                  </View>
                )}
                {isExpanded ? (
                  <ChevronDown size={16} color={tokens.textMuted} />
                ) : (
                  <ChevronRight size={16} color={tokens.textMuted} />
                )}
              </View>
            </TouchableOpacity>

            {isExpanded && (
              <View style={sh.codeList}>
                {codes.map((code) => {
                  const isSelected = selectedCodes.includes(code.code);
                  return (
                    <TouchableOpacity
                      key={code.code}
                      style={[
                        sh.codeRow,
                        isSelected && { backgroundColor: `${groupColor}1A` },
                      ]}
                      onPress={() => onToggle(code.code)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: isSelected }}
                      accessibilityLabel={`${code.code}: ${code.description}`}
                      activeOpacity={0.7}
                    >
                      <View
                        style={[
                          sh.codeCheckbox,
                          isSelected && { borderColor: groupColor, backgroundColor: groupColor },
                        ]}
                      >
                        {isSelected && <Check size={9} color="#FFFFFF" strokeWidth={3} />}
                      </View>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text
                          style={[
                            sh.codeText,
                            isSelected && { color: groupColor },
                          ]}
                        >
                          {code.code}
                        </Text>
                        <Text style={sh.codeDesc}>{code.description}</Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </Card>
        );
      })}
    </View>
  );
}

const sh = StyleSheet.create({
  section: {
    marginBottom: spacing.xl,
  },
  categoryCard: {
    marginBottom: spacing.xs,
    overflow: 'hidden',
  },
  categoryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: tokens.cardBg,
  },
  categoryLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flex: 1,
  },
  categoryEmoji: {
    fontSize: 14,
  },
  categoryLabel: {
    ...typography.bodySm,
    fontWeight: '600',
    color: tokens.textPrimary,
    flex: 1,
  },
  categoryRightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  categoryBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: tokens.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  codeList: {
    borderTopWidth: 1,
    borderTopColor: tokens.cardBorder,
    backgroundColor: tokens.pageBg,
  },
  codeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md - 2,
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
  },
  // Selected-row/checkbox/text accent colors are the group's vertical color,
  // applied inline (see diagnosisGroupColor()) rather than a single static
  // "selected" style — each vertical group has a different accent.
  codeCheckbox: {
    width: 16,
    height: 16,
    borderRadius: radius.sm - 2,
    borderWidth: 2,
    borderColor: tokens.cardBorder,
    backgroundColor: tokens.cardBg,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
    flexShrink: 0,
  },
  codeText: {
    ...typography.bodySm,
    fontWeight: '700',
    color: tokens.textPrimary,
  },
  codeDesc: {
    ...typography.label,
    letterSpacing: 0,
    color: tokens.textSecondary,
    lineHeight: 16,
  },
});

// ─── ProcedureCodePicker ──────────────────────────────────────────────────────

interface ProcedureCodePickerProps {
  value: string;
  onChange: (code: string) => void;
}

function ProcedureCodePicker({ value, onChange }: ProcedureCodePickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const selected = procedureCodes.find((pc) => pc.code === value);

  return (
    <View style={sh.section}>
      <SectionHeader
        title="Procedure and Modifiers"
        marginBottom={spacing.md}
        right={
          <Text style={pc.requiredStar}>Required</Text>
        }
      />

      <Card>
        <TouchableOpacity
          style={pc.trigger}
          onPress={() => setOpen((prev) => !prev)}
          accessibilityRole="combobox"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={
            selected
              ? `Selected: ${selected.code} ${selected.modifier} — ${selected.description}`
              : 'Select procedure code'
          }
          activeOpacity={0.7}
        >
          <Text style={[pc.triggerText, !selected && pc.triggerPlaceholder]} numberOfLines={1}>
            {selected
              ? `${selected.code} ${selected.modifier} — ${selected.description} (${selected.groupSize})`
              : 'Select procedure code'}
          </Text>
          <ChevronDown size={16} color={tokens.textMuted} />
        </TouchableOpacity>

        {open && (
          <View style={pc.dropdown}>
            {procedureCodes.map((item) => {
              const isSelected = value === item.code;
              return (
                <TouchableOpacity
                  key={item.code}
                  style={[pc.option, isSelected && pc.optionSelected]}
                  onPress={() => {
                    onChange(item.code);
                    setOpen(false);
                  }}
                  accessibilityRole="menuitem"
                  accessibilityState={{ selected: isSelected }}
                  accessibilityLabel={`${item.code} ${item.modifier} — ${item.description}`}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[pc.optionCode, isSelected && pc.optionCodeSelected]}>
                      {item.code} {item.modifier}
                    </Text>
                    <Text style={pc.optionDesc}>
                      {item.description} · {item.groupSize}
                    </Text>
                  </View>
                  {isSelected && <Check size={14} color={tokens.primary} />}
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </Card>

      <Text style={pc.hint}>
        Select service type based on number of people served in this session.
      </Text>
    </View>
  );
}

const pc = StyleSheet.create({
  requiredStar: {
    fontSize: 11,
    fontWeight: '600',
    color: tokens.red700,
    letterSpacing: 0.3,
  },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg - 2,
    backgroundColor: tokens.cardBg,
    borderRadius: radius.xl,
  },
  triggerText: {
    ...typography.bodyMd,
    color: tokens.textPrimary,
    flex: 1,
    marginRight: spacing.sm,
  },
  triggerPlaceholder: {
    color: tokens.textMuted,
  },
  dropdown: {
    borderTopWidth: 1,
    borderTopColor: tokens.cardBorder,
    backgroundColor: tokens.cardBg,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
    overflow: 'hidden',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
  },
  optionSelected: {
    backgroundColor: tokens.emerald100,
  },
  optionCode: {
    ...typography.bodySm,
    fontWeight: '700',
    color: tokens.textPrimary,
  },
  optionCodeSelected: {
    color: tokens.primary,
  },
  optionDesc: {
    ...typography.label,
    letterSpacing: 0,
    color: tokens.textSecondary,
    marginTop: 1,
  },
  hint: {
    ...typography.label,
    letterSpacing: 0,
    color: tokens.textMuted,
    marginTop: spacing.xs,
    lineHeight: 16,
    paddingHorizontal: spacing.xs,
  },
});

// ─── UnitsLine (Q1: replaces the old Gross/Net/Rate UnitsSummary card) ────────
//
// A single inline computed-units line, no revenue/rate display — the CHW
// sees only the unit count (or the not-billable notice below the 16-minute
// floor), not a dollar breakdown. Rendered inside SessionTimesSection, at
// the bottom of the form.
//
// #22 (2026-07-13): a "Potential Earnings" line was added directly under the
// Units line — a flat `units * CHW_RATE_PER_UNIT` ($14/unit) estimate, via
// `computePotentialEarnings` in utils/sessionDocumentation.ts. This is
// deliberately NOT the old Gross/Net/Rate breakdown Q1 removed (no platform
// fee / PearSuite fee split shown) — just a single conservative dollar
// figure so the CHW has a rough sense of what this session is worth before
// submitting. 0 units renders "$0 — not billable" instead of "$0", so the
// not-billable state reads unambiguously rather than looking like a $0 payout.

interface UnitsLineProps {
  /** Auto-computed units from session duration. 0 means not billable. */
  value: number;
}

function UnitsLine({ value }: UnitsLineProps): React.JSX.Element {
  if (isBelowBillableFloor(value)) {
    return (
      <>
        <View style={ul.notBillableBanner} accessibilityRole="alert">
          <AlertTriangle size={16} color={tokens.red700} />
          <Text style={ul.notBillableText}>
            Under {MIN_BILLABLE_DURATION_MINUTES} minutes — not billable; no claim will be filed.
          </Text>
        </View>
        <View style={ul.row}>
          <Text style={ul.label}>Potential Earnings:</Text>
          <Text style={ul.value}>$0 — not billable</Text>
        </View>
      </>
    );
  }

  const potentialEarnings = computePotentialEarnings(value);

  return (
    <>
      <View style={ul.row}>
        <Text style={ul.label}>Units:</Text>
        <Text style={ul.value}>{value}</Text>
      </View>
      <View style={ul.row} accessibilityLabel={`Potential earnings: $${potentialEarnings}`}>
        <Text style={ul.label}>Potential Earnings:</Text>
        <Text style={ul.value}>${potentialEarnings}</Text>
      </View>
    </>
  );
}

const ul = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.xs,
    paddingHorizontal: spacing.xs,
    marginTop: spacing.sm,
  },
  label: {
    ...typography.bodySm,
    color: tokens.textSecondary,
  },
  value: {
    ...typography.bodySm,
    fontWeight: '700',
    color: tokens.textPrimary,
  },
  notBillableBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: tokens.red100,
    borderWidth: 1,
    borderColor: tokens.red700,
  },
  notBillableText: {
    ...typography.bodySm,
    color: tokens.red700,
    flex: 1,
    fontWeight: '600',
  },
});

// ─── SessionTimesSection ──────────────────────────────────────────────────────

interface SessionTimesSectionProps {
  /** Displayed "MM/DD/YYYY hh:MM AM/PM" text, not yet necessarily valid. */
  startValue: string;
  endValue: string;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  /** Inline validation message shown under each field; null hides it. */
  startError: string | null;
  endError: string | null;
  /** Live computed units (0 = not billable) — rendered as the inline UnitsLine below the fields (Q1). */
  unitsToBill: number;
}

/**
 * CHW-editable Session Start / Session End fields, plus the live computed
 * units line — rendered together at the BOTTOM of the form (Q1, 2026-07-13;
 * previously Session Time was at the top and Units to Bill was its own
 * Gross/Net/Rate card further down). Pre-filled from ``sessionStartedAt`` /
 * ``sessionEndedAt`` when the caller has them, but always editable — the CHW
 * is the source of truth for the actual times worked, and the units line
 * recomputes live from whatever is entered here via ``computeUnitsFromTimes``.
 *
 * Free-text "MM/DD/YYYY hh:MM AM/PM" (12-hour clock) input, digit-driven
 * auto-formatting (same digits-first pattern as the DOB field in
 * AddMemberModal.tsx, plus a trailing a/p keystroke for AM/PM) — see
 * ``formatSessionDateTimeInput`` / ``parseSessionDateTimeInputToIso`` in
 * utils/sessionDocumentation.ts. This EXACT shape (zero-padded month/day/
 * 12-hour-hour, "AM"/"PM") is required so it matches the billing CSV export
 * format byte-for-byte — see sessionDocumentation.ts's module docstring
 * (#21) for the backend `_fmt_la_datetime()` reference this mirrors.
 */
function SessionTimesSection({
  startValue,
  endValue,
  onStartChange,
  onEndChange,
  startError,
  endError,
  unitsToBill,
}: SessionTimesSectionProps): React.JSX.Element {
  return (
    <View style={sh.section}>
      <SectionHeader title="Session Time" marginBottom={spacing.md} />
      <Card style={st.card}>
        <View style={st.field}>
          <Text style={st.label}>Session Start</Text>
          <TextInput
            style={[st.input, !!startError && st.inputError]}
            value={startValue}
            onChangeText={(t) => onStartChange(formatSessionDateTimeInput(t))}
            placeholder="MM/DD/YYYY hh:MM AM/PM"
            placeholderTextColor={tokens.textMuted}
            keyboardType="default"
            maxLength={22}
            accessibilityLabel="Session start date and time"
          />
          {startError && <Text style={st.errorText}>{startError}</Text>}
        </View>

        <View style={st.field}>
          <Text style={st.label}>Session End</Text>
          <TextInput
            style={[st.input, !!endError && st.inputError]}
            value={endValue}
            onChangeText={(t) => onEndChange(formatSessionDateTimeInput(t))}
            placeholder="MM/DD/YYYY hh:MM AM/PM"
            placeholderTextColor={tokens.textMuted}
            keyboardType="default"
            maxLength={22}
            accessibilityLabel="Session end date and time"
          />
          {endError && <Text style={st.errorText}>{endError}</Text>}
        </View>
      </Card>
      <Text style={st.hint}>
        e.g. 07/12/2026 02:30 PM. Matches the billing export format. Used to
        auto-calculate units below.
      </Text>
      <Text style={st.hint}>
        Note: sessions are limited to 2 hours per member, per day.
      </Text>

      {/* Q1: inline computed-units line (or not-billable notice) — replaces
          the old separate "Units to Bill" Gross/Net/Rate card. */}
      <UnitsLine value={unitsToBill} />
    </View>
  );
}

const st = StyleSheet.create({
  card: {
    padding: spacing.lg,
    gap: spacing.lg,
  },
  field: {
    gap: spacing.xs,
  },
  label: {
    ...typography.label,
    letterSpacing: 0.3,
    color: tokens.textSecondary,
  },
  input: {
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    borderRadius: radius.lg,
    backgroundColor: tokens.pageBg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    ...typography.bodyMd,
    color: tokens.textPrimary,
  },
  inputError: {
    borderColor: tokens.red700,
  },
  errorText: {
    fontSize: 12,
    color: tokens.red700,
  },
  hint: {
    ...typography.label,
    letterSpacing: 0,
    color: tokens.textMuted,
    marginTop: spacing.xs,
    lineHeight: 16,
    paddingHorizontal: spacing.xs,
  },
});

// ─── DocumentationModalShell ──────────────────────────────────────────────────
//
// Owns ONLY the outer chrome difference between the two presentations — every
// prop it receives is the already-rendered form (header/content/footer as
// children) plus what's needed to pick the wrapper. Keeping this split means
// the fullscreen path is byte-for-byte what it was before Q4.

interface DocumentationModalShellProps {
  readonly presentation: 'fullscreen' | 'overlay';
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
}

function DocumentationModalShell({
  presentation,
  visible,
  onClose,
  children,
}: DocumentationModalShellProps): React.JSX.Element {
  if (presentation === 'overlay') {
    // On-brand in-app overlay: absolutely positioned over the caller's own
    // content (no RN `Modal` — that portals to a fresh document root on web,
    // which is exactly the "screen takeover" feel Q4 replaces). Scrim +
    // centered card visual language matches AppDialogProvider and this same
    // component's own web confirm/success panels below.
    // The caller (DocumentationModal below) already returns null when
    // `!visible` for the overlay presentation, so this branch only ever
    // renders while visible — no separate visible-gating needed here.
    return (
      <View style={mo.overlayRoot} accessibilityViewIsModal accessibilityRole="none">
        <View style={mo.overlayScrim} />
        <View style={mo.overlayCard}>{children}</View>
      </View>
    );
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      accessible
      accessibilityViewIsModal
    >
      <View style={mo.container}>{children}</View>
    </Modal>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * Documents a completed CHW session. Renders full-screen (default) or as an
 * on-brand Messages overlay — see `presentation` above and
 * `DocumentationModalShell`.
 *
 * "Your Notes" is CHW-authored, editable, required for submit. Session Start
 * / Session End are also CHW-editable (pre-filled from sessionStartedAt /
 * sessionEndedAt when known) and drive the live Units to Bill computation.
 *
 * Validates that at least one diagnosis code is selected, a procedure code
 * is chosen, CHW notes are non-empty, and both session times are valid with
 * end after start, before allowing submit.
 */
export function DocumentationModal({
  visible,
  onClose,
  sessionId,
  memberId,
  durationMinutes,
  sessionStartedAt,
  sessionEndedAt,
  onSubmit,
  presentation = 'fullscreen',
}: DocumentationModalProps): React.JSX.Element | null {
  const [selectedDiagnosisCodes, setSelectedDiagnosisCodes] = useState<string[]>([]);
  const [selectedProcedureCode, setSelectedProcedureCode] = useState<string>(
    procedureCodes[0]?.code ?? '',
  );
  // Session Start / Session End — CHW-editable "MM/DD/YYYY hh:MM AM/PM" text,
  // pre-filled from the session record when available. Lazy initializers run
  // once per mount; callers conditionally mount this modal (documentingSessionId
  // != null), so a fresh mount always reflects the current session's times.
  // NOTE: draft restoration (see the "Draft persistence" effect below) can
  // overwrite these lazy-initial values shortly after mount, once an
  // AsyncStorage read for this sessionId resolves.
  const [sessionStartInput, setSessionStartInput] = useState<string>(() =>
    formatIsoForSessionDateTimeInput(sessionStartedAt),
  );
  const [sessionEndInput, setSessionEndInput] = useState<string>(() =>
    formatIsoForSessionDateTimeInput(sessionEndedAt),
  );
  // CHW-authored notes — required, separate from diagnosis/procedure codes.
  const [chwNotes, setChwNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // After a successful submit, show an in-app "submitted for billing" panel
  // (replaces the browser alert + earnings breakdown). Dismissed via Done.
  const [showSubmitted, setShowSubmitted] = useState(false);
  // Web billing-confirm gate, shown as an in-app panel instead of the browser's
  // "joincompasschw.com says" window.confirm — so the CHW sees it as part of
  // Compass, clearly tied to their submission. (Native uses the styled Alert.)
  const [showConfirm, setShowConfirm] = useState(false);
  // Tracks whether the notes TextInput is focused, for focus-ring styling.
  const [notesFocused, setNotesFocused] = useState(false);
  // On-brand inline error banner for a failed documentation submission
  // (e.g. "Daily unit cap exceeded. 0 units remaining today."). Replaces the
  // browser `window.alert` / native `Alert.alert` that used to fire from the
  // caller's onSubmit catch handler — the modal now owns error display so
  // both web and native share one on-brand surface and the modal explicitly
  // stays open for the CHW to adjust and retry. Cleared on the next submit
  // attempt and whenever the CHW edits a field (see the effect below).
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Case notes the CHW wrote during this session — used to pre-fill the Session
  // Notes field so they can review/edit rather than retype. Only fetched while
  // the modal is open and a member is known.
  const caseNotesQuery = useCaseNotes(memberId ?? '', {
    enabled: visible && !!memberId,
  });

  // Guard: pre-fill Session Notes from case notes only once per modal-open.
  const notesPrefilledRef = useRef(false);

  // ── Draft persistence (#23) ────────────────────────────────────────────
  //
  // `draftLoaded` (real React state, NOT a plain ref) guards the
  // debounced-save effect below from firing — and persisting a blank/default
  // draft over a real one — before the initial AsyncStorage read for the
  // current sessionId has resolved. It MUST be state rather than a ref: the
  // debounce-save effect's dependency array can't "see" a ref flip, so a
  // ref-only guard would leave that effect permanently gated off after the
  // async read resolves with "no draft found" (nothing else changes React
  // state in that branch, so no re-render — and therefore no effect
  // re-evaluation — would ever follow the ref write). `draftRestoredRef`
  // (a plain ref is fine here — it's read inside another effect's body, not
  // depended on) records whether a non-empty draft was actually found and
  // restored for the current open — the case-notes prefill effect reads
  // this to skip pre-filling over a restored draft (#24: "a restored draft
  // must NOT be clobbered by the prefill — prefill only when no draft
  // exists").
  const [draftLoaded, setDraftLoaded] = useState(false);
  const draftRestoredRef = useRef(false);

  // Reset the pre-fill guard and draft-load state each time the modal opens
  // (for a new session) — and, while closed, load this session's persisted
  // draft (if any) so it's ready to restore into fresh form state the moment
  // the modal opens for this sessionId.
  useEffect(() => {
    if (!visible) {
      notesPrefilledRef.current = false;
      setDraftLoaded(false);
      draftRestoredRef.current = false;
      return;
    }
    if (!sessionId) {
      setDraftLoaded(true); // nothing to load against — treat as "loaded, no draft"
      return;
    }
    let cancelled = false;
    void readDraft(sessionId).then((draft) => {
      if (cancelled) return;
      if (draft && !isEmptyDraft(draft)) {
        setChwNotes(draft.chwNotes);
        setSelectedDiagnosisCodes(draft.selectedDiagnosisCodes);
        if (draft.selectedProcedureCode) {
          setSelectedProcedureCode(draft.selectedProcedureCode);
        }
        setSessionStartInput(draft.sessionStartInput);
        setSessionEndInput(draft.sessionEndInput);
        draftRestoredRef.current = true;
        // A restored draft already has its own notes (possibly empty, if the
        // CHW cleared them) — never let the case-notes prefill run over it.
        notesPrefilledRef.current = true;
      }
      setDraftLoaded(true);
    });
    return () => {
      cancelled = true;
    };
    // Only re-run when the modal opens/closes or targets a different session —
    // re-reading on every keystroke would fight the debounced-save effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sessionId]);

  // Clear a previous submit-failure banner as soon as the CHW edits the
  // form — an error about "Daily unit cap exceeded" (say) is stale the
  // moment the CHW starts adjusting the times/notes to address it, and
  // leaving it up would misleadingly suggest the NEW content already failed.
  useEffect(() => {
    setSubmitError(null);
    // Intentionally omits `submitError` itself from deps — this effect only
    // reacts to field edits, never to the error being set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chwNotes, sessionStartInput, sessionEndInput, selectedDiagnosisCodes, selectedProcedureCode]);

  // Pre-fill Session Notes with this session's case notes, once, without
  // clobbering anything the CHW has already typed OR a just-restored draft
  // (#24 regression: draft restoration always wins over the case-note
  // prefill — see draftRestoredRef above, set before this effect's guard
  // check ever runs for a session with a real draft).
  useEffect(() => {
    if (!visible || !sessionId || notesPrefilledRef.current) return;
    if (!draftLoaded) return; // wait for the draft-load check to settle first
    if (caseNotesQuery.isLoading) return; // wait for the fetch to settle
    // Don't overwrite in-progress edits.
    if (chwNotes.trim().length > 0) {
      notesPrefilledRef.current = true;
      return;
    }
    const sessionNotes = (caseNotesQuery.data?.items ?? [])
      .filter((note) => note.sessionId === sessionId)
      .slice()
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map((note) => note.body.trim())
      .filter(Boolean);
    notesPrefilledRef.current = true;
    if (sessionNotes.length > 0) {
      setChwNotes(sessionNotes.join('\n\n').slice(0, NOTES_MAX));
    }
  }, [visible, sessionId, caseNotesQuery.isLoading, caseNotesQuery.data, chwNotes, draftLoaded]);

  // Debounced draft auto-save — persists the CHW-editable form fields to
  // AsyncStorage keyed by sessionId whenever any of them change, so
  // navigating away from Messages (or wherever this modal is mounted) and
  // back restores the in-progress draft exactly. Skipped until the initial
  // draft-load check for this sessionId has settled (`draftLoaded` state —
  // see its declaration above for why this can't be a plain ref), so a
  // fresh mount's default/pre-fill values can't race ahead of — and
  // overwrite — a real persisted draft before it's had a chance to restore.
  useEffect(() => {
    if (!visible || !sessionId) return;
    if (!draftLoaded) return;

    const draft: DocumentationDraft = {
      chwNotes,
      selectedDiagnosisCodes,
      selectedProcedureCode,
      sessionStartInput,
      sessionEndInput,
    };

    const timer = setTimeout(() => {
      if (isEmptyDraft(draft)) {
        // Nothing worth persisting (e.g. the CHW cleared everything back
        // out) — clear any stale draft rather than writing an empty one.
        void clearDraft(sessionId);
      } else {
        void writeDraft(sessionId, draft);
      }
    }, DRAFT_SAVE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [
    visible,
    sessionId,
    draftLoaded,
    chwNotes,
    selectedDiagnosisCodes,
    selectedProcedureCode,
    sessionStartInput,
    sessionEndInput,
  ]);

  // Reset all form state when modal closes. Belt-and-suspenders: callers
  // conditionally mount this modal, so React's own unmount already clears
  // state, but this mirrors the pre-existing reset pattern for any caller
  // that instead toggles the `visible` prop on a persistently-mounted modal.
  useEffect(() => {
    if (!visible) {
      setChwNotes('');
      setSelectedDiagnosisCodes([]);
      setSelectedProcedureCode(procedureCodes[0]?.code ?? '');
      setSessionStartInput(formatIsoForSessionDateTimeInput(sessionStartedAt));
      setSessionEndInput(formatIsoForSessionDateTimeInput(sessionEndedAt));
    }
    // Only re-run on visibility changes — re-syncing on every prop identity
    // change would clobber in-progress edits while the modal is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // ── Units to Bill — derived live from the edited Session Start/End times ──
  const startIso = useMemo(
    () => parseSessionDateTimeInputToIso(sessionStartInput),
    [sessionStartInput],
  );
  const endIso = useMemo(
    () => parseSessionDateTimeInputToIso(sessionEndInput),
    [sessionEndInput],
  );
  const timesResult = useMemo(
    () => computeUnitsFromTimes(startIso, endIso),
    [startIso, endIso],
  );
  // Legacy fallback: until both times are valid, show units derived from the
  // durationMinutes prop (if any) rather than an unconditional 1-unit floor,
  // so callers not yet wired to sessionStartedAt/sessionEndedAt still see a
  // sensible starting number. Once both times are valid, they're authoritative.
  const unitsToBill =
    timesResult.durationMinutes != null ? timesResult.units : computeUnitsFromDuration(durationMinutes);

  const startError: string | null =
    sessionStartInput.length > 0 && timesResult.error === 'invalid_start'
      ? 'Enter a valid date & time (MM/DD/YYYY hh:MM AM/PM).'
      : null;
  const endError: string | null =
    sessionEndInput.length > 0 && timesResult.error === 'invalid_end'
      ? 'Enter a valid date & time (MM/DD/YYYY hh:MM AM/PM).'
      : timesResult.error === 'end_before_start'
      ? 'Session end must be after session start.'
      : null;

  // Q2 (16-minute billable floor): a session under 16 minutes computes to 0
  // units and is NOT billable. The CHW must never be able to file a
  // <16-minute claim — block submit entirely rather than allowing a
  // documentation-without-billing path, matching the backend's
  // validate_claim() rejecting a computed 0-unit claim with a 422 (see
  // billing_service.py). Only evaluated once both times are otherwise valid
  // (timesResult.error === null) so the "not billable" message doesn't
  // compete with the "enter a valid time" messages above.
  const isBelowFloor = timesResult.error === null && isBelowBillableFloor(unitsToBill);

  const isValid =
    selectedDiagnosisCodes.length > 0 &&
    selectedProcedureCode.length > 0 &&
    chwNotes.trim().length > 0 &&
    timesResult.error === null &&
    !isBelowFloor;

  const toggleDiagnosisCode = useCallback((code: string): void => {
    setSelectedDiagnosisCodes((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  }, []);

  const performSubmit = useCallback(async (): Promise<void> => {
    if (!isValid || isSubmitting) return;

    setIsSubmitting(true);
    // A new submit attempt clears any error banner from a previous failed
    // attempt — the CHW is retrying, so a stale reason must not linger.
    setSubmitError(null);

    const documentation: SessionDocumentation = {
      sessionId,
      // CHW-authored notes field — always the canonical `summary` key per backend contract.
      summary: chwNotes,
      diagnosisCodes: selectedDiagnosisCodes,
      procedureCode: selectedProcedureCode,
      unitsToBill,
      submittedAt: new Date().toISOString(),
      // isValid already guarantees timesResult.error === null, so both are non-null here.
      sessionStartTime: startIso,
      sessionEndTime: endIso,
    };

    // Await the parent's onSubmit so we only show "submitted" after the
    // API call actually succeeds. On failure the parent rethrows (it no
    // longer shows its own alert — see the three CHW*Screen onSubmit
    // handlers) so we can surface the reason as an in-app banner here and
    // keep the modal open for the CHW to adjust and retry.
    try {
      const maybePromise = onSubmit(documentation) as unknown;
      if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
        await maybePromise;
      }
    } catch (err) {
      const reason =
        err instanceof Error && err.message
          ? err.message
          : 'Something went wrong submitting this documentation.';
      setSubmitError(reason);
      setIsSubmitting(false);
      return;
    }

    setIsSubmitting(false);

    // #23: the documentation is now filed — clear the persisted draft so a
    // future open for this sessionId (if the modal is ever reopened, e.g.
    // after a retry-driven re-navigation) doesn't resurrect stale content
    // for a session that's already been submitted.
    void clearDraft(sessionId);

    // In-app, on-brand confirmation (replaces the browser "…says" alert and the
    // old earnings/units breakdown). Shows a styled success panel inside the
    // modal; the CHW dismisses it with Done, which closes the modal.
    setShowSubmitted(true);
  }, [
    isValid,
    isSubmitting,
    sessionId,
    chwNotes,
    selectedDiagnosisCodes,
    selectedProcedureCode,
    unitsToBill,
    startIso,
    endIso,
    onSubmit,
  ]);

  /**
   * Two-stage submit: tap once → confirmation alert showing the dollar
   * amount about to be billed → tap "Submit Claim" → real submit fires.
   * Cheap claim-preview gate so a CHW can't accidentally one-tap a claim
   * without seeing the gross/net breakdown. Replaces silent auto-submission.
   */
  const handleSubmit = useCallback((): void => {
    if (!isValid || isSubmitting) return;

    // Plain confirmation gate — guards against an accidental one-tap claim
    // filing without exposing any earnings/payout breakdown to the CHW.
    const confirmBody = "Submit this session's documentation for billing?";

    // On web, RN's Alert.alert() multi-button callback shape is a no-op, and
    // window.confirm() renders the browser's "…says" box (off-brand, reads as
    // disconnected from Compass). Show an in-app confirm panel instead. Native
    // keeps the OS-styled Alert, which already looks in-app.
    if (Platform.OS === 'web') {
      setShowConfirm(true);
      return;
    }

    Alert.alert(
      'Submit for billing',
      confirmBody,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Submit',
          style: 'default',
          onPress: () => {
            void performSubmit();
          },
        },
      ],
    );
  }, [
    isValid,
    isSubmitting,
    performSubmit,
  ]);

  // Overlay presentation never mounts an RN `Modal` at all — a plain View
  // that renders nothing while closed, matching Modal's own `visible={false}`
  // no-op-render semantics for callers that keep this component mounted.
  if (presentation === 'overlay' && !visible) return null;

  return (
    <DocumentationModalShell presentation={presentation} visible={visible} onClose={onClose}>
      <View
        style={presentation === 'overlay' ? mo.overlayContainer : mo.container}
      >
        {/* ── In-app billing confirm gate (web) — replaces the browser
              window.confirm so the prompt reads as part of Compass. ────────── */}
        {showConfirm && !showSubmitted && (
          <View style={mo.confirmOverlay} accessibilityViewIsModal>
            <View style={mo.confirmCard}>
              <Text style={mo.confirmTitle}>Submit for billing</Text>
              <Text style={mo.confirmBody}>
                Submit this session&apos;s documentation for billing?
              </Text>
              <View style={mo.confirmActions}>
                <TouchableOpacity
                  style={mo.confirmCancelBtn}
                  onPress={() => setShowConfirm(false)}
                  disabled={isSubmitting}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel"
                >
                  <Text style={mo.confirmCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={mo.confirmSubmitBtn}
                  onPress={() => {
                    setShowConfirm(false);
                    void performSubmit();
                  }}
                  disabled={isSubmitting}
                  accessibilityRole="button"
                  accessibilityLabel="Submit for billing"
                >
                  <Text style={mo.confirmSubmitText}>Submit</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        {/* ── Submitted-for-billing success panel (in-app, replaces the browser
              alert + earnings breakdown). Covers the form once the claim files. */}
        {showSubmitted && (
          <View style={mo.submittedOverlay} accessibilityViewIsModal>
            <View style={mo.submittedIconCircle}>
              <Check size={30} color="#FFFFFF" strokeWidth={3} />
            </View>
            <Text style={mo.submittedTitle}>
              Session submitted for billing pending approval
            </Text>
            <TouchableOpacity
              style={mo.submittedDoneBtn}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Done"
            >
              <Text style={mo.submittedDoneText}>Done</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Header ───────────────────────────────────────────────────────── */}
        <View style={mo.header}>
          <View style={mo.headerText}>
            <Text style={mo.headerTitle}>Complete Session</Text>
            <Text style={mo.headerSubtitle}>
              {sessionId}
            </Text>
          </View>
          <TouchableOpacity
            style={mo.closeButton}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close documentation modal"
          >
            <X size={20} color={tokens.textPrimary} />
          </TouchableOpacity>
        </View>

        {/* ── Documentation-submit failure banner (in-app, replaces the browser
              alert). On-brand, matches the RegisterScreen error-banner
              convention: #FEE2E2 background / #B91C1C text. Rendered outside
              the ScrollView so it's visible immediately on failure regardless
              of scroll position; cleared on the next submit attempt or field
              edit (see the effect above performSubmit). ──────────────────── */}
        {submitError && (
          <View style={mo.submitErrorBanner} accessibilityLiveRegion="polite">
            <Text style={mo.submitErrorText}>
              Failed to submit documentation: {submitError}
            </Text>
            <Text style={mo.submitErrorHint}>
              The modal will stay open so you can adjust and try again.
            </Text>
          </View>
        )}

        {/* ── Scrollable content ───────────────────────────────────────────── */}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={mo.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Diagnosis codes — grouped by resource-need vertical (Q3) */}
          <DiagnosisCodeSection
            selectedCodes={selectedDiagnosisCodes}
            onToggle={toggleDiagnosisCode}
          />

          {/* Procedure code */}
          <ProcedureCodePicker
            value={selectedProcedureCode}
            onChange={setSelectedProcedureCode}
          />

          {/* ── CHW Notes — authored, required ───────────────────────────── */}
          <View style={sh.section}>
            <SectionHeader
              title="Your Notes"
              marginBottom={4}
              right={
                <Text style={mo.charCounter}>{chwNotes.length}/{NOTES_MAX}</Text>
              }
            />
            <Text style={mo.notesHelper}>Visible to billing/audit as CHW-authored</Text>
            <Card
              style={[
                mo.notesCard,
                notesFocused && mo.notesCardFocused,
              ]}
            >
              <ResourceMentionInput
                style={mo.notesInput}
                value={chwNotes}
                onChangeText={(v) => {
                  if (v.length <= NOTES_MAX) setChwNotes(v);
                }}
                onFocus={() => setNotesFocused(true)}
                onBlur={() => setNotesFocused(false)}
                placeholder="What did you discuss? Type @ to mention a community resource…"
                placeholderTextColor={tokens.textMuted}
                multiline
                numberOfLines={4}
                textAlignVertical="top"
                maxLength={NOTES_MAX}
                accessibilityLabel="Your notes — CHW-authored. Type @ to mention a resource."
              />
            </Card>
          </View>

          {/* Q1: Session Start / Session End + inline computed-units line —
              bottom of the form, immediately above Submit. Replaces the old
              top-of-form placement and the separate Gross/Net/Rate
              UnitsSummary card. */}
          <SessionTimesSection
            startValue={sessionStartInput}
            endValue={sessionEndInput}
            onStartChange={setSessionStartInput}
            onEndChange={setSessionEndInput}
            startError={startError}
            endError={endError}
            unitsToBill={unitsToBill}
          />
        </ScrollView>

        {/* ── Fixed footer ──────────────────────────────────────────────────── */}
        <View style={mo.footer}>
          {!isValid && (
            <Text style={mo.validationHint}>
              {selectedDiagnosisCodes.length === 0
                ? 'Select at least one diagnosis code to submit.'
                : !selectedProcedureCode
                ? 'Select a procedure code to submit.'
                : chwNotes.trim().length === 0
                ? 'Your notes are required before submitting.'
                : timesResult.error === 'invalid_start'
                ? 'Enter a valid session start time (MM/DD/YYYY hh:MM AM/PM).'
                : timesResult.error === 'invalid_end'
                ? 'Enter a valid session end time (MM/DD/YYYY hh:MM AM/PM).'
                : timesResult.error === 'end_before_start'
                ? 'Session end must be after session start.'
                : isBelowFloor
                ? `Session is under ${MIN_BILLABLE_DURATION_MINUTES} minutes and is not billable — no claim can be filed.`
                : 'Your notes are required before submitting.'}
            </Text>
          )}
          <Pressable
            style={({ pressed }: { pressed?: boolean }) => [
              mo.submitButton,
              (!isValid || isSubmitting) && mo.submitButtonDisabled,
              pressed && isValid && !isSubmitting && mo.submitButtonPressed,
            ]}
            onPress={handleSubmit}
            disabled={!isValid || isSubmitting}
            accessibilityRole="button"
            accessibilityLabel="Submit documentation and billing"
            accessibilityState={{ disabled: !isValid || isSubmitting }}
          >
            <FileText size={16} color="#FFFFFF" />
            <Text style={mo.submitButtonText}>
              {isSubmitting ? 'Submitting...' : 'Submit Documentation & Billing'}
            </Text>
          </Pressable>
        </View>
      </View>
    </DocumentationModalShell>
  );
}

// ─── Styles (main modal shell) ────────────────────────────────────────────────

const mo = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: tokens.pageBg,
  },
  // ── Overlay presentation (Q4) — anchored over the caller's own content,
  // not a navigation-level Modal. `overlayRoot` fills whatever positioned
  // ancestor the caller renders it inside (CHWMessagesScreen wraps the
  // AppShell children in a `position: relative` root — see styles.root
  // there); `absoluteFillObject` covers just that container, not the full
  // window, so the sidebar/AppShell chrome stays visible and it never
  // escapes into a separate document root the way RN's web Modal does.
  overlayRoot: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlayScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
  },
  // Card chrome matches AppDialogProvider / the in-app confirm panel below:
  // white card, tokens.radius.lg corners, shadows.card elevation. `height`
  // (not just maxHeight) is required here — react-native-web's flexbox needs
  // a resolvable height on this ancestor for the inner `flex: 1` ScrollView
  // to compute a bound and actually scroll instead of pushing the footer off
  // the bottom; `88%` of the (bounded) overlayRoot gives the same "shorter
  // than a full screen takeover" panel feel while still resolving to a real
  // pixel height at every viewport, including rail-hidden narrow widths.
  overlayCard: {
    width: '92%',
    maxWidth: 640,
    height: '88%',
    maxHeight: 760,
    backgroundColor: tokens.cardBg,
    borderRadius: radius.xl,
    overflow: 'hidden',
    ...shadows.card,
  },
  // Inner container swaps `container`'s `flex: 1` (which assumes a Modal's
  // full-window height) for a column that fills the fixed-height overlayCard
  // above, so header/scroll/footer lay out and scroll correctly.
  overlayContainer: {
    flex: 1,
    backgroundColor: tokens.pageBg,
  },
  // In-app billing confirm gate (web) — a centered dialog card over a scrim,
  // so the prompt reads as part of Compass rather than a browser popup.
  confirmOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  confirmCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: tokens.cardBg,
    borderRadius: radius.lg,
    padding: spacing.xl,
    gap: spacing.md,
    ...shadows.card,
  },
  confirmTitle: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 17,
    color: tokens.textPrimary,
  },
  confirmBody: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    lineHeight: 20,
    color: tokens.textSecondary,
  },
  confirmActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  confirmCancelBtn: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    backgroundColor: tokens.cardBg,
  },
  confirmCancelText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: tokens.textPrimary,
  },
  confirmSubmitBtn: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: tokens.primary,
  },
  confirmSubmitText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#FFFFFF',
  },
  // In-app success panel shown after a claim files — replaces the browser alert.
  submittedOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
    backgroundColor: tokens.pageBg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.xl,
  },
  submittedIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: tokens.emerald700,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submittedTitle: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 18,
    lineHeight: 26,
    color: tokens.textPrimary,
    textAlign: 'center',
    maxWidth: 360,
  },
  submittedDoneBtn: {
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: tokens.primary,
  },
  submittedDoneText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 15,
    color: '#FFFFFF',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
    backgroundColor: tokens.cardBg,
    ...(shadows.card as object),
  },
  headerText: {
    gap: 2,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: tokens.textPrimary,
    lineHeight: 26,
  },
  headerSubtitle: {
    fontSize: 11,
    fontFamily: 'monospace',
    color: tokens.textMuted,
    letterSpacing: 0.5,
    marginTop: 2,
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: tokens.pageBg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: tokens.cardBorder,
  },
  scrollContent: {
    padding: spacing.xl,
    paddingBottom: spacing.lg,
  },
  // Documentation-submit failure banner — same on-brand palette as the
  // RegisterScreen inline error banner (#FEE2E2 bg / #B91C1C text).
  submitErrorBanner: {
    marginHorizontal: spacing.xl,
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: '#FEE2E2',
  },
  submitErrorText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#B91C1C',
  },
  submitErrorHint: {
    fontSize: 12,
    color: '#B91C1C',
    marginTop: 2,
  },
  charCounter: {
    fontSize: 12,
    fontWeight: '400',
    color: tokens.textMuted,
  },
  notesHelper: {
    fontSize: 12,
    color: tokens.textMuted,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  notesCard: {
    overflow: 'hidden',
  },
  notesCardFocused: {
    borderColor: tokens.primary + '66', // primary @ 40% opacity
  },
  notesInput: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: 96,
    ...typography.bodyMd,
    color: tokens.textPrimary,
    backgroundColor: tokens.cardBg,
  },
  footer: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    paddingBottom: Platform.OS === 'ios' ? 32 : spacing.lg,
    borderTopWidth: 1,
    borderTopColor: tokens.cardBorder,
    backgroundColor: tokens.cardBg,
    gap: spacing.sm,
  },
  validationHint: {
    fontSize: 12,
    color: tokens.textMuted,
    textAlign: 'center',
  },
  submitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: tokens.primary,
    borderRadius: radius.xl,
    paddingVertical: spacing.lg,
  },
  submitButtonDisabled: {
    opacity: 0.4,
  },
  submitButtonPressed: {
    backgroundColor: tokens.primaryHover,
  },
  submitButtonText: {
    ...typography.bodyMd,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});
