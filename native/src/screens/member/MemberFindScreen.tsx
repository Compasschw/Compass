/**
 * MemberFindScreen — "Find Your CHW" page.
 * T19 — 3-col CHW-search redesign with shared primitives.
 *
 * Visual language: matches the CHW Member List card pattern (Card primitive,
 * name / specializations / availability badge / language pills via Pill).
 *
 * Layout (web ≥ 768 px):
 *   Left rail  (240 px) — search + vertical filters
 *   Centre col (flex)   — CHW cards list
 *   Right rail (280 px) — map
 *
 * Narrow / native: stacked single-column layout with collapsible map.
 *
 * Primitives: Card, PageHeader, PageWrap, SectionHeader, Pill from ui/.
 * Tokens: theme/tokens (canonical) — no imports from theme/colors.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Filter,
  Map as MapIcon,
  Search,
  User,
  X,
} from 'lucide-react-native';
import type { MemberFindStackParamList } from '../../navigation/MemberTabNavigator';

import {
  AppShell,
  Card,
  PageHeader,
  PageWrap,
  Pill,
  PressableCard,
  SectionHeader,
} from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import { colors as tokens, radius, shadows, spacing } from '../../theme/tokens';
import { typography } from '../../theme/typography';
import {
  verticalLabels,
  type SessionMode,
  type Urgency,
  type Vertical,
} from '../../data/mock';
import {
  VERTICAL_FILTER_OPTIONS,
  VERTICAL_PICKER_OPTIONS,
} from '../../lib/verticals';
import {
  useChwBrowse,
  useCreateRequest,
  useSessions,
  type ChwBrowseItem,
  type CreateRequestPayload,
} from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import { ChwMapWebView } from '../../components/find/ChwMapWebView';
import { zipToLatLng } from '../../utils/geocoding';
import { BP_PHONE } from '../../constants/breakpoints';

// ─── Platform-gated expo-maps module references ───────────────────────────────
// expo-maps is a native-only module — it has no web build. The previous
// version of this file used a top-level `require('expo-maps')` guarded by
// `Platform.OS === 'ios'`, but Metro statically resolves all `require()`
// strings into the dependency graph regardless of conditional code paths.
// On web that meant Metro tried to resolve `expo-maps` at bundle time and
// either crashed silently or shipped a bundle that threw on load — leaving
// /member/find blank.
//
// Fix: wrap the require in try/catch and explicitly never invoke it on web.
// Metro still sees the literal `require('expo-maps')` string but the
// runtime expression is now defensive — a missing module returns null
// instead of throwing. The map fallback (ChwMapWebView) takes over on web.
// Type imports are erased by TypeScript so they don't reach the bundle.
//
// The proper fix would be a `.web.tsx` shim file, but that's a larger
// refactor; this defensive guard unblocks the screen for v1.

// Loose typing because we never directly construct these on web; the actual
// JSX consumers cast at the call site. Avoiding the type-only import from
// expo-maps as well, since TS-erased imports can still trip platform-
// specific bundler analyses on Metro for Web.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MapsViewComponent = React.ComponentType<any>;

const AppleMapsView: MapsViewComponent | null = (() => {
  if (Platform.OS !== 'ios') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-member-access
    return require('expo-maps').AppleMaps.View as MapsViewComponent;
  } catch {
    return null;
  }
})();

const GoogleMapsView: MapsViewComponent | null = (() => {
  if (Platform.OS !== 'android') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-member-access
    return require('expo-maps').GoogleMaps.View as MapsViewComponent;
  } catch {
    return null;
  }
})();

// ─── Layout constants ─────────────────────────────────────────────────────────

/**
 * Minimum viewport width at which the three-column layout activates.
 * Below this threshold the screen collapses to single-column with a
 * collapsible map toggle, matching native mobile behaviour.
 */
const THREE_COL_BREAKPOINT = 768;

/** Fixed widths for the left-filter and right-map rails in three-col mode. */
const FILTER_RAIL_WIDTH = 240;
const MAP_RAIL_WIDTH    = 280;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScheduleFormData {
  /** One or more verticals — submitted as a single request */
  verticals: Vertical[];
  urgency: Urgency;
  mode: SessionMode;
  description: string;
  /** Optional preferred time slot for follow-up sessions (HH:MM 24h) */
  preferredTime?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const FILTER_VERTICALS: ReadonlyArray<{ key: Vertical; label: string }> =
  VERTICAL_FILTER_OPTIONS as ReadonlyArray<{ key: Vertical; label: string }>;

const VERTICAL_OPTIONS: ReadonlyArray<{ key: Vertical; label: string; emoji: string }> =
  VERTICAL_PICKER_OPTIONS as ReadonlyArray<{ key: Vertical; label: string; emoji: string }>;

const URGENCY_OPTIONS: { key: Urgency; label: string }[] = [
  { key: 'routine', label: 'Routine' },
  { key: 'soon',    label: 'Soon'    },
  { key: 'urgent',  label: 'Urgent'  },
];

// 'virtual' (Video) removed from NEW-selection per product decision 2026-07-14
// — the SessionMode union keeps it so legacy virtual sessions still work.
const MODE_OPTIONS: { key: SessionMode; label: string }[] = [
  { key: 'in_person', label: 'In Person' },
  { key: 'phone',     label: 'Phone'     },
];

/** Time slots offered for follow-up sessions (per JT Figma feedback) */
const TIME_SLOTS = [
  '09:00', '10:00', '11:00',
  '13:00', '14:00', '15:00',
  '16:00', '17:00', '18:00',
];

/** The LA County geographic center, used as the default camera target. */
const LA_CENTER = { latitude: 34.0522, longitude: -118.2437 } as const;

/** Zoom level that comfortably frames all of LA County (~county-wide view). */
const LA_COUNTY_ZOOM = 9;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a deterministic avatar background colour for CHW initials
 * based on the first character's char code, drawn from the token palette.
 */
function getAvatarBg(initials: string): string {
  const palettes = [
    tokens.emerald100,
    tokens.blue100,
    tokens.purple100,
    tokens.amber100,
    tokens.pink100,
  ];
  const idx = initials.charCodeAt(0) % palettes.length;
  return palettes[idx];
}

function getAvatarTextColor(initials: string): string {
  const palettes = [
    tokens.emerald700,
    tokens.blue700,
    tokens.purple700,
    tokens.amber700,
    tokens.pink700,
  ];
  const idx = initials.charCodeAt(0) % palettes.length;
  return palettes[idx];
}

function formatTimeSlot(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix  = h >= 12 ? 'PM' : 'AM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return m === 0
    ? `${display} ${suffix}`
    : `${display}:${String(m).padStart(2, '0')} ${suffix}`;
}

/**
 * Derives up to 2-character uppercase initials from a full name string.
 */
function nameToInitials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();
}

// ─── Toast Banner ─────────────────────────────────────────────────────────────

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
    position:        'absolute',
    top:             Platform.OS === 'ios' ? 54 : 16,
    left:            16,
    right:           16,
    zIndex:          99,
    flexDirection:   'row',
    alignItems:      'center',
    gap:             spacing.sm,
    backgroundColor: tokens.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.md,
    borderRadius:    radius.xl,
    ...Platform.select({
      ios:     { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 12 },
      android: { elevation: 8 },
    }),
  } as ViewStyle,
  text: {
    ...typography.bodySm,
    color:      '#FFFFFF',
    fontWeight: '600',
    flex:       1,
  },
});

// ─── Schedule Modal ────────────────────────────────────────────────────────────

interface ScheduleModalProps {
  chw: ChwBrowseItem;
  visible: boolean;
  /** True when this CHW already has prior sessions with this member —
   *  controls whether the time-slot picker is rendered (skip for first meeting). */
  isFollowUp: boolean;
  onClose: () => void;
  onSubmit: (chwFirstName: string, formData: ScheduleFormData) => Promise<void>;
}

function ScheduleModal({
  chw,
  visible,
  isFollowUp,
  onClose,
  onSubmit,
}: ScheduleModalProps): React.JSX.Element {
  const [selectedVerticals, setSelectedVerticals] = useState<Set<Vertical>>(new Set());
  const [urgency, setUrgency]   = useState<Urgency>('routine');
  const [mode, setMode]         = useState<SessionMode>('in_person');
  const [description, setDescription] = useState('');
  const [preferredTime, setPreferredTime] = useState<string | null>(null);

  const toggleVertical = useCallback((v: Vertical) => {
    setSelectedVerticals((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  }, []);

  const resetForm = useCallback(() => {
    setSelectedVerticals(new Set());
    setUrgency('routine');
    setMode('in_person');
    setDescription('');
    setPreferredTime(null);
  }, []);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [resetForm, onClose]);

  const handleSubmit = useCallback(() => {
    if (selectedVerticals.size === 0) return;
    const firstName = chw.name.split(' ')[0] ?? chw.name;
    void onSubmit(firstName, {
      verticals:     Array.from(selectedVerticals),
      urgency,
      mode,
      description,
      preferredTime: preferredTime ?? undefined,
    });
    resetForm();
  }, [chw.name, description, mode, onSubmit, preferredTime, resetForm, selectedVerticals, urgency]);

  const initials       = nameToInitials(chw.name);
  const avatarBg       = getAvatarBg(initials);
  const avatarTextColor = getAvatarTextColor(initials);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={handleClose}
    >
      <View style={modalStyles.backdrop}>
        <View style={modalStyles.sheet}>
          {/* Header */}
          <View style={modalStyles.header}>
            <View style={modalStyles.headerLeft}>
              <View style={[modalStyles.avatar, { backgroundColor: avatarBg }]}>
                <Text style={[modalStyles.avatarText, { color: avatarTextColor }]}>
                  {initials}
                </Text>
              </View>
              <View>
                <Text style={modalStyles.headerTitle}>
                  Schedule with {chw.name.split(' ')[0]}
                </Text>
                <Text style={modalStyles.headerSub}>{chw.name}</Text>
              </View>
            </View>
            <TouchableOpacity
              onPress={handleClose}
              style={modalStyles.closeBtn}
              accessibilityRole="button"
              accessibilityLabel="Close modal"
              hitSlop={8}
            >
              <X color={tokens.textSecondary} size={18} />
            </TouchableOpacity>
          </View>

          <ScrollView style={modalStyles.body} showsVerticalScrollIndicator={false}>
            {/* Vertical selection — multi-select */}
            <Text style={modalStyles.fieldLabel}>
              What do you need help with?{' '}
              <Text style={{ fontWeight: '400', color: tokens.textSecondary }}>
                (select all that apply)
              </Text>
            </Text>
            <View style={modalStyles.verticalList}>
              {VERTICAL_OPTIONS.map((opt) => {
                const isSelected = selectedVerticals.has(opt.key);
                return (
                  <TouchableOpacity
                    key={opt.key}
                    onPress={() => toggleVertical(opt.key)}
                    style={[
                      modalStyles.verticalOption,
                      isSelected && modalStyles.verticalOptionSelected,
                    ]}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: isSelected }}
                    accessibilityLabel={opt.label}
                  >
                    <Text style={modalStyles.verticalEmoji}>{opt.emoji}</Text>
                    <Text
                      style={[
                        modalStyles.verticalOptionText,
                        isSelected && { color: tokens.primary },
                      ]}
                    >
                      {opt.label}
                    </Text>
                    {isSelected && (
                      <CheckCircle color={tokens.primary} size={15} />
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Urgency */}
            <Text style={modalStyles.fieldLabel}>Urgency</Text>
            <View style={modalStyles.chipRow}>
              {URGENCY_OPTIONS.map((opt) => {
                const isSelected = urgency === opt.key;
                return (
                  <TouchableOpacity
                    key={opt.key}
                    onPress={() => setUrgency(opt.key)}
                    style={[modalStyles.chip, isSelected && modalStyles.chipSelected]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isSelected }}
                  >
                    <Text
                      style={[
                        modalStyles.chipText,
                        isSelected && { color: tokens.primary },
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Mode */}
            <Text style={modalStyles.fieldLabel}>Preferred Mode</Text>
            <View style={modalStyles.chipRow}>
              {MODE_OPTIONS.map((opt) => {
                const isSelected = mode === opt.key;
                return (
                  <TouchableOpacity
                    key={opt.key}
                    onPress={() => setMode(opt.key)}
                    style={[modalStyles.chip, isSelected && modalStyles.chipSelected]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isSelected }}
                  >
                    <Text
                      style={[
                        modalStyles.chipText,
                        isSelected && { color: tokens.primary },
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Time-slot picker — follow-up sessions only (per JT Figma feedback) */}
            {isFollowUp && (
              <>
                <Text style={modalStyles.fieldLabel}>
                  Preferred time{' '}
                  <Text style={{ fontWeight: '400', color: tokens.textSecondary }}>
                    (optional)
                  </Text>
                </Text>
                <View style={modalStyles.timeSlotGrid}>
                  {TIME_SLOTS.map((slot) => {
                    const isSelected = preferredTime === slot;
                    return (
                      <TouchableOpacity
                        key={slot}
                        onPress={() => setPreferredTime(isSelected ? null : slot)}
                        style={[
                          modalStyles.timeSlot,
                          isSelected && modalStyles.timeSlotSelected,
                        ]}
                        accessibilityRole="button"
                        accessibilityState={{ selected: isSelected }}
                        accessibilityLabel={`Preferred time ${formatTimeSlot(slot)}`}
                      >
                        <Text
                          style={[
                            modalStyles.timeSlotText,
                            isSelected && modalStyles.timeSlotTextSelected,
                          ]}
                        >
                          {formatTimeSlot(slot)}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </>
            )}

            {/* Description */}
            <Text style={modalStyles.fieldLabel}>
              Description{' '}
              <Text style={{ fontWeight: '400', color: tokens.textSecondary }}>
                (optional)
              </Text>
            </Text>
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="Briefly describe what you need help with..."
              placeholderTextColor={tokens.textSecondary}
              multiline
              numberOfLines={3}
              style={modalStyles.textArea}
              textAlignVertical="top"
              accessibilityLabel="Description"
            />

            {selectedVerticals.size > 1 ? (
              <Text style={modalStyles.selectedCountHint}>
                {selectedVerticals.size} categories selected
              </Text>
            ) : null}

            <TouchableOpacity
              onPress={handleSubmit}
              disabled={selectedVerticals.size === 0}
              style={[
                modalStyles.submitBtn,
                selectedVerticals.size === 0 && modalStyles.submitBtnDisabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Submit request"
            >
              <Text
                style={[
                  modalStyles.submitBtnText,
                  selectedVerticals.size === 0 && { color: tokens.textSecondary },
                ]}
              >
                Submit Request
              </Text>
            </TouchableOpacity>

            <View style={{ height: 32 }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const modalStyles = StyleSheet.create({
  backdrop: {
    flex:            1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent:  'flex-end',
  } as ViewStyle,
  sheet: {
    backgroundColor:     tokens.cardBg,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    maxHeight:           '90%',
    ...Platform.select({
      ios:     { shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.1, shadowRadius: 16 },
      android: { elevation: 16 },
    }),
  } as ViewStyle,
  header: {
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'space-between',
    padding:         spacing.xl,
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
  } as ViewStyle,
  headerLeft: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           spacing.md,
    flex:          1,
  } as ViewStyle,
  avatar: {
    width:          44,
    height:         44,
    borderRadius:   radius.pill,
    alignItems:     'center',
    justifyContent: 'center',
  } as ViewStyle,
  avatarText: {
    fontFamily: 'DMSans_700Bold',
    fontSize:   15,
  },
  headerTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize:   16,
    lineHeight: 22,
    color:      tokens.textPrimary,
  },
  headerSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize:   12,
    letterSpacing: 0.5,
    color:      tokens.textSecondary,
  },
  closeBtn: {
    width:          32,
    height:         32,
    borderRadius:   radius.pill,
    backgroundColor: tokens.gray100,
    alignItems:     'center',
    justifyContent: 'center',
  } as ViewStyle,
  body: {
    padding: spacing.xl,
  },
  fieldLabel: {
    fontFamily:  'PlusJakartaSans_600SemiBold',
    fontSize:    14,
    color:       tokens.textPrimary,
    marginBottom: spacing.sm + 2,
    marginTop:   spacing.xs,
  },
  verticalList: {
    gap:          spacing.sm,
    marginBottom: spacing.xl,
  } as ViewStyle,
  verticalOption: {
    flexDirection:   'row',
    alignItems:      'center',
    gap:             spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius:    radius.lg,
    borderWidth:     1,
    borderColor:     tokens.cardBorder,
    backgroundColor: tokens.cardBg,
  } as ViewStyle,
  verticalOptionSelected: {
    borderColor:     tokens.primary,
    backgroundColor: `${tokens.primary}0D`,
  } as ViewStyle,
  verticalEmoji: {
    fontSize: 18,
  },
  verticalOptionText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize:   14,
    color:      tokens.textPrimary,
    flex:       1,
  },
  chipRow: {
    flexDirection: 'row',
    gap:           spacing.sm,
    marginBottom:  spacing.xl,
  } as ViewStyle,
  chip: {
    flex:              1,
    paddingVertical:   spacing.sm + 2,
    paddingHorizontal: spacing.sm,
    borderRadius:      radius.lg,
    borderWidth:       1,
    borderColor:       tokens.cardBorder,
    alignItems:        'center',
    backgroundColor:   tokens.cardBg,
  } as ViewStyle,
  chipSelected: {
    borderColor:     tokens.primary,
    backgroundColor: `${tokens.primary}0D`,
  } as ViewStyle,
  chipText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize:   14,
    color:      tokens.textSecondary,
  },
  timeSlotGrid: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:           spacing.sm,
    marginBottom:  spacing.xl,
  } as ViewStyle,
  timeSlot: {
    paddingHorizontal: spacing.md,
    paddingVertical:   spacing.sm,
    borderRadius:      radius.md,
    borderWidth:       1,
    borderColor:       tokens.cardBorder,
    backgroundColor:   tokens.cardBg,
    minWidth:          76,
    alignItems:        'center',
  } as ViewStyle,
  timeSlotSelected: {
    borderColor:     tokens.primary,
    backgroundColor: tokens.primary,
  } as ViewStyle,
  timeSlotText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize:   13,
    color:      tokens.textPrimary,
  },
  timeSlotTextSelected: {
    color: '#FFFFFF',
  },
  textArea: {
    borderWidth:       1,
    borderColor:       tokens.cardBorder,
    borderRadius:      radius.lg,
    padding:           spacing.lg,
    fontFamily:        'PlusJakartaSans_400Regular',
    fontSize:          14,
    color:             tokens.textPrimary,
    minHeight:         80,
    marginBottom:      spacing.xl,
    backgroundColor:   tokens.cardBg,
  },
  selectedCountHint: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize:   13,
    color:      tokens.textSecondary,
    textAlign:  'center',
    marginBottom: spacing.sm,
  },
  submitBtn: {
    backgroundColor: tokens.primary,
    borderRadius:    radius.lg,
    paddingVertical: spacing.lg,
    alignItems:      'center',
  } as ViewStyle,
  submitBtnDisabled: {
    backgroundColor: tokens.gray100,
  } as ViewStyle,
  submitBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize:   14,
    color:      '#FFFFFF',
  },
});

// ─── Filter Rail (left column) ────────────────────────────────────────────────

interface FilterRailProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  selectedVerticals: Set<Vertical>;
  onToggleVertical: (v: Vertical) => void;
  onClearFilters: () => void;
  verticalCount: (key: Vertical) => number;
  /** When true render as a Card-wrapped vertical sidebar; false = full-width. */
  isRail: boolean;
}

/**
 * Search input + vertical category multi-select filter section.
 * Renders as a fixed left rail in 3-col mode or as a top block in single-col mode.
 */
function FilterRail({
  searchQuery,
  onSearchChange,
  selectedVerticals,
  onToggleVertical,
  onClearFilters,
  verticalCount,
  isRail,
}: FilterRailProps): React.JSX.Element {
  const activeCount = selectedVerticals.size;

  const content = (
    <View style={filterRailStyles.inner}>
      <SectionHeader
        title="Filters"
        marginBottom={spacing.lg}
        right={
          activeCount > 0 ? (
            <Pressable
              onPress={onClearFilters}
              accessibilityRole="button"
              accessibilityLabel="Clear all filters"
            >
              <Text style={filterRailStyles.clearLink}>Clear</Text>
            </Pressable>
          ) : null
        }
      />

      {/* Search */}
      <View style={filterRailStyles.searchBox}>
        <Search color={tokens.textSecondary} size={14} />
        <TextInput
          value={searchQuery}
          onChangeText={onSearchChange}
          placeholder="Search by name, specialty..."
          placeholderTextColor={tokens.textMuted}
          style={filterRailStyles.searchInput}
          clearButtonMode="while-editing"
          accessibilityLabel="Search CHWs"
          returnKeyType="search"
        />
      </View>

      {/* Specializations */}
      <Text style={filterRailStyles.groupLabel}>Specialization</Text>

      {/* All */}
      <TouchableOpacity
        onPress={onClearFilters}
        style={[
          filterRailStyles.filterItem,
          activeCount === 0 && filterRailStyles.filterItemActive,
        ]}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: activeCount === 0 }}
        accessibilityLabel="Show all specializations"
      >
        <Text
          style={[
            filterRailStyles.filterItemText,
            activeCount === 0 && filterRailStyles.filterItemTextActive,
          ]}
        >
          All
        </Text>
      </TouchableOpacity>

      {FILTER_VERTICALS.map((tab) => {
        const isSelected = selectedVerticals.has(tab.key);
        const count      = verticalCount(tab.key);
        return (
          <TouchableOpacity
            key={tab.key}
            onPress={() => onToggleVertical(tab.key)}
            style={[
              filterRailStyles.filterItem,
              isSelected && filterRailStyles.filterItemActive,
            ]}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: isSelected }}
            accessibilityLabel={`Toggle ${tab.label} filter`}
          >
            <Text
              style={[
                filterRailStyles.filterItemText,
                isSelected && filterRailStyles.filterItemTextActive,
              ]}
              numberOfLines={1}
            >
              {tab.label}
            </Text>
            {count > 0 && (
              <View
                style={[
                  filterRailStyles.countBadge,
                  isSelected && filterRailStyles.countBadgeActive,
                ]}
              >
                <Text
                  style={[
                    filterRailStyles.countText,
                    isSelected && filterRailStyles.countTextActive,
                  ]}
                >
                  {count}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        );
      })}
    </View>
  );

  if (isRail) {
    return (
      <Card style={[filterRailStyles.railCard, shadows.card as ViewStyle]}>
        {content}
      </Card>
    );
  }

  return <View style={filterRailStyles.flatWrap}>{content}</View>;
}

const filterRailStyles = StyleSheet.create({
  railCard: {
    width:  FILTER_RAIL_WIDTH,
    flexShrink: 0,
    padding: spacing.xl,
    alignSelf: 'flex-start',
  } as ViewStyle,
  flatWrap: {
    backgroundColor: tokens.cardBg,
    borderRadius:    radius.xl,
    borderWidth:     1,
    borderColor:     tokens.cardBorder,
    marginBottom:    spacing.lg,
    padding:         spacing.xl,
  } as ViewStyle,
  inner: {
    gap: spacing.xs,
  } as ViewStyle,
  clearLink: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize:   13,
    color:      tokens.primary,
  },
  searchBox: {
    flexDirection:   'row',
    alignItems:      'center',
    gap:             spacing.sm,
    backgroundColor: tokens.pageBg,
    borderWidth:     1,
    borderColor:     tokens.cardBorder,
    borderRadius:    radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical:   Platform.OS === 'ios' ? spacing.md : spacing.sm,
    marginBottom:    spacing.lg,
  } as ViewStyle,
  searchInput: {
    flex:       1,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize:   14,
    color:      tokens.textPrimary,
    padding:    0,
  },
  groupLabel: {
    fontFamily:    'PlusJakartaSans_600SemiBold',
    fontSize:      10,
    letterSpacing: 1,
    textTransform: 'uppercase' as const,
    color:         tokens.textMuted,
    marginBottom:  spacing.xs,
    marginTop:     spacing.sm,
  },
  filterItem: {
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'space-between',
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.sm,
    borderRadius:    radius.md,
    marginBottom:    spacing.xs,
  } as ViewStyle,
  filterItemActive: {
    backgroundColor: `${tokens.primary}12`,
  } as ViewStyle,
  filterItemText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize:   14,
    color:      tokens.textSecondary,
    flex:       1,
  },
  filterItemTextActive: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    color:      tokens.primary,
  },
  countBadge: {
    backgroundColor: tokens.gray100,
    borderRadius:    radius.pill,
    paddingHorizontal: 7,
    paddingVertical:   2,
    marginLeft:      spacing.sm,
  } as ViewStyle,
  countBadgeActive: {
    backgroundColor: `${tokens.primary}22`,
  } as ViewStyle,
  countText: {
    fontFamily:  'PlusJakartaSans_600SemiBold',
    fontSize:    11,
    color:       tokens.textSecondary,
  },
  countTextActive: {
    color: tokens.primary,
  },
});

// ─── CHW Card ─────────────────────────────────────────────────────────────────

interface CHWCardProps {
  chw: ChwBrowseItem;
  onSchedule: (chw: ChwBrowseItem) => void;
  onViewProfile: (chw: ChwBrowseItem) => void;
}

/**
 * Renders a single CHW result card using the shared Card primitive.
 * Matches the CHW Members list card pattern:
 *   avatar / name + availability badge / specialization Pill row /
 *   language pills / bio excerpt / action buttons.
 */
function CHWCard({ chw, onSchedule, onViewProfile }: CHWCardProps): React.JSX.Element {
  const initials       = nameToInitials(chw.name);
  const avatarBg       = getAvatarBg(initials);
  const avatarTextColor = getAvatarTextColor(initials);

  return (
    <PressableCard style={chwCardStyles.card}>
      {/* Top row: avatar + identity block */}
      <View style={chwCardStyles.topRow}>
        <View style={[chwCardStyles.avatar, { backgroundColor: avatarBg }]}>
          <Text style={[chwCardStyles.avatarText, { color: avatarTextColor }]}>
            {initials}
          </Text>
        </View>

        <View style={chwCardStyles.identityBlock}>
          {/* Name + availability badge */}
          <View style={chwCardStyles.nameRow}>
            <Text style={chwCardStyles.name} numberOfLines={1}>
              {chw.name}
            </Text>
            {chw.isAvailable ? (
              <Pill variant="emerald" size="sm">Available</Pill>
            ) : (
              <Pill variant="gray" size="sm">Unavailable</Pill>
            )}
          </View>

          {/* Experience */}
          <Text style={chwCardStyles.meta}>
            {chw.yearsExperience} yr{chw.yearsExperience !== 1 ? 's' : ''} experience
          </Text>
        </View>
      </View>

      {/* Specialization pills */}
      {chw.specializations.length > 0 && (
        <View style={chwCardStyles.pillRow}>
          {chw.specializations.map((v) => (
            <Pill key={v} variant="emerald" size="sm">
              {verticalLabels[v as Vertical] ?? v}
            </Pill>
          ))}
        </View>
      )}

      {/* Languages */}
      {chw.languages.length > 0 && (
        <View style={chwCardStyles.pillRow}>
          {chw.languages.map((lang) => (
            <Pill key={lang} variant="blue" size="sm">
              {lang}
            </Pill>
          ))}
        </View>
      )}

      {/* Bio excerpt */}
      {chw.bio.length > 0 && (
        <Text style={chwCardStyles.bio} numberOfLines={2}>
          {chw.bio}
        </Text>
      )}

      {/* Divider */}
      <View style={chwCardStyles.divider} />

      {/* Actions */}
      <View style={chwCardStyles.actionRow}>
        <TouchableOpacity
          onPress={() => onViewProfile(chw)}
          style={chwCardStyles.profileBtn}
          accessibilityRole="button"
          accessibilityLabel={`View ${chw.name}'s profile`}
        >
          <User size={13} color={tokens.primary} />
          <Text style={chwCardStyles.profileBtnText}>Profile</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => onSchedule(chw)}
          style={[
            chwCardStyles.scheduleBtn,
            !chw.isAvailable && chwCardStyles.scheduleBtnDisabled,
          ]}
          disabled={!chw.isAvailable}
          accessibilityRole="button"
          accessibilityLabel={
            chw.isAvailable
              ? `Schedule a session with ${chw.name}`
              : `${chw.name} is not available`
          }
        >
          <Text
            style={[
              chwCardStyles.scheduleBtnText,
              !chw.isAvailable && { color: tokens.textSecondary },
            ]}
          >
            {chw.isAvailable ? 'Schedule Session' : 'Unavailable'}
          </Text>
        </TouchableOpacity>
      </View>
    </PressableCard>
  );
}

const chwCardStyles = StyleSheet.create({
  card: {
    padding:      spacing.xl,
    marginBottom: spacing.md,
  } as ViewStyle,
  topRow: {
    flexDirection: 'row',
    alignItems:    'flex-start',
    gap:           spacing.md,
    marginBottom:  spacing.md,
  } as ViewStyle,
  avatar: {
    width:          48,
    height:         48,
    borderRadius:   radius.pill,
    alignItems:     'center',
    justifyContent: 'center',
    flexShrink:     0,
  } as ViewStyle,
  avatarText: {
    fontFamily: 'DMSans_700Bold',
    fontSize:   16,
    lineHeight: 20,
  },
  identityBlock: {
    flex: 1,
    gap:  spacing.xs,
  } as ViewStyle,
  nameRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           spacing.sm,
    flexWrap:      'wrap',
  } as ViewStyle,
  name: {
    fontFamily: 'DMSans_700Bold',
    fontSize:   15,
    lineHeight: 20,
    color:      tokens.textPrimary,
    flexShrink: 1,
  },
  meta: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize:   12,
    color:      tokens.textSecondary,
    lineHeight: 16,
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:           spacing.xs,
    marginBottom:  spacing.sm,
  } as ViewStyle,
  bio: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize:   13,
    color:      tokens.textSecondary,
    lineHeight: 18,
    marginBottom: spacing.md,
  },
  divider: {
    height:          1,
    backgroundColor: tokens.cardBorder,
    marginBottom:    spacing.md,
  } as ViewStyle,
  actionRow: {
    flexDirection: 'row',
    gap:           spacing.sm,
    alignItems:    'center',
  } as ViewStyle,
  profileBtn: {
    flexDirection:   'row',
    alignItems:      'center',
    gap:             spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical:   spacing.sm + 2,
    borderRadius:    radius.lg,
    borderWidth:     1,
    borderColor:     `${tokens.primary}50`,
    backgroundColor: `${tokens.primary}10`,
    flexShrink:      0,
  } as ViewStyle,
  profileBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize:   13,
    color:      tokens.primary,
  },
  scheduleBtn: {
    flex:            1,
    backgroundColor: tokens.primary,
    borderRadius:    radius.lg,
    paddingVertical: spacing.sm + 2,
    alignItems:      'center',
  } as ViewStyle,
  scheduleBtnDisabled: {
    backgroundColor: tokens.gray100,
  } as ViewStyle,
  scheduleBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize:   14,
    color:      '#FFFFFF',
  },
});

// ─── CHW Map Rail (native only) ───────────────────────────────────────────────

interface ChwMapViewProps {
  chws: ChwBrowseItem[];
  onMarkerPress: (chw: ChwBrowseItem) => void;
}

/**
 * Renders a native map centered on LA County with one pin per CHW whose ZIP
 * resolves to a coordinate. CHWs with unknown ZIPs are silently skipped.
 *
 * Uses AppleMaps on iOS, GoogleMaps on Android. Not rendered on web.
 */
function ChwMapView({ chws, onMarkerPress }: ChwMapViewProps): React.JSX.Element | null {
  const chwById = useMemo(() => {
    const lookup = new Map<string, ChwBrowseItem>();
    for (const chw of chws) lookup.set(chw.id, chw);
    return lookup;
  }, [chws]);

  const markers = useMemo(() => {
    return chws.flatMap((chw) => {
      const coords = zipToLatLng(chw.zipCode);
      if (!coords) return [];
      return [
        {
          id:          chw.id,
          coordinates: { latitude: coords.lat, longitude: coords.lng },
          title:       chw.name,
        },
      ];
    });
  }, [chws]);

  if (Platform.OS === 'ios' && AppleMapsView) {
    return (
      <AppleMapsView
        style={mapViewStyles.map}
        cameraPosition={{ coordinates: LA_CENTER, zoom: LA_COUNTY_ZOOM }}
        markers={markers}
        onMarkerClick={(marker: { id?: string }) => {
          if (!marker.id) return;
          const chw = chwById.get(marker.id);
          if (chw) onMarkerPress(chw);
        }}
      />
    );
  }

  if (Platform.OS === 'android' && GoogleMapsView) {
    return (
      <GoogleMapsView
        style={mapViewStyles.map}
        cameraPosition={{ coordinates: LA_CENTER, zoom: LA_COUNTY_ZOOM }}
        markers={markers}
        onMarkerClick={(marker: { id?: string }) => {
          if (!marker.id) return;
          const chw = chwById.get(marker.id);
          if (chw) onMarkerPress(chw);
        }}
      />
    );
  }

  return null;
}

const mapViewStyles = StyleSheet.create({
  map: {
    flex:         1,
    borderRadius: radius.xl,
    overflow:     'hidden',
  } as ViewStyle,
});

// ─── Map Rail (right column — web 3-col) ─────────────────────────────────────

interface MapRailProps {
  chws: ChwBrowseItem[];
  onMarkerPress: (chw: ChwBrowseItem) => void;
}

/**
 * Sticky right-rail card containing the CHW map.
 * On web this renders the Mapbox WebView; on native it renders the expo-maps view.
 */
function MapRail({ chws, onMarkerPress }: MapRailProps): React.JSX.Element {
  return (
    <Card style={mapRailStyles.railCard}>
      <SectionHeader
        title="CHW Locations"
        subtitle="LA County"
        marginBottom={spacing.md}
      />
      <View style={mapRailStyles.mapWrap}>
        {Platform.OS === 'web' ? (
          <ChwMapWebView chws={chws} onMarkerPress={onMarkerPress} />
        ) : (
          <ChwMapView chws={chws} onMarkerPress={onMarkerPress} />
        )}
      </View>
    </Card>
  );
}

const mapRailStyles = StyleSheet.create({
  railCard: {
    width:      MAP_RAIL_WIDTH,
    flexShrink: 0,
    padding:    spacing.xl,
    alignSelf:  'flex-start',
  } as ViewStyle,
  mapWrap: {
    height:       320,
    borderRadius: radius.lg,
    overflow:     'hidden',
    borderWidth:  1,
    borderColor:  tokens.cardBorder,
  } as ViewStyle,
});

// ─── Collapsible Map (single-col / narrow) ────────────────────────────────────

interface CollapsibleMapProps {
  chws: ChwBrowseItem[];
  onMarkerPress: (chw: ChwBrowseItem) => void;
  expanded: boolean;
  onToggle: () => void;
}

function CollapsibleMap({
  chws,
  onMarkerPress,
  expanded,
  onToggle,
}: CollapsibleMapProps): React.JSX.Element {
  return (
    <View style={collapseMapStyles.wrapper}>
      <TouchableOpacity
        style={collapseMapStyles.toggleRow}
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Collapse map view' : 'Expand map view'}
      >
        <MapIcon color={tokens.primary} size={14} />
        <Text style={collapseMapStyles.toggleLabel}>Map view</Text>
        {expanded
          ? <ChevronUp color={tokens.textMuted} size={14} />
          : <ChevronDown color={tokens.textMuted} size={14} />
        }
      </TouchableOpacity>

      {expanded && (
        <View style={collapseMapStyles.mapWrap}>
          {Platform.OS === 'web' ? (
            <ChwMapWebView chws={chws} onMarkerPress={onMarkerPress} />
          ) : (
            <ChwMapView chws={chws} onMarkerPress={onMarkerPress} />
          )}
        </View>
      )}
    </View>
  );
}

const collapseMapStyles = StyleSheet.create({
  wrapper: {
    marginBottom: spacing.lg,
  } as ViewStyle,
  toggleRow: {
    flexDirection:   'row',
    alignItems:      'center',
    gap:             spacing.sm,
    backgroundColor: tokens.cardBg,
    borderWidth:     1,
    borderColor:     tokens.cardBorder,
    borderRadius:    radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.sm + 2,
    marginBottom:    spacing.sm,
  } as ViewStyle,
  toggleLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize:   13,
    color:      tokens.textPrimary,
    flex:       1,
  },
  mapWrap: {
    height:       220,
    borderRadius: radius.xl,
    overflow:     'hidden',
    borderWidth:  1,
    borderColor:  tokens.cardBorder,
  } as ViewStyle,
});

// ─── Empty State ──────────────────────────────────────────────────────────────

function EmptyState(): React.JSX.Element {
  return (
    <View style={emptyStyles.container}>
      <Filter color={tokens.textMuted} size={28} />
      <Text style={emptyStyles.title}>No CHWs found</Text>
      <Text style={emptyStyles.sub}>
        Try adjusting your filters or search term.
      </Text>
    </View>
  );
}

const emptyStyles = StyleSheet.create({
  container: {
    paddingTop:       48,
    alignItems:       'center',
    gap:              spacing.sm,
    paddingHorizontal: spacing.xxxl,
  } as ViewStyle,
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize:   16,
    lineHeight: 22,
    color:      tokens.textPrimary,
  },
  sub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize:   14,
    color:      tokens.textSecondary,
    textAlign:  'center',
  },
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export function MemberFindScreen(): React.JSX.Element {
  const navigation = useNavigation<NativeStackNavigationProp<MemberFindStackParamList>>();
  const { userName } = useAuth();
  const { width: windowWidth } = useWindowDimensions();

  /**
   * Activate three-column layout when the viewport is wide enough.
   * Member screens use PageWrap at 560px on web, but this screen is
   * info-dense (map + cards + filters) so we override to a wider 960px
   * container and activate 3-col at the 768px breakpoint.
   */
  const isThreeCol = Platform.OS === 'web' && windowWidth >= THREE_COL_BREAKPOINT;
  // Epic K (mobile web polish): pageContainer's spacing.xxxl (32px) side
  // padding is fine at desktop/tablet widths but eats too much of a phone
  // viewport (e.g. 360px - 64px = 296px of usable content). Tighten it at
  // phone width only — same 0-width-before-measurement guard as
  // CHWMembersScreen's useCardLayout, so it doesn't flash tight padding on
  // desktop before the real viewport is measured.
  const isPhone = Platform.OS === 'web' && windowWidth > 0 && windowWidth < BP_PHONE;

  const memberInitials = (userName ?? 'M')
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  const shellUserBlock = {
    initials: memberInitials,
    name:     userName ?? 'Member',
    role:     'Member' as const,
  };

  const [searchQuery, setSearchQuery]         = useState('');
  const [selectedVerticals, setSelectedVerticals] = useState<Set<Vertical>>(new Set());
  const [schedulingChw, setSchedulingChw]     = useState<ChwBrowseItem | null>(null);
  const [toastMessage, setToastMessage]       = useState<string | null>(null);
  const [mapExpanded, setMapExpanded]         = useState(true);

  const chwQuery       = useChwBrowse(undefined);
  const sessionsQuery  = useSessions();
  const createRequest  = useCreateRequest();

  // Determine which CHWs the member has had sessions with — drives the
  // follow-up branch in ScheduleModal (skip time-slot picker for first meetings).
  const priorChwIds = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessionsQuery.data ?? []) {
      // session.chw_id is not yet exposed on the wire; match on chwName.
      // TODO: wire session.chw_id once backend exposes it (#backend-chw-id).
      if (s.chwName) set.add(s.chwName);
    }
    return set;
  }, [sessionsQuery.data]);

  const allChws = chwQuery.data ?? [];

  const toggleVertical = useCallback((v: Vertical) => {
    setSelectedVerticals((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => {
    setSelectedVerticals(new Set());
  }, []);

  const filteredChws = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    let result  = allChws;

    // Union filter: CHW must have at least one of the selected specializations.
    if (selectedVerticals.size > 0) {
      result = result.filter((chw) =>
        chw.specializations.some((s) => selectedVerticals.has(s as Vertical)),
      );
    }

    if (!query) return result;
    return result.filter((chw) =>
      chw.name.toLowerCase().includes(query) ||
      chw.bio.toLowerCase().includes(query) ||
      chw.specializations.some((s) =>
        (verticalLabels[s as Vertical] ?? s).toLowerCase().includes(query),
      ),
    );
  }, [searchQuery, selectedVerticals, allChws]);

  const verticalCount = useCallback(
    (key: Vertical): number =>
      allChws.filter((chw) => chw.specializations.includes(key as string)).length,
    [allChws],
  );

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    const timer = setTimeout(() => setToastMessage(null), 3500);
    return () => clearTimeout(timer);
  }, []);

  const handleSchedule = useCallback((chw: ChwBrowseItem) => {
    setSchedulingChw(chw);
  }, []);

  /**
   * Navigate to the member-facing CHW profile screen.
   *
   * ChwBrowseItem.userId is the CHW's User.id UUID (from `user_id` in the
   * browse endpoint response). This matches the chw_id path param expected
   * by GET /member/chws/{chw_id}. Do NOT use chw.id (CHWProfile PK) here.
   */
  const handleViewProfile = useCallback(
    (chw: ChwBrowseItem) => {
      navigation.navigate('CHWProfile', { chwId: chw.userId });
    },
    [navigation],
  );

  const handleModalClose = useCallback(() => {
    setSchedulingChw(null);
  }, []);

  /**
   * Tapping a map pin opens the schedule modal for that CHW — same pattern
   * as tapping the Schedule button on a card.
   */
  const handleMapMarkerPress = useCallback((chw: ChwBrowseItem) => {
    setSchedulingChw(chw);
  }, []);

  const handleModalSubmit = useCallback(
    async (chwFirstName: string, formData: ScheduleFormData) => {
      // Capture the chosen CHW's user UUID BEFORE clearing the modal state.
      // Use userId, not id — the latter is the CHWProfile PK and the backend
      // validates the target against the users table (where it would not exist).
      const targetChwId = schedulingChw?.userId;
      setSchedulingChw(null);
      const count = formData.verticals.length;
      try {
        const payload: CreateRequestPayload = {
          verticals:     formData.verticals,
          urgency:       formData.urgency,
          description:   formData.description,
          preferredMode: formData.mode,
          estimatedUnits: 1,
          targetChwId,
        };
        await createRequest.mutateAsync(payload);
        showToast(
          count > 1
            ? `Request submitted with ${count} categories! ${chwFirstName} will be in touch soon.`
            : `Request submitted! ${chwFirstName} will be in touch soon.`,
        );
      } catch (err) {
        const reason =
          err instanceof Error && err.message ? err.message : 'Unknown error';
        showToast(`Failed to submit request: ${reason}`);
      }
    },
    [createRequest, showToast, schedulingChw],
  );

  // ── CHW list body (loading / error / list) ─────────────────────────────────

  function renderChwList(): React.JSX.Element {
    if (chwQuery.isLoading) {
      return (
        <View style={{ paddingTop: spacing.sm }}>
          <LoadingSkeleton variant="rows" rows={4} />
        </View>
      );
    }
    if (chwQuery.error) {
      return (
        <ErrorState
          message="Could not load CHW listings. Please try again."
          onRetry={() => void chwQuery.refetch()}
        />
      );
    }
    return (
      <FlatList
        data={filteredChws}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <CHWCard
            chw={item}
            onSchedule={handleSchedule}
            onViewProfile={handleViewProfile}
          />
        )}
        contentContainerStyle={screenStyles.listContent}
        showsVerticalScrollIndicator={false}
        scrollEnabled={false}
        ListEmptyComponent={EmptyState}
      />
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <AppShell role="member" activeKey="myChw" userBlock={shellUserBlock} disableMainScroll>
      <SafeAreaView style={screenStyles.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />

        {toastMessage ? <ToastBanner message={toastMessage} /> : null}

        {schedulingChw ? (
          <ScheduleModal
            chw={schedulingChw}
            visible={schedulingChw !== null}
            isFollowUp={priorChwIds.has(schedulingChw.name)}
            onClose={handleModalClose}
            onSubmit={handleModalSubmit}
          />
        ) : null}

        <ScrollView
          style={screenStyles.scroll}
          contentContainerStyle={screenStyles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/*
           * Info-dense browse screen — full 1280px page container so the
           * 3-column layout (filters + cards + map) fills the viewport.
           * PageWrap is still used via composition on strictly member-only
           * read screens (profile, roadmap, etc.).
           */}
          <View
            style={[
              screenStyles.pageContainer,
              isPhone && screenStyles.pageContainerPhone,
            ]}
          >
            <PageHeader
              title="Find Your CHW"
              subtitle="Matched to your needs in LA County"
            />

            {isThreeCol ? (
              // ── Three-column layout ────────────────────────────────────────
              <View style={screenStyles.threeColRow}>
                {/* Left: filter rail */}
                <FilterRail
                  searchQuery={searchQuery}
                  onSearchChange={setSearchQuery}
                  selectedVerticals={selectedVerticals}
                  onToggleVertical={toggleVertical}
                  onClearFilters={clearFilters}
                  verticalCount={verticalCount}
                  isRail
                />

                {/* Centre: CHW cards */}
                <View style={screenStyles.centerCol}>
                  {renderChwList()}
                </View>

                {/* Right: map rail */}
                <MapRail
                  chws={filteredChws}
                  onMarkerPress={handleMapMarkerPress}
                />
              </View>
            ) : (
              // ── Single-column layout ───────────────────────────────────────
              <View>
                <FilterRail
                  searchQuery={searchQuery}
                  onSearchChange={setSearchQuery}
                  selectedVerticals={selectedVerticals}
                  onToggleVertical={toggleVertical}
                  onClearFilters={clearFilters}
                  verticalCount={verticalCount}
                  isRail={false}
                />

                <CollapsibleMap
                  chws={filteredChws}
                  onMarkerPress={handleMapMarkerPress}
                  expanded={mapExpanded}
                  onToggle={() => setMapExpanded((prev) => !prev)}
                />

                {renderChwList()}
              </View>
            )}
          </View>
        </ScrollView>
      </SafeAreaView>
    </AppShell>
  );
}

// ─── Screen-level Styles ──────────────────────────────────────────────────────

const screenStyles = StyleSheet.create({
  safeArea: {
    flex:            1,
    backgroundColor: tokens.pageBg,
  } as ViewStyle,
  scroll: {
    flex: 1,
  } as ViewStyle,
  scrollContent: {
    flexGrow:   1,
    alignItems: 'center',
  } as ViewStyle,
  // Info-dense browse screen: full 1280px page width so the 3-col layout
  // (240 + flex + 280 + gaps) can breathe on standard 1280px+ desktops.
  pageContainer: {
    width:   '100%',
    maxWidth: 1280,
    padding: Platform.OS === 'web' ? spacing.xxxl : spacing.xl,
    paddingBottom: 48,
  } as ViewStyle,
  // Epic K (mobile web polish): tighter side padding at phone width — see
  // `isPhone` above.
  pageContainerPhone: {
    paddingLeft: spacing.lg,
    paddingRight: spacing.lg,
  } as ViewStyle,
  threeColRow: {
    flexDirection: 'row',
    alignItems:    'flex-start',
    gap:           spacing.xxl,
  } as ViewStyle,
  centerCol: {
    flex: 1,
    minWidth: 0,
  } as ViewStyle,
  listContent: {
    paddingBottom: spacing.xxl,
  } as ViewStyle,
});
