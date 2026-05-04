/**
 * MemberFindScreen — "Find Your CHW" page.
 *
 * Features:
 * - Search input (filters by name/bio)
 * - Horizontal filter tabs by vertical category
 * - Map view with CHW pins (native only; web falls back to list-only)
 * - FlatList of CHW cards with avatar, specializations, rating, experience, bio
 * - Schedule request Modal with vertical, urgency, mode, and description
 * - Toast confirmation on submit
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  Modal,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  CheckCircle,
  Map as MapIcon,
  Search,
  Star,
  X,
} from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import {
  verticalLabels,
  type SessionMode,
  type Urgency,
  type Vertical,
} from '../../data/mock';
import {
  useChwBrowse,
  useCreateRequest,
  useSessions,
  type ChwBrowseItem,
} from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import { ChwMapWebView } from '../../components/find/ChwMapWebView';
import { zipToLatLng } from '../../utils/geocoding';

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

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScheduleFormData {
  /** One or more verticals — submitted as separate requests when multiple */
  verticals: Vertical[];
  urgency: Urgency;
  mode: SessionMode;
  description: string;
  /** Optional preferred time slot for follow-up sessions (HH:MM 24h) */
  preferredTime?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const FILTER_VERTICALS: { key: Vertical; label: string }[] = [
  { key: 'housing', label: 'Housing' },
  { key: 'food', label: 'Food' },
  { key: 'mental_health', label: 'Mental Health' },
  { key: 'rehab', label: 'Rehab' },
  { key: 'healthcare', label: 'Healthcare' },
];

const VERTICAL_OPTIONS: { key: Vertical; label: string; emoji: string }[] = [
  { key: 'housing', label: 'Housing', emoji: '🏠' },
  { key: 'food', label: 'Food Security', emoji: '🛒' },
  { key: 'mental_health', label: 'Mental Health', emoji: '🧠' },
  { key: 'rehab', label: 'Rehab & Recovery', emoji: '💪' },
  { key: 'healthcare', label: 'Healthcare Access', emoji: '🏥' },
];

const URGENCY_OPTIONS: { key: Urgency; label: string }[] = [
  { key: 'routine', label: 'Routine' },
  { key: 'soon', label: 'Soon' },
  { key: 'urgent', label: 'Urgent' },
];

const MODE_OPTIONS: { key: SessionMode; label: string }[] = [
  { key: 'in_person', label: 'In Person' },
  { key: 'virtual', label: 'Virtual' },
  { key: 'phone', label: 'Phone' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a deterministic background color for CHW avatar initials
 * based on the first character's char code.
 */
function getAvatarBg(initials: string): string {
  const palettes = [
    { bg: `${colors.primary}18`, text: colors.primary },
    { bg: '#EBF5FB', text: '#0077B6' },
    { bg: '#F3E5F5', text: '#7B1FA2' },
    { bg: '#FFF3E0', text: '#E65100' },
    { bg: '#FCE4EC', text: '#C2185B' },
  ];
  const idx = initials.charCodeAt(0) % palettes.length;
  return palettes[idx].bg;
}

function getAvatarTextColor(initials: string): string {
  const palettes = [
    colors.primary,
    '#0077B6',
    '#7B1FA2',
    '#E65100',
    '#C2185B',
  ];
  const idx = initials.charCodeAt(0) % palettes.length;
  return palettes[idx];
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface ToastBannerProps {
  message: string;
}

function ToastBanner({ message }: ToastBannerProps): React.JSX.Element {
  return (
    <View style={toastStyles.container} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <CheckCircle color="#FFFFFF" size={15} />
      <Text style={toastStyles.text}>{message}</Text>
    </View>
  );
}

const toastStyles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 54 : 16,
    left: 16,
    right: 16,
    zIndex: 99,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 16,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 12,
      },
      android: {
        elevation: 8,
      },
    }),
  },
  text: {
    ...typography.bodySm,
    color: '#FFFFFF',
    fontWeight: '600',
    flex: 1,
  },
});

interface StarDisplayProps {
  rating: number;
}

function StarDisplay({ rating }: StarDisplayProps): React.JSX.Element {
  const full = Math.floor(rating);
  return (
    <View style={starStyles.row} accessibilityLabel={`Rating: ${rating} out of 5`}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star
          key={i}
          size={11}
          color={i < full ? '#FBBF24' : colors.border}
          fill={i < full ? '#FBBF24' : colors.border}
        />
      ))}
      <Text style={starStyles.ratingText}>{rating.toFixed(1)}</Text>
    </View>
  );
}

const starStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  ratingText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.mutedForeground,
    marginLeft: 3,
  },
});

// ─── Schedule Modal ────────────────────────────────────────────────────────────

/** Time slots offered for follow-up sessions (per JT Figma feedback) */
const TIME_SLOTS = [
  '09:00', '10:00', '11:00',
  '13:00', '14:00', '15:00',
  '16:00', '17:00', '18:00',
];

function formatTimeSlot(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${display} ${suffix}` : `${display}:${String(m).padStart(2, '0')} ${suffix}`;
}

interface ScheduleModalProps {
  chw: ChwBrowseItem;
  visible: boolean;
  /** True if this CHW already has prior sessions with this member — controls
   *  whether the time-slot picker is rendered (skip for first/initial meeting). */
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
  // Multi-select per Akram's instruction: one schedule submission can cover
  // multiple needs. The form submits one create-request call per selected
  // vertical so the CHW sees one ticket per need on their inbox.
  const [selectedVerticals, setSelectedVerticals] = useState<Set<Vertical>>(new Set());
  const [urgency, setUrgency] = useState<Urgency>('routine');
  const [mode, setMode] = useState<SessionMode>('in_person');
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
      verticals: Array.from(selectedVerticals),
      urgency,
      mode,
      description,
      preferredTime: preferredTime ?? undefined,
    });
    resetForm();
  }, [chw.name, description, mode, onSubmit, preferredTime, resetForm, selectedVerticals, urgency]);

  // Derive initials from name since ChwBrowseItem has no pre-computed avatar field
  const initials = chw.name
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  const avatarBg = getAvatarBg(initials);
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
                <Text style={modalStyles.headerTitle}>Schedule with {chw.name.split(' ')[0]}</Text>
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
              <X color={colors.mutedForeground} size={18} />
            </TouchableOpacity>
          </View>

          <ScrollView style={modalStyles.body} showsVerticalScrollIndicator={false}>
            {/* Vertical selection — multi-select per Akram instruction */}
            <Text style={modalStyles.fieldLabel}>
              What do you need help with?{' '}
              <Text style={{ fontWeight: '400', color: colors.mutedForeground }}>
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
                    <Text style={[
                      modalStyles.verticalOptionText,
                      isSelected && { color: colors.primary },
                    ]}>
                      {opt.label}
                    </Text>
                    {isSelected && (
                      <CheckCircle color={colors.primary} size={15} style={modalStyles.checkIcon} />
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
                    <Text style={[
                      modalStyles.chipText,
                      isSelected && { color: colors.primary },
                    ]}>
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
                    <Text style={[
                      modalStyles.chipText,
                      isSelected && { color: colors.primary },
                    ]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Time-slot picker — only for follow-up sessions per JT feedback.
                First/initial meetings get scheduled by the CHW after contact. */}
            {isFollowUp && (
              <>
                <Text style={modalStyles.fieldLabel}>
                  Preferred time{' '}
                  <Text style={{ fontWeight: '400', color: colors.mutedForeground }}>(optional)</Text>
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
              Description <Text style={{ fontWeight: '400', color: colors.mutedForeground }}>(optional)</Text>
            </Text>
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="Briefly describe what you need help with..."
              placeholderTextColor={colors.mutedForeground}
              multiline
              numberOfLines={3}
              style={modalStyles.textArea}
              textAlignVertical="top"
              accessibilityLabel="Description"
            />

            {/* Submit */}
            <TouchableOpacity
              onPress={handleSubmit}
              disabled={selectedVerticals.size === 0}
              style={[
                modalStyles.submitBtn,
                selectedVerticals.size === 0 && modalStyles.submitBtnDisabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel={
                selectedVerticals.size > 1
                  ? `Submit ${selectedVerticals.size} requests`
                  : 'Submit request'
              }
            >
              <Text style={[
                modalStyles.submitBtnText,
                selectedVerticals.size === 0 && { color: colors.mutedForeground },
              ]}>
                {selectedVerticals.size > 1
                  ? `Submit ${selectedVerticals.size} Requests`
                  : 'Submit Request'}
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
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '90%',
    shadowColor: '#3D5A3E',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 16,
    elevation: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 18,
    borderBottomWidth: 1,
    borderBottomColor: '#DDD6CC',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
  },
  headerTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#1E3320',
  },
  headerSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    letterSpacing: 1,
    color: '#6B7A6B',
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#F4F1ED',
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    padding: 18,
  },
  fieldLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#1E3320',
    marginBottom: 10,
    marginTop: 4,
  },
  verticalList: {
    gap: 8,
    marginBottom: 20,
  },
  verticalOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    backgroundColor: '#FFFFFF',
  },
  verticalOptionSelected: {
    borderColor: '#3D5A3E',
    backgroundColor: '#3D5A3E0D',
  },
  verticalEmoji: {
    fontSize: 18,
  },
  verticalOptionText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#1E3320',
    flex: 1,
  },
  checkIcon: {
    marginLeft: 'auto' as any,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 20,
  },
  chip: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  chipSelected: {
    borderColor: '#3D5A3E',
    backgroundColor: '#3D5A3E0D',
  },
  timeSlotGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 20,
  },
  timeSlot: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    backgroundColor: '#FFFFFF',
    minWidth: 76,
    alignItems: 'center',
  },
  timeSlotSelected: {
    borderColor: '#3D5A3E',
    backgroundColor: '#3D5A3E',
  },
  timeSlotText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#1E3320',
  },
  timeSlotTextSelected: {
    color: '#FFFFFF',
  },
  chipText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7A6B',
  },
  textArea: {
    borderWidth: 1,
    borderColor: '#DDD6CC',
    borderRadius: 12,
    padding: 16,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#1E3320',
    minHeight: 80,
    marginBottom: 20,
    backgroundColor: '#FFFFFF',
  },
  submitBtn: {
    backgroundColor: '#3D5A3E',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  submitBtnDisabled: {
    backgroundColor: '#DDD6CC',
  },
  submitBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#FFFFFF',
  },
});

// ─── CHW Card ─────────────────────────────────────────────────────────────────

interface CHWCardProps {
  chw: ChwBrowseItem;
  onSchedule: (chw: ChwBrowseItem) => void;
}

function CHWCard({ chw, onSchedule }: CHWCardProps): React.JSX.Element {
  const initials = chw.name
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();
  const avatarBg = getAvatarBg(initials);
  const avatarTextColor = getAvatarTextColor(initials);

  return (
    <View style={cardStyles.container} accessibilityRole="none">
      <View style={cardStyles.topRow}>
        {/* Avatar */}
        <View style={[cardStyles.avatar, { backgroundColor: avatarBg }]}>
          <Text style={[cardStyles.avatarText, { color: avatarTextColor }]}>{initials}</Text>
        </View>

        <View style={cardStyles.infoCol}>
          {/* Name + availability */}
          <View style={cardStyles.nameRow}>
            <Text style={cardStyles.name} numberOfLines={1}>{chw.name}</Text>
            {chw.isAvailable ? (
              <View style={cardStyles.availableBadge}>
                <Text style={cardStyles.availableBadgeText}>Available</Text>
              </View>
            ) : (
              <View style={cardStyles.unavailableBadge}>
                <Text style={cardStyles.unavailableBadgeText}>Unavailable</Text>
              </View>
            )}
          </View>

          {/* Rating + experience */}
          <View style={cardStyles.metaRow}>
            <StarDisplay rating={chw.rating} />
            <Text style={cardStyles.expText}>{chw.yearsExperience} yrs exp</Text>
          </View>

          {/* Specialization pills */}
          <View style={cardStyles.pillRow}>
            {chw.specializations.map((v) => (
              <View key={v} style={cardStyles.pill}>
                <Text style={cardStyles.pillText}>
                  {verticalLabels[v as Vertical] ?? v}
                </Text>
              </View>
            ))}
          </View>

          {/* Languages */}
          <Text style={cardStyles.languages}>
            <Text style={cardStyles.languagesLabel}>Languages: </Text>
            {chw.languages.join(', ')}
          </Text>

          {/* Bio */}
          <Text style={cardStyles.bio} numberOfLines={2}>{chw.bio}</Text>
        </View>
      </View>

      {/* Schedule button */}
      <TouchableOpacity
        onPress={() => onSchedule(chw)}
        style={[cardStyles.scheduleBtn, !chw.isAvailable && cardStyles.scheduleBtnDisabled]}
        disabled={!chw.isAvailable}
        accessibilityRole="button"
        accessibilityLabel={`Schedule a session with ${chw.name}`}
      >
        <Text style={[cardStyles.scheduleBtnText, !chw.isAvailable && { color: colors.mutedForeground }]}>
          {chw.isAvailable ? 'Schedule Session' : 'Not Available'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const cardStyles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 12,
    shadowColor: '#3D5A3E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 3,
  },
  topRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 12,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  avatarText: {
    fontSize: 16,
    fontWeight: '700',
  },
  infoCol: {
    flex: 1,
    gap: 4,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  name: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    lineHeight: 20,
    color: '#1E3320',
    flex: 1,
  },
  availableBadge: {
    backgroundColor: '#7A9F5A20',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
  },
  availableBadgeText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#7A9F5A',
  },
  unavailableBadge: {
    backgroundColor: '#6B7A6B15',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
  },
  unavailableBadgeText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#6B7A6B',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  expText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7A6B',
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  pill: {
    backgroundColor: '#7A9F5A18',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
  },
  pillText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 10,
    color: '#7A9F5A',
  },
  languages: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7A6B',
  },
  languagesLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    textTransform: 'uppercase',
    fontSize: 10,
    letterSpacing: 1,
  },
  bio: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7A6B',
    lineHeight: 16,
  },
  scheduleBtn: {
    backgroundColor: '#3D5A3E',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  scheduleBtnDisabled: {
    backgroundColor: '#DDD6CC',
  },
  scheduleBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#FFFFFF',
  },
});

// ─── CHW Map View (native only) ───────────────────────────────────────────────

/** The LA County geographic center, used as the default camera target. */
const LA_CENTER = { latitude: 34.0522, longitude: -118.2437 } as const;

/** Zoom level that comfortably frames all of LA County (~county-wide view). */
const LA_COUNTY_ZOOM = 9;

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
  // Build a lookup from CHW id → CHW for fast retrieval inside the marker
  // click handler, which only receives the marker object back from the SDK.
  const chwById = useMemo(() => {
    const lookup = new Map<string, ChwBrowseItem>();
    for (const chw of chws) {
      lookup.set(chw.id, chw);
    }
    return lookup;
  }, [chws]);

  /** Resolved markers — one per CHW with a resolvable ZIP code. */
  const markers = useMemo(() => {
    return chws.flatMap((chw) => {
      const coords = zipToLatLng(chw.zipCode);
      if (!coords) return [];
      return [
        {
          id: chw.id,
          coordinates: { latitude: coords.lat, longitude: coords.lng },
          title: chw.name,
        },
      ];
    });
  }, [chws]);

  if (Platform.OS === 'ios' && AppleMapsView) {
    return (
      <AppleMapsView
        style={mapStyles.map}
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
        style={mapStyles.map}
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

  // Fallback: should not be reached on native, but satisfies the type system.
  return null;
}

const mapStyles = StyleSheet.create({
  map: {
    height: 220,
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export function MemberFindScreen(): React.JSX.Element {
  const [searchQuery, setSearchQuery] = useState('');
  // Multi-select category filter (per JT Figma feedback: "select CHW with
  // multiple categories. Not just one or all but multi-select"). Empty set
  // = "All" (no filter applied).
  const [selectedVerticals, setSelectedVerticals] = useState<Set<Vertical>>(new Set());
  const [schedulingChw, setSchedulingChw] = useState<ChwBrowseItem | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  /** Controls whether the map panel is expanded. Defaults to expanded on
   *  every platform so members see CHW locations immediately. */
  const [mapExpanded, setMapExpanded] = useState(true);

  // Always fetch the full CHW list (no server-side filter). Multi-select
  // filtering happens client-side below — keeps the backend contract
  // unchanged while supporting union filtering.
  const chwQuery = useChwBrowse(undefined);
  const sessionsQuery = useSessions();
  const createRequest = useCreateRequest();

  // Set of CHW ids the member has had any session with — drives the "this
  // is a follow-up" branch in ScheduleModal so first/initial meetings skip
  // the time-slot picker per JT Figma feedback.
  const priorChwIds = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessionsQuery.data ?? []) {
      // ChwBrowseItem.id corresponds to the CHW user id; SessionData carries
      // chwName but not chwId on the wire today. TODO(backend): expose
      // session.chw_id so this reads cleanly. For now match on chwName.
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
    let result = allChws;

    // Vertical filter — CHW must have at least one of the selected
    // specializations (union, not intersection).
    if (selectedVerticals.size > 0) {
      result = result.filter((chw) =>
        chw.specializations.some((s) => selectedVerticals.has(s as Vertical)),
      );
    }

    if (!query) return result;
    return result.filter((chw) => {
      return (
        chw.name.toLowerCase().includes(query) ||
        chw.bio.toLowerCase().includes(query) ||
        chw.specializations.some((s) =>
          (verticalLabels[s as Vertical] ?? s).toLowerCase().includes(query),
        )
      );
    });
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

  const handleModalClose = useCallback(() => {
    setSchedulingChw(null);
  }, []);

  /**
   * Tapping a map pin selects that CHW and opens the schedule modal,
   * matching the same selection pattern used by the list card's Schedule button.
   */
  const handleMapMarkerPress = useCallback((chw: ChwBrowseItem) => {
    setSchedulingChw(chw);
  }, []);

  const handleModalSubmit = useCallback(
    async (chwFirstName: string, formData: ScheduleFormData) => {
      setSchedulingChw(null);
      const count = formData.verticals.length;
      try {
        // Fan out one create-request per selected vertical so the CHW sees
        // a separate ticket per need. Same description/urgency/mode applies
        // to all — the vertical is what differentiates the rows.
        await Promise.all(
          formData.verticals.map((vertical) =>
            createRequest.mutateAsync({
              vertical,
              urgency: formData.urgency,
              description: formData.description,
              preferredMode: formData.mode,
              estimatedUnits: 1,
            }),
          ),
        );
        showToast(
          count > 1
            ? `${count} requests submitted! ${chwFirstName} will be in touch soon.`
            : `Request submitted! ${chwFirstName} will be in touch soon.`,
        );
      } catch (err) {
        // Surface the real backend reason so we can diagnose 401 / 422 /
        // 500 instead of swallowing it behind a generic "please try again"
        // toast. ApiError carries `.detail` from FastAPI's HTTPException;
        // a network failure becomes a plain Error.
        const reason =
          err instanceof Error && err.message ? err.message : 'Unknown error';
        // eslint-disable-next-line no-console
        console.error('[MemberFindScreen] createRequest failed:', err);
        showToast(
          count > 1
            ? `Some requests failed: ${reason}`
            : `Failed to submit request: ${reason}`,
        );
      }
    },
    [createRequest, showToast],
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.background} />

      {/* Toast */}
      {toastMessage ? <ToastBanner message={toastMessage} /> : null}

      {/* Schedule modal */}
      {schedulingChw ? (
        <ScheduleModal
          chw={schedulingChw}
          visible={schedulingChw !== null}
          isFollowUp={priorChwIds.has(schedulingChw.name)}
          onClose={handleModalClose}
          onSubmit={handleModalSubmit}
        />
      ) : null}

      {/* Page header */}
      <View style={styles.pageHeader}>
        <Text style={styles.pageTitle}>Find Your CHW</Text>
        <Text style={styles.pageSub}>Matched to your needs</Text>
      </View>

      {/* Search bar */}
      <View style={styles.searchContainer}>
        <Search color={colors.mutedForeground} size={16} />
        <TextInput
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Search by name, specialty..."
          placeholderTextColor={colors.mutedForeground}
          style={styles.searchInput}
          clearButtonMode="while-editing"
          accessibilityLabel="Search CHWs"
          returnKeyType="search"
        />
      </View>

      {/* Multi-select category chips (JT Figma feedback) */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterTabsContent}
        style={styles.filterTabs}
      >
        {/* "All" — active when nothing is selected. Tapping clears selection. */}
        <TouchableOpacity
          onPress={clearFilters}
          style={[styles.filterTab, selectedVerticals.size === 0 && styles.filterTabActive]}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: selectedVerticals.size === 0 }}
          accessibilityLabel="Show all categories"
        >
          <Text style={[styles.filterTabText, selectedVerticals.size === 0 && styles.filterTabTextActive]}>
            All
          </Text>
        </TouchableOpacity>
        {FILTER_VERTICALS.map((tab) => {
          const isSelected = selectedVerticals.has(tab.key);
          const count = verticalCount(tab.key);
          return (
            <TouchableOpacity
              key={tab.key}
              onPress={() => toggleVertical(tab.key)}
              style={[styles.filterTab, isSelected && styles.filterTabActive]}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: isSelected }}
              accessibilityLabel={`Toggle ${tab.label} filter`}
            >
              <Text style={[styles.filterTabText, isSelected && styles.filterTabTextActive]}>
                {tab.label}{count > 0 ? ` ${count}` : ''}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Map toggle header — all platforms */}
      <TouchableOpacity
        style={styles.mapToggleRow}
        onPress={() => setMapExpanded((prev) => !prev)}
        accessibilityRole="button"
        accessibilityLabel={mapExpanded ? 'Collapse map view' : 'Expand map view'}
      >
        <MapIcon color={colors.primary} size={15} />
        <Text style={styles.mapToggleText}>Map view</Text>
        <Text style={styles.mapToggleChevron}>{mapExpanded ? '▲' : '▼'}</Text>
      </TouchableOpacity>

      {/* Map — AppleMaps/GoogleMaps on native, Mapbox on web. */}
      {mapExpanded ? (
        Platform.OS === 'web' ? (
          <ChwMapWebView chws={filteredChws} onMarkerPress={handleMapMarkerPress} />
        ) : (
          <ChwMapView chws={filteredChws} onMarkerPress={handleMapMarkerPress} />
        )
      ) : null}

      {/* CHW List */}
      {chwQuery.isLoading ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
          <LoadingSkeleton variant="rows" rows={4} />
        </View>
      ) : chwQuery.error ? (
        <ErrorState
          message="Could not load CHW listings. Please try again."
          onRetry={() => void chwQuery.refetch()}
        />
      ) : (
        <FlatList
          data={filteredChws}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <CHWCard chw={item} onSchedule={handleSchedule} />
          )}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={() => (
            <View style={styles.emptyState}>
              <Search color={colors.mutedForeground} size={28} />
              <Text style={styles.emptyTitle}>No CHWs found</Text>
              <Text style={styles.emptySub}>
                Try a different filter or search term.
              </Text>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F4F1ED',
  },
  pageHeader: {
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 12,
  },
  pageTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    lineHeight: 30,
    color: '#1E3320',
  },
  pageSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7A6B',
    marginTop: 2,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DDD6CC',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: Platform.OS === 'ios' ? 14 : 8,
  },
  searchInput: {
    flex: 1,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    lineHeight: 20,
    color: '#1E3320',
    padding: 0,
  },
  filterTabs: {
    maxHeight: 44,
    marginBottom: 10,
  },
  filterTabsContent: {
    paddingHorizontal: 16,
    gap: 8,
    alignItems: 'center',
  },
  filterTab: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    backgroundColor: '#FFFFFF',
  },
  filterTabActive: {
    backgroundColor: '#3D5A3E',
    borderColor: '#3D5A3E',
  },
  filterTabText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#6B7A6B',
  },
  filterTabTextActive: {
    color: '#FFFFFF',
  },
  mapToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  mapToggleText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: colors.foreground,
    flex: 1,
  },
  mapToggleChevron: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 10,
    color: colors.mutedForeground,
  },
  listContent: {
    paddingTop: 4,
    paddingBottom: 24,
  },
  emptyState: {
    paddingTop: 48,
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#1E3320',
  },
  emptySub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7A6B',
    textAlign: 'center',
  },
});
