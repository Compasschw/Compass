/**
 * DocumentationModal — full-screen modal for documenting a completed session.
 *
 * Sections:
 *  - Diagnosis Codes (Z-Codes): expandable categories with tap-to-select codes
 *  - Procedure Code: picker from procedureCodes mock data
 *  - Units to Bill: number stepper (+/- buttons) with billing estimate
 *  - Member Goals: multi-select from predefinedMemberGoals
 *  - Resources Referred: multi-select pill buttons from predefinedResources
 *  - Follow-up Needed: Yes/No toggle + date input when Yes
 *  - Session Notes: multiline TextInput (200 char limit with counter)
 *  - Submit Documentation button
 */

import React, { useState, useMemo, useCallback } from 'react';
import {
  Alert,
  Modal,
  Platform,
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
  Plus,
  Minus,
  FileText,
} from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
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

const NOTES_MAX = 200;

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
    <View style={ds.section}>
      <Text style={ds.sectionTitle}>Diagnosis Codes (Z-Codes)</Text>

      {Z_CODE_CATEGORIES.map((category) => {
        const codes = codesByCategory.get(category) ?? [];
        const isExpanded = expandedCategories.has(category);
        const selectedInCategory = codes.filter((c) => selectedCodes.includes(c.code)).length;

        return (
          <View key={category} style={ds.categoryCard}>
            <TouchableOpacity
              style={ds.categoryHeader}
              onPress={() => toggleCategory(category)}
              accessibilityRole="button"
              accessibilityState={{ expanded: isExpanded }}
              accessibilityLabel={`${zCodeCategoryLabels[category]}${selectedInCategory > 0 ? `, ${selectedInCategory} selected` : ''}`}
              activeOpacity={0.7}
            >
              <Text style={ds.categoryLabel}>{zCodeCategoryLabels[category]}</Text>
              <View style={ds.categoryRightRow}>
                {selectedInCategory > 0 && (
                  <View style={ds.categoryBadge}>
                    <Text style={ds.categoryBadgeText}>{selectedInCategory}</Text>
                  </View>
                )}
                {isExpanded ? (
                  <ChevronDown size={16} color={colors.mutedForeground} />
                ) : (
                  <ChevronRight size={16} color={colors.mutedForeground} />
                )}
              </View>
            </TouchableOpacity>

            {isExpanded && (
              <View style={ds.codeList}>
                {codes.map((code) => {
                  const isSelected = selectedCodes.includes(code.code);
                  return (
                    <TouchableOpacity
                      key={code.code}
                      style={[ds.codeRow, isSelected && ds.codeRowSelected]}
                      onPress={() => onToggle(code.code)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: isSelected }}
                      accessibilityLabel={`${code.code}: ${code.description}`}
                      activeOpacity={0.7}
                    >
                      <View style={[ds.codeCheckbox, isSelected && ds.codeCheckboxChecked]}>
                        {isSelected && <Check size={9} color="#FFFFFF" strokeWidth={3} />}
                      </View>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={[ds.codeText, isSelected && ds.codeTextSelected]}>
                          {code.code}
                        </Text>
                        <Text style={ds.codeDesc}>{code.description}</Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

const ds = StyleSheet.create({
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    ...typography.label,
    fontWeight: '700',
    color: colors.foreground,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 10,
  },
  categoryCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    marginBottom: 6,
    overflow: 'hidden',
  },
  categoryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.card,
  },
  categoryLabel: {
    ...typography.bodySm,
    fontWeight: '600',
    color: colors.foreground,
    flex: 1,
  },
  categoryRightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  categoryBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.primary,
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
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  codeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  codeRowSelected: {
    backgroundColor: colors.primary + '06',
  },
  codeCheckbox: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
    flexShrink: 0,
  },
  codeCheckboxChecked: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  codeText: {
    ...typography.bodySm,
    fontWeight: '700',
    color: colors.foreground,
  },
  codeTextSelected: {
    color: colors.primary,
  },
  codeDesc: {
    ...typography.label,
    color: colors.mutedForeground,
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
    <View style={ds.section}>
      <Text style={ds.sectionTitle}>
        Procedure and Modifiers <Text style={{ color: colors.destructive }}>*</Text>
      </Text>

      <TouchableOpacity
        style={p.trigger}
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
        <Text style={[p.triggerText, !selected && p.triggerPlaceholder]} numberOfLines={1}>
          {selected
            ? `${selected.code} ${selected.modifier} — ${selected.description} (${selected.groupSize})`
            : 'Select procedure code'}
        </Text>
        <ChevronDown size={16} color={colors.mutedForeground} />
      </TouchableOpacity>

      {open && (
        <View style={p.dropdown}>
          {procedureCodes.map((pc) => {
            const isSelected = value === pc.code;
            return (
              <TouchableOpacity
                key={pc.code}
                style={[p.option, isSelected && p.optionSelected]}
                onPress={() => {
                  onChange(pc.code);
                  setOpen(false);
                }}
                accessibilityRole="menuitem"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={`${pc.code} ${pc.modifier} — ${pc.description}`}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[p.optionCode, isSelected && p.optionCodeSelected]}>
                    {pc.code} {pc.modifier}
                  </Text>
                  <Text style={p.optionDesc}>
                    {pc.description} · {pc.groupSize}
                  </Text>
                </View>
                {isSelected && <Check size={14} color={colors.primary} />}
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      <Text style={p.hint}>
        Select service type based on number of people served in this session.
      </Text>
    </View>
  );
}

const p = StyleSheet.create({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: colors.card,
  },
  triggerText: {
    ...typography.bodyMd,
    color: colors.foreground,
    flex: 1,
    marginRight: 8,
  },
  triggerPlaceholder: {
    color: colors.mutedForeground,
  },
  dropdown: {
    marginTop: 4,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  optionSelected: {
    backgroundColor: colors.primary + '08',
  },
  optionCode: {
    ...typography.bodySm,
    fontWeight: '700',
    color: colors.foreground,
  },
  optionCodeSelected: {
    color: colors.primary,
  },
  optionDesc: {
    ...typography.label,
    color: colors.mutedForeground,
    marginTop: 1,
  },
  hint: {
    ...typography.label,
    color: colors.mutedForeground,
    marginTop: 6,
    lineHeight: 16,
  },
});

// ─── UnitsStepper ─────────────────────────────────────────────────────────────

interface UnitsStepperProps {
  value: number;
  onChange: (units: number) => void;
}

function UnitsStepper({ value, onChange }: UnitsStepperProps): React.JSX.Element {
  const grossAmount = value * MEDI_CAL_RATE;
  const netAmount = grossAmount * NET_PAYOUT_RATE;

  function decrement(): void {
    if (value > 1) onChange(value - 1);
  }

  function increment(): void {
    if (value < 16) onChange(value + 1);
  }

  return (
    <View style={ds.section}>
      <Text style={ds.sectionTitle}>Units to Bill</Text>

      <View style={u.row}>
        <TouchableOpacity
          style={[u.stepperButton, value <= 1 && u.stepperButtonDisabled]}
          onPress={decrement}
          disabled={value <= 1}
          accessibilityRole="button"
          accessibilityLabel="Decrease units"
          accessibilityState={{ disabled: value <= 1 }}
        >
          <Minus size={16} color={value <= 1 ? colors.border : colors.foreground} />
        </TouchableOpacity>

        <View style={u.valueDisplay}>
          <Text style={u.valueText}>{value}</Text>
          <Text style={u.valueLabel}>units</Text>
        </View>

        <TouchableOpacity
          style={[u.stepperButton, value >= 16 && u.stepperButtonDisabled]}
          onPress={increment}
          disabled={value >= 16}
          accessibilityRole="button"
          accessibilityLabel="Increase units"
          accessibilityState={{ disabled: value >= 16 }}
        >
          <Plus size={16} color={value >= 16 ? colors.border : colors.foreground} />
        </TouchableOpacity>
      </View>

      <View style={u.billingRow}>
        <View style={u.billingItem}>
          <Text style={u.billingKey}>Gross</Text>
          <Text style={u.billingValue}>{formatCurrency(grossAmount)}</Text>
        </View>
        <View style={u.billingDivider} />
        <View style={u.billingItem}>
          <Text style={u.billingKey}>Net (85%)</Text>
          <Text style={[u.billingValue, { color: colors.primary }]}>{formatCurrency(netAmount)}</Text>
        </View>
        <View style={u.billingDivider} />
        <View style={u.billingItem}>
          <Text style={u.billingKey}>Rate</Text>
          <Text style={u.billingValue}>{formatCurrency(MEDI_CAL_RATE)}/unit</Text>
        </View>
      </View>
    </View>
  );
}

const u = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
    marginBottom: 12,
  },
  stepperButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperButtonDisabled: {
    opacity: 0.4,
  },
  valueDisplay: {
    alignItems: 'center',
    minWidth: 64,
  },
  valueText: {
    ...typography.displaySm,
    color: colors.foreground,
    fontWeight: '700',
  },
  valueLabel: {
    ...typography.label,
    color: colors.mutedForeground,
    marginTop: 2,
  },
  billingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 12,
    backgroundColor: colors.background,
    gap: 0,
  },
  billingItem: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  billingDivider: {
    width: 1,
    height: 28,
    backgroundColor: colors.border,
  },
  billingKey: {
    ...typography.label,
    color: colors.mutedForeground,
  },
  billingValue: {
    ...typography.bodySm,
    fontWeight: '700',
    color: colors.foreground,
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
    <View style={ds.section}>
      <Text style={ds.sectionTitle}>{title}</Text>
      <View style={ml.list}>
        {items.map((item) => {
          const isChecked = selected.includes(item);
          return (
            <TouchableOpacity
              key={item}
              style={[ml.item, isChecked && ml.itemChecked]}
              onPress={() => onToggle(item)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: isChecked }}
              accessibilityLabel={item}
              activeOpacity={0.7}
            >
              <View style={[ml.checkbox, isChecked && ml.checkboxChecked]}>
                {isChecked && <Check size={9} color="#FFFFFF" strokeWidth={3} />}
              </View>
              <Text style={[ml.itemText, isChecked && ml.itemTextChecked]}>{item}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const ml = StyleSheet.create({
  list: {
    gap: 6,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.card,
  },
  itemChecked: {
    borderColor: colors.primary,
    backgroundColor: colors.primary + '06',
  },
  checkbox: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  checkboxChecked: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  itemText: {
    flex: 1,
    ...typography.bodySm,
    color: colors.foreground,
  },
  itemTextChecked: {
    color: colors.primary,
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
    <View style={ds.section}>
      <Text style={ds.sectionTitle}>Resources Referred</Text>
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
              {isSelected && <Check size={10} color={colors.primary} strokeWidth={3} />}
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
    gap: 8,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  pillSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primary + '14',
  },
  pillText: {
    ...typography.label,
    color: colors.mutedForeground,
  },
  pillTextSelected: {
    color: colors.primary,
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
    <View style={ds.section}>
      <Text style={ds.sectionTitle}>Follow-Up Needed?</Text>

      <View style={fu.toggleRow}>
        <TouchableOpacity
          style={[fu.toggleButton, followUpNeeded === true && fu.toggleButtonYes]}
          onPress={() => onToggle(true)}
          accessibilityRole="radio"
          accessibilityState={{ checked: followUpNeeded === true }}
          accessibilityLabel="Follow-up needed: Yes"
          activeOpacity={0.7}
        >
          <Text
            style={[
              fu.toggleButtonText,
              followUpNeeded === true && fu.toggleButtonTextActive,
            ]}
          >
            Yes
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[fu.toggleButton, followUpNeeded === false && fu.toggleButtonNo]}
          onPress={() => onToggle(false)}
          accessibilityRole="radio"
          accessibilityState={{ checked: followUpNeeded === false }}
          accessibilityLabel="Follow-up needed: No"
          activeOpacity={0.7}
        >
          <Text
            style={[
              fu.toggleButtonText,
              followUpNeeded === false && fu.toggleButtonTextNo,
            ]}
          >
            No
          </Text>
        </TouchableOpacity>
      </View>

      {followUpNeeded === true && (
        <View style={fu.dateGroup}>
          <Text style={fu.dateLabel}>Follow-up date</Text>
          <TextInput
            style={fu.dateInput}
            value={followUpDate}
            onChangeText={onDateChange}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.mutedForeground}
            keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default'}
            accessibilityLabel="Follow-up date"
          />
        </View>
      )}
    </View>
  );
}

const fu = StyleSheet.create({
  toggleRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  toggleButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  toggleButtonYes: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  toggleButtonNo: {
    backgroundColor: colors.mutedForeground,
    borderColor: colors.mutedForeground,
  },
  toggleButtonText: {
    ...typography.bodySm,
    fontWeight: '600',
    color: colors.mutedForeground,
  },
  toggleButtonTextActive: {
    color: '#FFFFFF',
  },
  toggleButtonTextNo: {
    color: '#FFFFFF',
  },
  dateGroup: {
    gap: 6,
  },
  dateLabel: {
    ...typography.label,
    color: colors.mutedForeground,
  },
  dateInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.card,
    paddingHorizontal: 14,
    paddingVertical: 14,
    ...typography.bodyMd,
    color: colors.foreground,
  },
});

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * Full-screen modal for documenting a completed CHW session.
 * Validates that at least one diagnosis code is selected before submit.
 */
export function DocumentationModal({
  visible,
  onClose,
  sessionId,
  onSubmit,
}: DocumentationModalProps): React.JSX.Element {
  const [selectedDiagnosisCodes, setSelectedDiagnosisCodes] = useState<string[]>([]);
  const [selectedProcedureCode, setSelectedProcedureCode] = useState<string>(
    procedureCodes[0]?.code ?? '',
  );
  const [unitsToBill, setUnitsToBill] = useState(2);
  const [selectedGoals, setSelectedGoals] = useState<string[]>([]);
  const [selectedResources, setSelectedResources] = useState<string[]>([]);
  const [followUpNeeded, setFollowUpNeeded] = useState<boolean | null>(null);
  const [followUpDate, setFollowUpDate] = useState('');
  const [sessionNotes, setSessionNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isValid = selectedDiagnosisCodes.length > 0 && selectedProcedureCode.length > 0;

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

  const handleSubmit = useCallback(async (): Promise<void> => {
    if (!isValid || isSubmitting) return;

    setIsSubmitting(true);

    // Simulate async submission
    await new Promise<void>((resolve) => setTimeout(resolve, 600));

    const documentation: SessionDocumentation = {
      sessionId,
      summary: sessionNotes,
      resourcesReferred: selectedResources,
      memberGoals: selectedGoals,
      followUpNeeded: followUpNeeded === true,
      followUpDate: followUpNeeded === true ? followUpDate : undefined,
      diagnosisCodes: selectedDiagnosisCodes,
      procedureCode: selectedProcedureCode,
      unitsToBill,
      submittedAt: new Date().toISOString(),
    };

    setIsSubmitting(false);
    onSubmit(documentation);

    Alert.alert(
      'Documentation Submitted',
      `Session documented successfully. ${unitsToBill} unit(s) submitted for billing.`,
      [{ text: 'Done', onPress: onClose }],
    );
  }, [
    isValid,
    isSubmitting,
    sessionId,
    sessionNotes,
    selectedResources,
    selectedGoals,
    followUpNeeded,
    followUpDate,
    selectedDiagnosisCodes,
    selectedProcedureCode,
    unitsToBill,
    onSubmit,
    onClose,
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
      <View style={m.container}>
        {/* Header */}
        <View style={m.header}>
          <View>
            <Text style={m.headerTitle}>Document Session</Text>
            <Text style={m.headerSubtitle}>Session {sessionId}</Text>
          </View>
          <TouchableOpacity
            style={m.closeButton}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close documentation modal"
          >
            <X size={20} color={colors.foreground} />
          </TouchableOpacity>
        </View>

        {/* Scrollable content */}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={m.scrollContent}
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
          <UnitsStepper value={unitsToBill} onChange={setUnitsToBill} />

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

          {/* Session notes */}
          <View style={ds.section}>
            <View style={m.notesHeader}>
              <Text style={ds.sectionTitle}>Session Notes</Text>
              <Text style={m.charCounter}>
                {sessionNotes.length}/{NOTES_MAX}
              </Text>
            </View>
            <TextInput
              style={m.notesInput}
              value={sessionNotes}
              onChangeText={(v) => {
                if (v.length <= NOTES_MAX) setSessionNotes(v);
              }}
              placeholder="Add any additional notes about this session..."
              placeholderTextColor={colors.mutedForeground}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
              maxLength={NOTES_MAX}
              accessibilityLabel="Session notes"
            />
          </View>
        </ScrollView>

        {/* Fixed footer */}
        <View style={m.footer}>
          {!isValid && (
            <Text style={m.validationHint}>
              Select at least one diagnosis code and a procedure code to submit.
            </Text>
          )}
          <TouchableOpacity
            style={[m.submitButton, (!isValid || isSubmitting) && m.submitButtonDisabled]}
            onPress={handleSubmit}
            disabled={!isValid || isSubmitting}
            accessibilityRole="button"
            accessibilityLabel="Submit documentation and billing"
            accessibilityState={{ disabled: !isValid || isSubmitting }}
            activeOpacity={0.85}
          >
            <FileText size={16} color="#FFFFFF" />
            <Text style={m.submitButtonText}>
              {isSubmitting ? 'Submitting...' : 'Submit Documentation & Billing'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const m = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  headerTitle: {
    ...typography.displaySm,
    color: colors.foreground,
  },
  headerSubtitle: {
    ...typography.label,
    color: colors.mutedForeground,
    marginTop: 2,
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 16,
  },
  notesHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  charCounter: {
    ...typography.label,
    color: colors.mutedForeground,
  },
  notesInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.card,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 96,
    ...typography.bodyMd,
    color: colors.foreground,
  },
  footer: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    paddingBottom: Platform.OS === 'ios' ? 32 : 16,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
    gap: 8,
  },
  validationHint: {
    ...typography.label,
    color: colors.mutedForeground,
    textAlign: 'center',
  },
  submitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: 16,
  },
  submitButtonDisabled: {
    opacity: 0.4,
  },
  submitButtonText: {
    ...typography.bodyMd,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});
