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
  type ChwBrowseItem,
} from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import { ChwMapWebView } from '../../components/find/ChwMapWebView';
import { zipToLatLng } from '../../utils/geocoding';
import type { AppleMapsViewProps } from 'expo-maps/build/apple/AppleMaps.types';
import type { GoogleMapsViewProps } from 'expo-maps/build/google/GoogleMaps.types';

// ─── Platform-gated expo-maps module references ───────────────────────────────
// expo-maps native modules are unavailable on web. We use conditional requires
// so the web bundle never attempts to resolve them.
// Metro's Platform.OS inlining tree-shakes the dead branch at bundle time.

type AppleMapsViewComponent = React.ComponentType<AppleMapsViewProps>;
type GoogleMapsViewComponent = React.ComponentType<GoogleMapsViewProps>;

// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
const AppleMapsView: AppleMapsViewComponent | null =
  Platform.OS === 'ios'
    ? (require('expo-maps').AppleMaps.View as AppleMapsViewComponent)
    : null;

// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
const GoogleMapsView: GoogleMapsViewComponent | null =
  Platform.OS === 'android'
    ? (require('expo-maps').GoogleMaps.View as GoogleMapsViewComponent)
    : null;

// ─── Types ────────────────────────────────────────────────────────────────────

type FilterTab = 'all' | Vertical;

interface ScheduleFormData {
  vertical: Vertical;
  urgency: Urgency;
  mode: SessionMode;
  description: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: 'all', label: 'All' },
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

interface ScheduleModalProps {
  chw: ChwBrowseItem;
  visible: boolean;
  onClose: () => void;
  onSubmit: (chwFirstName: string, formData: ScheduleFormData) => Promise<void>;
}

function ScheduleModal({ chw, visible, onClose, onSubmit }: ScheduleModalProps): React.JSX.Element {
  const [selectedVertical, setSelectedVertical] = useState<Vertical | null>(null);
  const [urgency, setUrgency] = useState<Urgency>('routine');
  const [mode, setMode] = useState<SessionMode>('in_person');
  const [description, setDescription] = useState('');

  const resetForm = useCallback(() => {
    setSelectedVertical(null);
    setUrgency('routine');
    setMode('in_person');
    setDescription('');
  }, []);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [resetForm, onClose]);

  const handleSubmit = useCallback(() => {
    if (!selectedVertical) return;
    const firstName = chw.name.split(' ')[0] ?? chw.name;
    void onSubmit(firstName, { vertical: selectedVertical, urgency, mode, description });
    resetForm();
  }, [chw.name, description, mode, onSubmit, resetForm, selectedVertical, urgency]);

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
            {/* Vertical selection */}
            <Text style={modalStyles.fieldLabel}>What do you need help with?</Text>
            <View style={modalStyles.verticalList}>
              {VERTICAL_OPTIONS.map((opt) => {
                const isSelected = selectedVertical === opt.key;
                return (
                  <TouchableOpacity
                    key={opt.key}
                    onPress={() => setSelectedVertical(opt.key)}
                    style={[
                      modalStyles.verticalOption,
                      isSelected && modalStyles.verticalOptionSelected,
                    ]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isSelected }}
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
              disabled={selectedVertical === null}
              style={[
                modalStyles.submitBtn,
                selectedVertical === null && modalStyles.submitBtnDisabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Submit request"
            >
              <Text style={[
                modalStyles.submitBtnText,
                selectedVertical === null && { color: colors.mutedForeground },
              ]}>
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
        onMarkerClick={(marker) => {
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
        onMarkerClick={(marker) => {
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
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all');
  const [schedulingChw, setSchedulingChw] = useState<ChwBrowseItem | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  /** Controls whether the map panel is expanded. Defaults to expanded on
   *  every platform so members see CHW locations immediately. */
  const [mapExpanded, setMapExpanded] = useState(true);

  // Re-fetch whenever the vertical filter changes (passes undefined for 'all')
  const browseVertical = activeFilter === 'all' ? undefined : activeFilter;
  const chwQuery = useChwBrowse(browseVertical);
  const createRequest = useCreateRequest();

  const allChws = chwQuery.data ?? [];

  const filteredChws = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) return allChws;
    return allChws.filter((chw) => {
      return (
        chw.name.toLowerCase().includes(query) ||
        chw.bio.toLowerCase().includes(query) ||
        chw.specializations.some((s) =>
          (verticalLabels[s as Vertical] ?? s).toLowerCase().includes(query),
        )
      );
    });
  }, [searchQuery, allChws]);

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
      try {
        await createRequest.mutateAsync({
          vertical: formData.vertical,
          urgency: formData.urgency,
          description: formData.description,
          preferredMode: formData.mode,
          estimatedUnits: 1,
        });
        showToast(`Request submitted! ${chwFirstName} will be in touch soon.`);
      } catch {
        showToast('Failed to submit request. Please try again.');
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

      {/* Filter tabs */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterTabsContent}
        style={styles.filterTabs}
      >
        {FILTER_TABS.map((tab) => {
          const isActive = activeFilter === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              onPress={() => setActiveFilter(tab.key)}
              style={[styles.filterTab, isActive && styles.filterTabActive]}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
            >
              <Text style={[styles.filterTabText, isActive && styles.filterTabTextActive]}>
                {tab.label}
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
