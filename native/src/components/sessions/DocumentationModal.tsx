/**
 * DocumentationModal — full-screen modal for documenting a completed session.
 *
 * Visual language: shared design-system tokens (theme/tokens) + ui/ primitives
 * (Card, SectionHeader, Pill). Legacy beige/cream theme/colors palette removed.
 *
 * Sections:
 *  - Diagnosis Codes (Z-Codes): expandable categories with tap-to-select codes
 *  - Procedure Code: picker from procedureCodes mock data
 *  - Units to Bill: read-only billing summary (StatTile-style 3-column layout)
 *  - Member Goals: multi-select from predefinedMemberGoals
 *  - Resources Referred: multi-select pill buttons from predefinedResources
 *  - Follow-up Needed: Yes/No toggle + date input when Yes
 *  - Session Notes: multiline TextInput (200 char limit with counter)
 *  - AI Summary: read-only card generated from transcript
 *  - Submit Documentation button
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
  Sparkles,
  RefreshCw,
  DollarSign,
} from 'lucide-react-native';
import { ResourceMentionInput } from '../resources/ResourceMentionInput';

import { colors as tokens, numerals, spacing, radius, shadows } from '../../theme/tokens';
import { typography } from '../../theme/typography';
import { Card, SectionHeader, Pill } from '../ui';
import { useGenerateAISummary, useCaseNotes } from '../../hooks/useApiQueries';
import {
  diagnosisCodes,
  procedureCodes,
  predefinedMemberGoals,
  predefinedResources,
  zCodeCategoryLabels,
  type ZCodeCategory,
  type SessionDocumentation,
  MEDI_CAL_RATE,
  NET_PAYOUT_RATE,
  formatCurrency,
} from '../../data/mock';

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
   * Total session duration in minutes. Used to auto-derive the units-to-bill
   * value the CHW sees in the modal — see ``computeUnitsFromDuration``. The
   * backend ignores any client-supplied units and recomputes from the same
   * formula, so this prop is for display only. ``null`` / undefined defaults
   * to 1 unit (the schema's minimum).
   */
  durationMinutes?: number | null;
  /** Called with the completed documentation data on submit */
  onSubmit: (data: SessionDocumentation) => void;
}

/**
 * Auto-derive the units-to-bill from a session's total duration.
 *
 * Founder-set bracket (2026-05-07) — must match the backend
 * ``app.services.billing_service.calculate_units`` exactly:
 *
 *   - ≤ 45 min  → 1 unit
 *   - 45–75 min → 2 units
 *   - 75–105 min → 3 units
 *   - > 105 min → 4 units (Medi-Cal daily cap)
 *
 * Returns 1 when the duration is missing so the schema's ``ge=1`` constraint
 * is honored and the CHW always gets credit for the visit.
 */
function computeUnitsFromDuration(durationMinutes: number | null | undefined): number {
  if (durationMinutes == null || durationMinutes <= 45) return 1;
  if (durationMinutes <= 75) return 2;
  if (durationMinutes <= 105) return 3;
  return 4;
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format an ISO8601 timestamp from the AI summary into a short time string
 * (e.g. "2:34 PM"). Falls back to the raw string if parsing fails.
 */
function formatAITimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return iso;
  }
}

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

// ─── MultiSelectList ──────────────────────────────────────────────────────────

interface MultiSelectListProps {
  title: string;
  items: string[];
  selected: string[];
  onToggle: (item: string) => void;
}

function MultiSelectList({
  title,
  items,
  selected,
  onToggle,
}: MultiSelectListProps): React.JSX.Element {
  return (
    <View style={sh.section}>
      <SectionHeader title={title} marginBottom={spacing.md} />
      <Card style={ms.listCard}>
        {items.map((item, index) => {
          const isChecked = selected.includes(item);
          const isLast = index === items.length - 1;
          return (
            <Pressable
              key={item}
              style={({ hovered }: { pressed: boolean; hovered?: boolean }) => [
                ms.item,
                !isLast && ms.itemBorder,
                isChecked && ms.itemChecked,
                hovered && !isChecked && ms.itemHovered,
              ]}
              onPress={() => onToggle(item)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: isChecked }}
              accessibilityLabel={item}
            >
              <View style={[ms.checkbox, isChecked && ms.checkboxChecked]}>
                {isChecked && <Check size={9} color="#FFFFFF" strokeWidth={3} />}
              </View>
              <Text style={[ms.itemText, isChecked && ms.itemTextChecked]}>{item}</Text>
            </Pressable>
          );
        })}
      </Card>
    </View>
  );
}

const ms = StyleSheet.create({
  listCard: {
    overflow: 'hidden',
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md - 2,
    backgroundColor: tokens.cardBg,
  },
  itemBorder: {
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
  },
  itemChecked: {
    backgroundColor: tokens.emerald100,
  },
  itemHovered: {
    backgroundColor: tokens.slate100,
  },
  checkbox: {
    width: 16,
    height: 16,
    borderRadius: radius.sm - 2,
    borderWidth: 2,
    borderColor: tokens.cardBorder,
    backgroundColor: tokens.cardBg,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  checkboxChecked: {
    borderColor: tokens.primary,
    backgroundColor: tokens.primary,
  },
  itemText: {
    flex: 1,
    ...typography.bodySm,
    color: tokens.textPrimary,
  },
  itemTextChecked: {
    color: tokens.emerald700,
    fontWeight: '600',
  },
});

// ─── ResourcePills ────────────────────────────────────────────────────────────

interface ResourcePillsProps {
  selected: string[];
  onToggle: (resource: string) => void;
}

function ResourcePills({ selected, onToggle }: ResourcePillsProps): React.JSX.Element {
  return (
    <View style={sh.section}>
      <SectionHeader title="Resources Referred" marginBottom={spacing.md} />
      <View style={rp.pillContainer}>
        {predefinedResources.map((resource) => {
          const isSelected = selected.includes(resource);
          return (
            <TouchableOpacity
              key={resource}
              style={[rp.pill, isSelected && rp.pillSelected]}
              onPress={() => onToggle(resource)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: isSelected }}
              accessibilityLabel={resource}
              activeOpacity={0.7}
            >
              {isSelected && <Check size={10} color={tokens.emerald700} strokeWidth={3} />}
              <Text style={[rp.pillText, isSelected && rp.pillTextSelected]}>
                {resource}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const rp = StyleSheet.create({
  pillContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    backgroundColor: tokens.cardBg,
  },
  pillSelected: {
    borderColor: tokens.primary,
    backgroundColor: tokens.emerald100,
  },
  pillText: {
    ...typography.label,
    letterSpacing: 0.2,
    color: tokens.textSecondary,
  },
  pillTextSelected: {
    color: tokens.emerald700,
    fontWeight: '600',
  },
});

// ─── FollowUpSection ──────────────────────────────────────────────────────────

interface FollowUpSectionProps {
  followUpNeeded: boolean | null;
  followUpDate: string;
  onToggle: (value: boolean) => void;
  onDateChange: (date: string) => void;
}

function FollowUpSection({
  followUpNeeded,
  followUpDate,
  onToggle,
  onDateChange,
}: FollowUpSectionProps): React.JSX.Element {
  return (
    <View style={sh.section}>
      <SectionHeader title="Follow-Up Needed?" marginBottom={spacing.md} />

      <View style={fu.toggleRow}>
        <Pressable
          style={({ pressed }: { pressed?: boolean }) => [
            fu.toggleButton,
            followUpNeeded === true && fu.toggleButtonYes,
            pressed && fu.toggleButtonPressed,
          ]}
          onPress={() => onToggle(true)}
          accessibilityRole="radio"
          accessibilityState={{ checked: followUpNeeded === true }}
          accessibilityLabel="Follow-up needed: Yes"
        >
          <Text
            style={[
              fu.toggleButtonText,
              followUpNeeded === true && fu.toggleButtonTextActive,
            ]}
          >
            Yes
          </Text>
        </Pressable>

        <Pressable
          style={({ pressed }: { pressed?: boolean }) => [
            fu.toggleButton,
            followUpNeeded === false && fu.toggleButtonNo,
            pressed && fu.toggleButtonPressed,
          ]}
          onPress={() => onToggle(false)}
          accessibilityRole="radio"
          accessibilityState={{ checked: followUpNeeded === false }}
          accessibilityLabel="Follow-up needed: No"
        >
          <Text
            style={[
              fu.toggleButtonText,
              followUpNeeded === false && fu.toggleButtonTextActive,
            ]}
          >
            No
          </Text>
        </Pressable>
      </View>

      {followUpNeeded === true && (
        <Card style={fu.dateCard}>
          <Text style={fu.dateLabel}>Follow-up date</Text>
          <TextInput
            style={fu.dateInput}
            value={followUpDate}
            onChangeText={onDateChange}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={tokens.textMuted}
            keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default'}
            accessibilityLabel="Follow-up date"
          />
        </Card>
      )}
    </View>
  );
}

const fu = StyleSheet.create({
  toggleRow: {
    flexDirection: 'row',
    gap: spacing.sm + 2,
    marginBottom: spacing.md,
  },
  toggleButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    backgroundColor: tokens.cardBg,
  },
  toggleButtonYes: {
    backgroundColor: tokens.primary,
    borderColor: tokens.primary,
  },
  toggleButtonNo: {
    backgroundColor: tokens.textSecondary,
    borderColor: tokens.textSecondary,
  },
  toggleButtonPressed: {
    opacity: 0.75,
  },
  toggleButtonText: {
    ...typography.bodySm,
    fontWeight: '600',
    color: tokens.textSecondary,
  },
  toggleButtonTextActive: {
    color: '#FFFFFF',
  },
  dateCard: {
    padding: spacing.lg,
    gap: spacing.sm,
  },
  dateLabel: {
    ...typography.label,
    letterSpacing: 0.3,
    color: tokens.textSecondary,
  },
  dateInput: {
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    borderRadius: radius.lg,
    backgroundColor: tokens.pageBg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    ...typography.bodyMd,
    color: tokens.textPrimary,
  },
});

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * Full-screen modal for documenting a completed CHW session.
 *
 * The notes area is split into two distinct sections:
 *  1. "Your Notes" — CHW-authored, editable, required for submit.
 *  2. "AI Summary" — read-only card generated from session transcript.
 *
 * Validates that at least one diagnosis code is selected and CHW notes are
 * non-empty before allowing submit.
 */
export function DocumentationModal({
  visible,
  onClose,
  sessionId,
  memberId,
  durationMinutes,
  onSubmit,
}: DocumentationModalProps): React.JSX.Element {
  const [selectedDiagnosisCodes, setSelectedDiagnosisCodes] = useState<string[]>([]);
  const [selectedProcedureCode, setSelectedProcedureCode] = useState<string>(
    procedureCodes[0]?.code ?? '',
  );
  // Units are derived authoritatively from the session duration — no manual
  // override. The backend recomputes from the same formula and ignores any
  // client-supplied value (see app/services/billing_service.calculate_units).
  const unitsToBill = computeUnitsFromDuration(durationMinutes);
  const [selectedGoals, setSelectedGoals] = useState<string[]>([]);
  const [selectedResources, setSelectedResources] = useState<string[]>([]);
  const [followUpNeeded, setFollowUpNeeded] = useState<boolean | null>(null);
  const [followUpDate, setFollowUpDate] = useState('');
  // Number of Medi-Cal members served (1 = individual). String for the input.
  const [membersServedStr, setMembersServedStr] = useState('1');
  // CHW-authored notes — required, separate from AI summary.
  const [chwNotes, setChwNotes] = useState('');
  // AI summary state — fetched once on modal open, regeneratable via button.
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiGeneratedAt, setAiGeneratedAt] = useState<string | null>(null);
  const [aiExcluded, setAiExcluded] = useState(false);
  /**
   * Tracks a network/server error from the AI summary endpoint.
   * Distinct from ``aiSummary === null``, which means the endpoint succeeded
   * but returned an empty/unavailable summary (e.g. no transcript).
   * When true, the UI shows "Could not generate summary" + Retry button.
   */
  const [aiError, setAiError] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Tracks whether the notes TextInput is focused, for focus-ring styling.
  const [notesFocused, setNotesFocused] = useState(false);

  const generateAISummary = useGenerateAISummary();

  // Case notes the CHW wrote during this session — used to pre-fill the Session
  // Notes field so they can review/edit rather than retype. Only fetched while
  // the modal is open and a member is known.
  const caseNotesQuery = useCaseNotes(memberId ?? '', {
    enabled: visible && !!memberId,
  });

  // Guard: auto-fetch only once per modal-open, not on remount.
  const hasFetchedRef = useRef(false);
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

  // ── Auto-generate AI summary on modal open ──────────────────────────────
  // Called once when modal becomes visible. The "Regenerate" button is the
  // only way to refetch afterward. Does NOT pre-fill the CHW notes field —
  // the two are now separate fields per spec.
  useEffect(() => {
    if (!visible || !sessionId) return;
    if (hasFetchedRef.current) return;
    hasFetchedRef.current = true;

    generateAISummary.mutate(sessionId, {
      onSuccess: (result) => {
        setAiError(false);
        const text = (result.ai_summary ?? '').trim();
        const ts = result.generated_at ?? null;
        // Hide section when summary is empty or timestamp is null.
        if (text.length > 0 && ts !== null) {
          setAiSummary(text);
          setAiGeneratedAt(ts);
        } else {
          setAiSummary(null);
          setAiGeneratedAt(null);
        }
      },
      onError: () => {
        // Network or server error — surface a retryable error card.
        setAiError(true);
        setAiSummary(null);
        setAiGeneratedAt(null);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sessionId]);

  // Reset all form state and the fetch guard when modal closes.
  useEffect(() => {
    if (!visible) {
      hasFetchedRef.current = false;
      setChwNotes('');
      setAiSummary(null);
      setAiGeneratedAt(null);
      setAiExcluded(false);
      setAiError(false);
      setSelectedDiagnosisCodes([]);
      setSelectedProcedureCode(procedureCodes[0]?.code ?? '');
      // unitsToBill is derived from durationMinutes prop — no reset needed.
      setSelectedGoals([]);
      setSelectedResources([]);
      setFollowUpNeeded(null);
      setFollowUpDate('');
    }
  }, [visible]);

  /**
   * Regenerate the AI summary from the transcript.
   * Called only when the CHW taps the "Regenerate" button.
   */
  const handleRegenerateAISummary = useCallback((): void => {
    setAiError(false);
    generateAISummary.mutate(sessionId, {
      onSuccess: (result) => {
        setAiError(false);
        const text = (result.ai_summary ?? '').trim();
        const ts = result.generated_at ?? null;
        if (text.length > 0 && ts !== null) {
          setAiSummary(text);
          setAiGeneratedAt(ts);
          setAiExcluded(false);
        } else {
          setAiSummary(null);
          setAiGeneratedAt(null);
        }
      },
      onError: () => {
        setAiError(true);
        setAiSummary(null);
        setAiGeneratedAt(null);
      },
    });
  }, [generateAISummary, sessionId]);

  const isAiLoading = generateAISummary.isPending;

  // Summary is displayable when non-null and non-empty AND not loading.
  const hasDisplayableAiSummary =
    !isAiLoading && aiSummary !== null && aiSummary.trim().length > 0 && aiGeneratedAt !== null;

  const isValid =
    selectedDiagnosisCodes.length > 0 &&
    selectedProcedureCode.length > 0 &&
    chwNotes.trim().length > 0;

  const toggleDiagnosisCode = useCallback((code: string): void => {
    setSelectedDiagnosisCodes((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  }, []);

  const toggleGoal = useCallback((goal: string): void => {
    setSelectedGoals((prev) =>
      prev.includes(goal) ? prev.filter((g) => g !== goal) : [...prev, goal],
    );
  }, []);

  const toggleResource = useCallback((resource: string): void => {
    setSelectedResources((prev) =>
      prev.includes(resource) ? prev.filter((r) => r !== resource) : [...prev, resource],
    );
  }, []);

  const performSubmit = useCallback(async (): Promise<void> => {
    if (!isValid || isSubmitting) return;

    setIsSubmitting(true);

    const documentation: SessionDocumentation = {
      sessionId,
      // CHW-authored notes field — always the canonical `summary` key per backend contract.
      summary: chwNotes,
      resourcesReferred: selectedResources,
      memberGoals: selectedGoals,
      followUpNeeded: followUpNeeded === true,
      followUpDate: followUpNeeded === true ? followUpDate : undefined,
      diagnosisCodes: selectedDiagnosisCodes,
      procedureCode: selectedProcedureCode,
      unitsToBill,
      membersServed: Math.max(1, parseInt(membersServedStr, 10) || 1),
      submittedAt: new Date().toISOString(),
      // AI summary fields — included when a summary was generated.
      aiSummary: aiSummary ?? null,
      aiSummaryGeneratedAt: aiGeneratedAt ?? null,
      aiSummaryExcluded: aiExcluded,
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

    // RN's Alert.alert() is a no-op for multi-button dialogs on web; use
    // window.alert() so the CHW gets visible confirmation on the web build.
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined') {
        window.alert(`Documentation Submitted\n\nClaim filed for ${unitsToBill} unit(s).`);
      }
      onClose();
      return;
    }
    Alert.alert(
      'Documentation Submitted',
      `Claim filed for ${unitsToBill} unit(s).`,
      [{ text: 'Done', onPress: onClose }],
    );
  }, [
    isValid,
    isSubmitting,
    sessionId,
    chwNotes,
    selectedResources,
    selectedGoals,
    followUpNeeded,
    followUpDate,
    selectedDiagnosisCodes,
    selectedProcedureCode,
    unitsToBill,
    aiSummary,
    aiGeneratedAt,
    aiExcluded,
    onSubmit,
    onClose,
  ]);

  /**
   * Two-stage submit: tap once → confirmation alert showing the dollar
   * amount about to be billed → tap "Submit Claim" → real submit fires.
   * Cheap claim-preview gate so a CHW can't accidentally one-tap a claim
   * without seeing the gross/net breakdown. Replaces silent auto-submission.
   */
  const handleSubmit = useCallback((): void => {
    if (!isValid || isSubmitting) return;

    const gross = unitsToBill * 26.66; // Medi-Cal T1016 rate per 15-min unit
    const platformFee = gross * 0.15;
    const rewardsPool = gross * 0.25;
    const chwNet = gross * 0.6;
    const procedureLabel = selectedProcedureCode || 'CPT/HCPCS';
    const diagCount = selectedDiagnosisCodes.length;

    const previewBody =
      `${unitsToBill} unit(s) of ${procedureLabel}\n` +
      `Diagnoses: ${diagCount} code${diagCount === 1 ? '' : 's'}\n\n` +
      `Gross:        $${gross.toFixed(2)}\n` +
      `Platform fee: -$${platformFee.toFixed(2)}\n` +
      `Rewards pool: -$${rewardsPool.toFixed(2)}\n` +
      `Your payout:  $${chwNet.toFixed(2)}\n\n` +
      `This will file the claim with PearSuite. Continue?`;

    // RN's Alert.alert() with a multi-button [Edit / Submit Claim] callback
    // shape is a no-op on web — the dialog never renders and `onPress` never
    // fires, so the CHW taps Submit and nothing visibly happens. Bridge to
    // window.confirm() on web; native keeps the styled Alert.
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined') return;
      const confirmed = window.confirm(`Review claim before submitting\n\n${previewBody}`);
      if (confirmed) {
        void performSubmit();
      }
      return;
    }

    Alert.alert(
      'Review claim before submitting',
      previewBody,
      [
        { text: 'Edit', style: 'cancel' },
        {
          text: 'Submit Claim',
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
    unitsToBill,
    selectedProcedureCode,
    selectedDiagnosisCodes,
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

          {/* Units to bill */}
          <UnitsSummary value={unitsToBill} durationMinutes={durationMinutes} />

          {/* Members served (Medi-Cal) */}
          <View style={mo.membersServedSection}>
            <SectionHeader title="Members Served" marginBottom={spacing.sm} />
            <TextInput
              style={mo.membersServedInput}
              value={membersServedStr}
              onChangeText={(t) => setMembersServedStr(t.replace(/[^0-9]/g, ''))}
              keyboardType="number-pad"
              placeholder="1"
              maxLength={2}
              accessibilityLabel="Number of Medi-Cal members served in this session"
            />
            <Text style={mo.membersServedHint}>
              Number of Medi-Cal members served (1 for an individual session).
            </Text>
          </View>

          {/* Member goals */}
          <MultiSelectList
            title="Member Goals Discussed"
            items={predefinedMemberGoals}
            selected={selectedGoals}
            onToggle={toggleGoal}
          />

          {/* Resources referred */}
          <ResourcePills selected={selectedResources} onToggle={toggleResource} />

          {/* Follow-up */}
          <FollowUpSection
            followUpNeeded={followUpNeeded}
            followUpDate={followUpDate}
            onToggle={setFollowUpNeeded}
            onDateChange={setFollowUpDate}
          />

          {/* ── A) CHW Notes — authored, required ──────────────────────────── */}
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

          {/* ── B) AI Summary — read-only card ─────────────────────────────── */}
          <View style={sh.section}>
            <SectionHeader title="AI Summary" marginBottom={spacing.md} />

            {isAiLoading ? (
              /* Loading skeleton */
              <Card
                style={ai.card}
                accessible
                accessibilityLabel="Generating AI summary"
              >
                <View style={ai.headerRow}>
                  <Sparkles size={14} color={tokens.cyan600} />
                  <Text style={ai.headerText}>Generating summary from session transcript…</Text>
                </View>
                <View style={ai.shimmerLine} />
                <View style={[ai.shimmerLine, ai.shimmerLineMid]} />
                <View style={[ai.shimmerLine, ai.shimmerLineShort]} />
              </Card>
            ) : aiError ? (
              /* Error state — retryable */
              <Card
                style={ai.errorCard}
                accessible
                accessibilityLabel="AI summary error"
              >
                <View style={ai.errorRow}>
                  <Sparkles size={14} color={tokens.red700} />
                  <Text style={ai.errorText}>Could not generate summary</Text>
                </View>
                <TouchableOpacity
                  style={ai.retryButton}
                  onPress={handleRegenerateAISummary}
                  accessibilityRole="button"
                  accessibilityLabel="Retry generating AI summary"
                >
                  <RefreshCw size={12} color={tokens.red700} />
                  <Text style={ai.retryText}>Retry</Text>
                </TouchableOpacity>
              </Card>
            ) : hasDisplayableAiSummary ? (
              /* Populated AI card */
              <Card
                style={[ai.card, aiExcluded && ai.cardExcluded]}
                accessible
                accessibilityLabel="AI-generated summary, read only"
                accessibilityHint="This summary was generated from the session transcript and is not editable"
              >
                {/* Header row */}
                <View style={ai.headerRow}>
                  <Sparkles size={14} color={aiExcluded ? tokens.textMuted : tokens.cyan600} />
                  <Text style={[ai.headerText, aiExcluded && ai.headerTextDimmed]}>
                    AI Summary
                  </Text>
                  <Pill variant="blue" size="sm">Generated from transcript</Pill>
                  <Text style={ai.timestamp}>
                    {formatAITimestamp(aiGeneratedAt!)}
                  </Text>
                </View>

                {/* Body — read-only, italic styling */}
                <Text
                  style={[ai.bodyText, aiExcluded && ai.bodyTextExcluded]}
                  selectable
                >
                  {aiSummary}
                </Text>

                {/* Footer row */}
                <View style={ai.footer}>
                  <TouchableOpacity
                    style={ai.regenerateButton}
                    onPress={handleRegenerateAISummary}
                    disabled={isAiLoading}
                    accessibilityRole="button"
                    accessibilityLabel="Regenerate AI summary from transcript"
                    accessibilityState={{ disabled: isAiLoading }}
                  >
                    <RefreshCw size={12} color={tokens.cyan600} />
                    <Text style={ai.regenerateText}>Regenerate</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={ai.excludeRow}
                    onPress={() => setAiExcluded((prev) => !prev)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: aiExcluded }}
                    accessibilityLabel="Don't include AI summary in documentation"
                    activeOpacity={0.7}
                  >
                    <View style={[ai.excludeCheckbox, aiExcluded && ai.excludeCheckboxChecked]}>
                      {aiExcluded && <Check size={9} color="#FFFFFF" strokeWidth={3} />}
                    </View>
                    <Text style={[ai.excludeLabel, aiExcluded && ai.excludeLabelChecked]}>
                      Don&apos;t include in documentation
                    </Text>
                  </TouchableOpacity>
                </View>
              </Card>
            ) : (
              /* Unavailable state */
              <Card style={ai.unavailableCard}>
                <Text style={ai.unavailableText}>
                  AI summary unavailable — transcript was too short or audio capture failed.
                </Text>
              </Card>
            )}
          </View>
        </ScrollView>

        {/* ── Fixed footer ──────────────────────────────────────────────────── */}
        <View style={mo.footer}>
          {!isValid && (
            <Text style={mo.validationHint}>
              {selectedDiagnosisCodes.length === 0
                ? 'Select at least one diagnosis code to submit.'
                : !selectedProcedureCode
                ? 'Select a procedure code to submit.'
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
  membersServedSection: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
  },
  membersServedInput: {
    width: 96,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    borderRadius: radius.md,
    ...typography.bodyMd,
    color: tokens.textPrimary,
    backgroundColor: tokens.cardBg,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' as unknown as undefined } : {}),
  },
  membersServedHint: {
    ...typography.bodySm,
    color: tokens.textSecondary,
    marginTop: spacing.xs,
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

// ─── Styles (AI Summary card) ─────────────────────────────────────────────────

const ai = StyleSheet.create({
  card: {
    padding: spacing.lg,
    gap: spacing.sm + 2,
    backgroundColor: tokens.blue100,
    borderColor: '#bfdbfe', // blue-200 — matches the blue100 card tint
  },
  cardExcluded: {
    opacity: 0.55,
    backgroundColor: tokens.slate100,
    borderColor: tokens.cardBorder,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm - 2,
  },
  headerText: {
    fontSize: 12,
    fontWeight: '700',
    color: tokens.cyan700,
    letterSpacing: 0.4,
  },
  headerTextDimmed: {
    color: tokens.textMuted,
  },
  timestamp: {
    fontSize: 11,
    color: tokens.textMuted,
    marginLeft: 'auto' as unknown as number,
  },
  bodyText: {
    ...typography.bodySm,
    fontStyle: 'italic',
    color: tokens.textPrimary,
    lineHeight: 22,
    letterSpacing: 0.1,
  },
  bodyTextExcluded: {
    textDecorationLine: 'line-through',
    color: tokens.textMuted,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: '#bfdbfe',
  },
  regenerateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: tokens.cyan600 + '60',
    backgroundColor: tokens.cyan100,
  },
  regenerateText: {
    fontSize: 12,
    fontWeight: '600',
    color: tokens.cyan600,
  },
  excludeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  excludeCheckbox: {
    width: 16,
    height: 16,
    borderRadius: radius.sm - 2,
    borderWidth: 2,
    borderColor: tokens.cardBorder,
    backgroundColor: tokens.cardBg,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  excludeCheckboxChecked: {
    borderColor: tokens.textSecondary,
    backgroundColor: tokens.textSecondary,
  },
  excludeLabel: {
    fontSize: 12,
    color: tokens.textMuted,
  },
  excludeLabelChecked: {
    color: tokens.textPrimary,
    fontWeight: '600',
  },
  shimmerLine: {
    height: 10,
    borderRadius: radius.sm - 1,
    backgroundColor: '#bfdbfe',
    width: '100%',
  },
  shimmerLineMid: {
    width: '80%',
  },
  shimmerLineShort: {
    width: '55%',
  },
  unavailableCard: {
    padding: spacing.lg,
  },
  unavailableText: {
    ...typography.bodySm,
    color: tokens.textMuted,
    fontStyle: 'italic',
  },
  errorCard: {
    padding: spacing.lg,
    gap: spacing.sm,
    backgroundColor: tokens.red100,
    borderColor: tokens.red700 + '40',
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm - 2,
  },
  errorText: {
    ...typography.bodySm,
    fontWeight: '600',
    color: tokens.red700,
  },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    alignSelf: 'flex-start' as const,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: tokens.red700 + '60',
    backgroundColor: tokens.cardBg,
  },
  retryText: {
    fontSize: 12,
    fontWeight: '600',
    color: tokens.red700,
  },
});
