/**
 * DocumentationModal — full-screen modal for documenting a completed session.
 *
 * Visual language: shared design-system tokens (theme/tokens) + ui/ primitives
 * (Card, SectionHeader). Legacy beige/cream theme/colors palette removed.
 *
 * Sections (in render order):
 *  - Session Time: CHW-editable Session Start / Session End (MM/DD/YYYY HH:MM,
 *    24hr) — pre-filled from sessionStartedAt/sessionEndedAt when known
 *  - Diagnosis Codes (Z-Codes): expandable categories with tap-to-select codes
 *  - Procedure Code: picker from procedureCodes mock data
 *  - Session Notes: multiline TextInput (2000 char limit with counter)
 *  - Units to Bill: read-only billing summary, derived live from the edited
 *    Session Start/End times (StatTile-style 3-column layout) — bottom of
 *    the form, immediately above Submit
 *  - Submit Documentation button
 *
 * 2026-07-12 redesign: Members Served, Member Goals Discussed, Resources
 * Referred, Follow-Up Needed, and AI Summary were removed (backend schema
 * defaults them); Session Start/End replace session duration as the
 * units-to-bill driver. See src/utils/sessionDocumentation.ts for the pure
 * parsing/bracket math.
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
  DollarSign,
} from 'lucide-react-native';
import { ResourceMentionInput } from '../resources/ResourceMentionInput';

import { colors as tokens, numerals, spacing, radius, shadows } from '../../theme/tokens';
import { typography } from '../../theme/typography';
import { Card, SectionHeader } from '../ui';
import { useCaseNotes } from '../../hooks/useApiQueries';
import {
  diagnosisCodes,
  procedureCodes,
  zCodeCategoryLabels,
  type ZCodeCategory,
  type SessionDocumentation,
  MEDI_CAL_RATE,
  NET_PAYOUT_RATE,
  formatCurrency,
} from '../../data/mock';
import {
  computeUnitsFromDuration,
  computeUnitsFromTimes,
  formatIsoForSessionDateTimeInput,
  formatSessionDateTimeInput,
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
}

// ─── Constants ────────────────────────────────────────────────────────────────

const Z_CODE_CATEGORIES: ZCodeCategory[] = [
  'counseling',
  'housing_economic',
  'health_access',
  'behavioral',
  'legal',
];

// Session Notes cap. Roomy enough to hold this session's case notes (pre-filled
// for review/editing) plus the CHW's edits; the backend `summary` column is
// unbounded Text, so this is a UI guardrail only.
const NOTES_MAX = 2000;

// ─── DiagnosisCodeSection ─────────────────────────────────────────────────────

interface DiagnosisCodeSectionProps {
  selectedCodes: string[];
  onToggle: (code: string) => void;
}

function DiagnosisCodeSection({
  selectedCodes,
  onToggle,
}: DiagnosisCodeSectionProps): React.JSX.Element {
  const [expandedCategories, setExpandedCategories] = useState<Set<ZCodeCategory>>(new Set());

  const codesByCategory = useMemo(() => {
    const map = new Map<ZCodeCategory, typeof diagnosisCodes>();
    for (const category of Z_CODE_CATEGORIES) {
      map.set(
        category,
        diagnosisCodes.filter((d) => d.category === category && !d.isArchived),
      );
    }
    return map;
  }, []);

  function toggleCategory(category: ZCodeCategory): void {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }

  return (
    <View style={sh.section}>
      <SectionHeader title="Diagnosis Codes (Z-Codes)" marginBottom={spacing.md} />

      {Z_CODE_CATEGORIES.map((category) => {
        const codes = codesByCategory.get(category) ?? [];
        const isExpanded = expandedCategories.has(category);
        const selectedInCategory = codes.filter((c) => selectedCodes.includes(c.code)).length;

        return (
          <Card key={category} style={sh.categoryCard}>
            <TouchableOpacity
              style={sh.categoryHeader}
              onPress={() => toggleCategory(category)}
              accessibilityRole="button"
              accessibilityState={{ expanded: isExpanded }}
              accessibilityLabel={`${zCodeCategoryLabels[category]}${selectedInCategory > 0 ? `, ${selectedInCategory} selected` : ''}`}
              activeOpacity={0.7}
            >
              <Text style={sh.categoryLabel}>{zCodeCategoryLabels[category]}</Text>
              <View style={sh.categoryRightRow}>
                {selectedInCategory > 0 && (
                  <View style={sh.categoryBadge}>
                    <Text style={sh.categoryBadgeText}>{selectedInCategory}</Text>
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
                      style={[sh.codeRow, isSelected && sh.codeRowSelected]}
                      onPress={() => onToggle(code.code)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: isSelected }}
                      accessibilityLabel={`${code.code}: ${code.description}`}
                      activeOpacity={0.7}
                    >
                      <View style={[sh.codeCheckbox, isSelected && sh.codeCheckboxChecked]}>
                        {isSelected && <Check size={9} color="#FFFFFF" strokeWidth={3} />}
                      </View>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={[sh.codeText, isSelected && sh.codeTextSelected]}>
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
  codeRowSelected: {
    backgroundColor: tokens.emerald100,
  },
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
  codeCheckboxChecked: {
    borderColor: tokens.primary,
    backgroundColor: tokens.primary,
  },
  codeText: {
    ...typography.bodySm,
    fontWeight: '700',
    color: tokens.textPrimary,
  },
  codeTextSelected: {
    color: tokens.primary,
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

// ─── UnitsSummary (read-only, derived from session duration) ─────────────────

interface UnitsSummaryProps {
  /** Auto-computed units from session duration. Always 1–4. */
  value: number;
  /** Total session duration in minutes (for the rate-explanation footnote). */
  durationMinutes: number | null | undefined;
}

/**
 * Read-only billing summary. The units value is derived authoritatively from
 * the session's duration (see ``computeUnitsFromDuration``) so CHWs cannot
 * upcode at the form. The server recomputes from the same bracket and ignores
 * any client-sent units.
 *
 * Layout: hero unit count above a 3-column Gross / Net / Rate stat row.
 */
function UnitsSummary({ value, durationMinutes }: UnitsSummaryProps): React.JSX.Element {
  const grossAmount = value * MEDI_CAL_RATE;
  const netAmount = grossAmount * NET_PAYOUT_RATE;
  const durationLabel =
    durationMinutes != null ? `${durationMinutes} min session` : 'Session duration unavailable';

  return (
    <View style={sh.section}>
      <SectionHeader title="Units to Bill" marginBottom={spacing.md} />

      {/* Hero unit count */}
      <Card style={us.heroCard}>
        <View style={us.heroInner}>
          <View style={[us.iconBadge, { backgroundColor: tokens.emerald100 }]}>
            <DollarSign size={18} color={tokens.emerald700} />
          </View>
          <View style={us.heroText}>
            <Text style={[us.heroValue, numerals.tabular]}>
              {value} {value === 1 ? 'unit' : 'units'}
            </Text>
            <Text style={us.heroFootnote}>Auto-calculated · {durationLabel}</Text>
          </View>
        </View>
      </Card>

      {/* 3-column billing stat tiles */}
      <View style={us.statRow}>
        <Card style={us.statCell}>
          <Text style={us.statLabel}>Gross</Text>
          <Text style={[us.statValue, numerals.tabular]}>{formatCurrency(grossAmount)}</Text>
        </Card>
        <Card style={us.statCell}>
          <Text style={us.statLabel}>Net (85%)</Text>
          <Text style={[us.statValue, { color: tokens.primary }, numerals.tabular]}>{formatCurrency(netAmount)}</Text>
        </Card>
        <Card style={us.statCell}>
          <Text style={us.statLabel}>Rate</Text>
          <Text style={[us.statValue, numerals.tabular]}>{formatCurrency(MEDI_CAL_RATE)}/unit</Text>
        </Card>
      </View>
    </View>
  );
}

const us = StyleSheet.create({
  heroCard: {
    padding: spacing.lg,
    marginBottom: spacing.sm,
  },
  heroInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  iconBadge: {
    width: 40,
    height: 40,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  heroText: {
    flex: 1,
    gap: 2,
  },
  heroValue: {
    fontSize: 22,
    fontWeight: '800',
    color: tokens.textPrimary,
    lineHeight: 28,
  },
  heroFootnote: {
    ...typography.label,
    letterSpacing: 0,
    color: tokens.textMuted,
    fontStyle: 'italic',
  },
  statRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  statCell: {
    flex: 1,
    padding: spacing.md,
    alignItems: 'center',
    gap: spacing.xs,
  },
  statLabel: {
    ...typography.label,
    letterSpacing: 0.3,
    color: tokens.textSecondary,
    textAlign: 'center',
  },
  statValue: {
    fontSize: 15,
    fontWeight: '700',
    color: tokens.textPrimary,
    textAlign: 'center',
  },
});

// ─── SessionTimesSection ──────────────────────────────────────────────────────

interface SessionTimesSectionProps {
  /** Displayed "MM/DD/YYYY HH:MM" text, not yet necessarily valid. */
  startValue: string;
  endValue: string;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  /** Inline validation message shown under each field; null hides it. */
  startError: string | null;
  endError: string | null;
}

/**
 * CHW-editable Session Start / Session End fields. Pre-filled from
 * ``sessionStartedAt`` / ``sessionEndedAt`` when the caller has them, but
 * always editable — the CHW is the source of truth for the actual times
 * worked, and Units to Bill (rendered at the bottom of the form) is derived
 * live from whatever is entered here via ``computeUnitsFromTimes``.
 *
 * Free-text "MM/DD/YYYY HH:MM" (24-hour clock) input with digit-only
 * auto-formatting, mirroring the DOB field in AddMemberModal.tsx — see
 * ``formatSessionDateTimeInput`` / ``parseSessionDateTimeInputToIso`` in
 * utils/sessionDocumentation.ts. A 24-hour clock avoids AM/PM letters (kept
 * consistent with the digits-only mask) and AM/PM ambiguity in a
 * billing-adjacent field.
 */
function SessionTimesSection({
  startValue,
  endValue,
  onStartChange,
  onEndChange,
  startError,
  endError,
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
            placeholder="MM/DD/YYYY HH:MM"
            placeholderTextColor={tokens.textMuted}
            keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default'}
            maxLength={16}
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
            placeholder="MM/DD/YYYY HH:MM"
            placeholderTextColor={tokens.textMuted}
            keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default'}
            maxLength={16}
            accessibilityLabel="Session end date and time"
          />
          {endError && <Text style={st.errorText}>{endError}</Text>}
        </View>
      </Card>
      <Text style={st.hint}>
        24-hour clock, e.g. 07/12/2026 14:30. Used to auto-calculate Units to Bill below.
      </Text>
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

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * Full-screen modal for documenting a completed CHW session.
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
}: DocumentationModalProps): React.JSX.Element {
  const [selectedDiagnosisCodes, setSelectedDiagnosisCodes] = useState<string[]>([]);
  const [selectedProcedureCode, setSelectedProcedureCode] = useState<string>(
    procedureCodes[0]?.code ?? '',
  );
  // Session Start / Session End — CHW-editable "MM/DD/YYYY HH:MM" text,
  // pre-filled from the session record when available. Lazy initializers run
  // once per mount; callers conditionally mount this modal (documentingSessionId
  // != null), so a fresh mount always reflects the current session's times.
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

  // Case notes the CHW wrote during this session — used to pre-fill the Session
  // Notes field so they can review/edit rather than retype. Only fetched while
  // the modal is open and a member is known.
  const caseNotesQuery = useCaseNotes(memberId ?? '', {
    enabled: visible && !!memberId,
  });

  // Guard: pre-fill Session Notes from case notes only once per modal-open.
  const notesPrefilledRef = useRef(false);

  // Reset the pre-fill guard each time the modal opens (for a new session).
  useEffect(() => {
    if (!visible) notesPrefilledRef.current = false;
  }, [visible]);

  // Pre-fill Session Notes with this session's case notes, once, without
  // clobbering anything the CHW has already typed.
  useEffect(() => {
    if (!visible || !sessionId || notesPrefilledRef.current) return;
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
  }, [visible, sessionId, caseNotesQuery.isLoading, caseNotesQuery.data, chwNotes]);

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
  const effectiveDurationMinutes = timesResult.durationMinutes ?? durationMinutes ?? null;

  const startError: string | null =
    sessionStartInput.length > 0 && timesResult.error === 'invalid_start'
      ? 'Enter a valid date & time (MM/DD/YYYY HH:MM).'
      : null;
  const endError: string | null =
    sessionEndInput.length > 0 && timesResult.error === 'invalid_end'
      ? 'Enter a valid date & time (MM/DD/YYYY HH:MM).'
      : timesResult.error === 'end_before_start'
      ? 'Session end must be after session start.'
      : null;

  const isValid =
    selectedDiagnosisCodes.length > 0 &&
    selectedProcedureCode.length > 0 &&
    chwNotes.trim().length > 0 &&
    timesResult.error === null;

  const toggleDiagnosisCode = useCallback((code: string): void => {
    setSelectedDiagnosisCodes((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  }, []);

  const performSubmit = useCallback(async (): Promise<void> => {
    if (!isValid || isSubmitting) return;

    setIsSubmitting(true);

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
    // API call actually succeeds. The parent is responsible for surfacing
    // its own error toast if the mutation fails — we simply re-enable the
    // button and let the modal stay open for retry.
    try {
      const maybePromise = onSubmit(documentation) as unknown;
      if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
        await maybePromise;
      }
    } catch {
      // Parent surfaces the error; we just stop the spinner and bail.
      setIsSubmitting(false);
      return;
    }

    setIsSubmitting(false);

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

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      accessible
      accessibilityViewIsModal
    >
      <View style={mo.container}>
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

        {/* ── Scrollable content ───────────────────────────────────────────── */}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={mo.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Session Start / Session End — drives Units to Bill below */}
          <SessionTimesSection
            startValue={sessionStartInput}
            endValue={sessionEndInput}
            onStartChange={setSessionStartInput}
            onEndChange={setSessionEndInput}
            startError={startError}
            endError={endError}
          />

          {/* Diagnosis codes */}
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

          {/* Units to bill — bottom of the form, immediately above Submit */}
          <UnitsSummary value={unitsToBill} durationMinutes={effectiveDurationMinutes} />
        </ScrollView>

        {/* ── Fixed footer ──────────────────────────────────────────────────── */}
        <View style={mo.footer}>
          {!isValid && (
            <Text style={mo.validationHint}>
              {selectedDiagnosisCodes.length === 0
                ? 'Select at least one diagnosis code to submit.'
                : !selectedProcedureCode
                ? 'Select a procedure code to submit.'
                : timesResult.error === 'invalid_start'
                ? 'Enter a valid session start time (MM/DD/YYYY HH:MM).'
                : timesResult.error === 'invalid_end'
                ? 'Enter a valid session end time (MM/DD/YYYY HH:MM).'
                : timesResult.error === 'end_before_start'
                ? 'Session end must be after session start.'
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
    </Modal>
  );
}

// ─── Styles (main modal shell) ────────────────────────────────────────────────

const mo = StyleSheet.create({
  container: {
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
