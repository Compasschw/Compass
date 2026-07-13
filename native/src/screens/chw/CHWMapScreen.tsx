/**
 * CHWMapScreen — dual-layer map for Community Health Workers.
 *
 * Displays two pin layers on a Mapbox map:
 *  - Members layer: ZIP-centroid pins (PHI-safe) for members the CHW has had
 *    at least one session with. Tapping opens a bottom sheet → "Open Profile".
 *  - Resources layer: precise-location pins for LA-area community resources
 *    by category (utilities, food, mental_health, transportation, healthcare,
 *    employment; 'housing' also still renders for legacy-categorized
 *    resources — see Epic C5). Tapping opens a bottom sheet → "Get
 *    Directions" (opens native maps app).
 *
 * A segmented control at the top lets the CHW toggle: Members / Resources / Both.
 *
 * PHI HANDLING
 * ------------
 * - Member display names are first-initial-only ("J.") server-side.
 * - Member pins are ZIP-centroid coordinates — not precise addresses.
 * - Tapping a member pin opens a brief summary sheet. The full profile
 *   (retrieved via useChwMemberProfile with its HIPAA-gated endpoint) is
 *   loaded only after the CHW taps "Open Profile".
 * - The Linking.openURL call for directions only passes resource coordinates —
 *   never member coordinates.
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { CompositeNavigationProp } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  ExternalLink,
  MapPin,
  User,
  X,
} from 'lucide-react-native';

import { colors } from '../../theme/colors';
import {
  useChwMapData,
  type MapMemberPin,
  type MapResourcePin,
} from '../../hooks/useApiQueries';
import { verticalLabel, VERTICAL_COLOR } from '../../lib/verticals';
import { ErrorState } from '../../components/shared/ErrorState';
import { CHWDualMapView, type MapLayerFilter } from '../../components/map/CHWDualMapView';
import type { CHWTabParamList, CHWSessionsStackParamList } from '../../navigation/CHWTabNavigator';

// ─── Navigation types ─────────────────────────────────────────────────────────

type CHWMapNavigationProp = CompositeNavigationProp<
  BottomTabNavigationProp<CHWTabParamList, 'Map'>,
  NativeStackNavigationProp<CHWSessionsStackParamList>
>;

// ─── Layer toggle ─────────────────────────────────────────────────────────────

interface SegmentedControlProps {
  value: MapLayerFilter;
  onChange: (value: MapLayerFilter) => void;
}

const LAYER_OPTIONS: { key: MapLayerFilter; label: string }[] = [
  { key: 'members', label: 'Members' },
  { key: 'both', label: 'Both' },
  { key: 'resources', label: 'Resources' },
];

function LayerSegmentedControl({
  value,
  onChange,
}: SegmentedControlProps): React.JSX.Element {
  return (
    <View
      style={segmentStyles.track}
      accessibilityRole="radiogroup"
      accessibilityLabel="Map layer selection"
    >
      {LAYER_OPTIONS.map((opt) => {
        const isSelected = value === opt.key;
        return (
          <TouchableOpacity
            key={opt.key}
            onPress={() => onChange(opt.key)}
            style={[segmentStyles.segment, isSelected && segmentStyles.segmentActive]}
            accessibilityRole="radio"
            accessibilityState={{ selected: isSelected }}
            accessibilityLabel={`Show ${opt.label}`}
          >
            <Text
              style={[
                segmentStyles.label,
                isSelected && segmentStyles.labelActive,
              ]}
            >
              {opt.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const segmentStyles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    backgroundColor: colors.muted,
    borderRadius: 10,
    padding: 3,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  segment: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
  },
  segmentActive: {
    backgroundColor: '#FFFFFF',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 3,
      },
      android: { elevation: 2 },
    }),
  },
  label: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: colors.mutedForeground,
  },
  labelActive: {
    color: colors.foreground,
  },
});

// ─── Member bottom sheet ──────────────────────────────────────────────────────

interface MemberSheetProps {
  pin: MapMemberPin;
  onClose: () => void;
  onOpenProfile: (memberId: string) => void;
}

function MemberSheet({
  pin,
  onClose,
  onOpenProfile,
}: MemberSheetProps): React.JSX.Element {
  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={sheetStyles.backdrop}>
        <View style={sheetStyles.sheet}>
          {/* Handle */}
          <View style={sheetStyles.handle} />

          {/* Header */}
          <View style={sheetStyles.header}>
            <View style={sheetStyles.memberAvatar}>
              <User color={colors.primaryForeground} size={18} />
            </View>
            <View style={sheetStyles.headerText}>
              <Text style={sheetStyles.memberTitle}>Member {pin.displayName}</Text>
              <Text style={sheetStyles.memberSub}>ZIP {pin.zipCode}</Text>
            </View>
            <TouchableOpacity
              onPress={onClose}
              style={sheetStyles.closeBtn}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={8}
            >
              <X color={colors.mutedForeground} size={18} />
            </TouchableOpacity>
          </View>

          {/* Stats row */}
          <View style={sheetStyles.statsRow}>
            <View style={sheetStyles.stat}>
              <Text style={sheetStyles.statValue}>{pin.sessionCount}</Text>
              <Text style={sheetStyles.statLabel}>
                {pin.sessionCount === 1 ? 'Session' : 'Sessions'}
              </Text>
            </View>
            {pin.primaryCategories.length > 0 && (
              <View style={sheetStyles.stat}>
                <View style={sheetStyles.categoryPills}>
                  {pin.primaryCategories.slice(0, 2).map((cat) => (
                    <View
                      key={cat}
                      style={[
                        sheetStyles.categoryPill,
                        {
                          backgroundColor:
                            `${VERTICAL_COLOR[cat as keyof typeof VERTICAL_COLOR] ?? colors.compassSage}18`,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          sheetStyles.categoryPillText,
                          {
                            color:
                              VERTICAL_COLOR[cat as keyof typeof VERTICAL_COLOR] ??
                              colors.compassSage,
                          },
                        ]}
                      >
                        {verticalLabel(cat)}
                      </Text>
                    </View>
                  ))}
                </View>
                <Text style={sheetStyles.statLabel}>Needs</Text>
              </View>
            )}
          </View>

          {/* PHI notice */}
          <Text style={sheetStyles.phiNotice}>
            Location shown at ZIP-code level only — not the member's precise address.
          </Text>

          {/* Actions */}
          <TouchableOpacity
            style={sheetStyles.primaryBtn}
            onPress={() => onOpenProfile(pin.id)}
            accessibilityRole="button"
            accessibilityLabel="Open member profile"
          >
            <Text style={sheetStyles.primaryBtnText}>Open Profile</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ─── Resource bottom sheet ────────────────────────────────────────────────────

interface ResourceSheetProps {
  pin: MapResourcePin;
  onClose: () => void;
}

/**
 * Opens the device's native maps app with a search for the resource address.
 * Uses a deep-link scheme that works on both iOS (Apple Maps) and Android (Google Maps).
 * Falls back to a Google Maps web URL on web.
 */
async function openDirections(resource: MapResourcePin): Promise<void> {
  const encodedAddress = encodeURIComponent(resource.address);
  const encodedName = encodeURIComponent(resource.name);

  // iOS: maps:// opens Apple Maps. Android: geo: opens the default maps app.
  // Web: falls back to google.com/maps.
  const nativeUrl =
    Platform.OS === 'ios'
      ? `maps://?q=${encodedName}&ll=${resource.latitude},${resource.longitude}`
      : `geo:${resource.latitude},${resource.longitude}?q=${encodedAddress}`;

  const webFallbackUrl = `https://www.google.com/maps/search/?api=1&query=${encodedAddress}`;

  try {
    const canOpen = Platform.OS === 'web'
      ? false
      : await Linking.canOpenURL(nativeUrl);

    if (canOpen) {
      await Linking.openURL(nativeUrl);
    } else {
      await Linking.openURL(webFallbackUrl);
    }
  } catch {
    // Last resort — always openable.
    await Linking.openURL(webFallbackUrl);
  }
}

function ResourceSheet({
  pin,
  onClose,
}: ResourceSheetProps): React.JSX.Element {
  const categoryColor =
    VERTICAL_COLOR[pin.category as keyof typeof VERTICAL_COLOR] ?? colors.compassSage;

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={sheetStyles.backdrop}>
        <View style={sheetStyles.sheet}>
          {/* Handle */}
          <View style={sheetStyles.handle} />

          {/* Header */}
          <View style={sheetStyles.header}>
            <View style={[sheetStyles.resourceDot, { backgroundColor: categoryColor }]} />
            <View style={sheetStyles.headerText}>
              <Text style={sheetStyles.resourceTitle} numberOfLines={2}>
                {pin.name}
              </Text>
              <View
                style={[
                  sheetStyles.categoryChip,
                  { backgroundColor: `${categoryColor}18` },
                ]}
              >
                <Text style={[sheetStyles.categoryChipText, { color: categoryColor }]}>
                  {verticalLabel(pin.category)}
                </Text>
              </View>
            </View>
            <TouchableOpacity
              onPress={onClose}
              style={sheetStyles.closeBtn}
              accessibilityRole="button"
              accessibilityLabel="Close"
              hitSlop={8}
            >
              <X color={colors.mutedForeground} size={18} />
            </TouchableOpacity>
          </View>

          {/* Address */}
          <View style={sheetStyles.addressRow}>
            <MapPin color={colors.mutedForeground} size={14} />
            <Text style={sheetStyles.addressText}>{pin.address}</Text>
          </View>

          {/* Get Directions */}
          <TouchableOpacity
            style={sheetStyles.directionsBtn}
            onPress={() => void openDirections(pin)}
            accessibilityRole="link"
            accessibilityLabel={`Get directions to ${pin.name}`}
          >
            <ExternalLink color={colors.primaryForeground} size={16} />
            <Text style={sheetStyles.directionsBtnText}>Get Directions</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ─── Shared sheet styles ──────────────────────────────────────────────────────

const sheetStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: Platform.OS === 'ios' ? 32 : 20,
    paddingHorizontal: 20,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -4 },
        shadowOpacity: 0.1,
        shadowRadius: 16,
      },
      android: { elevation: 16 },
    }),
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 16,
  },
  memberAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  resourceDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    marginTop: 4,
    flexShrink: 0,
  },
  headerText: {
    flex: 1,
    gap: 4,
  },
  memberTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    color: colors.foreground,
    lineHeight: 22,
  },
  memberSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: colors.mutedForeground,
  },
  resourceTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    color: colors.foreground,
    lineHeight: 22,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 24,
    marginBottom: 12,
  },
  stat: {
    gap: 4,
  },
  statValue: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 22,
    color: colors.foreground,
  },
  statLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: colors.mutedForeground,
  },
  categoryPills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  categoryPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
  },
  categoryPillText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
  },
  categoryChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 100,
  },
  categoryChipText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
  },
  addressRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 16,
  },
  addressText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: colors.mutedForeground,
    flex: 1,
    lineHeight: 18,
  },
  phiNotice: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: colors.mutedForeground,
    fontStyle: 'italic',
    marginBottom: 16,
    lineHeight: 16,
  },
  primaryBtn: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  primaryBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 15,
    color: '#FFFFFF',
  },
  directionsBtn: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginTop: 4,
  },
  directionsBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 15,
    color: '#FFFFFF',
  },
});

// ─── Native dual-layer map (iOS / Android) ─────────────────────────────────────

/**
 * Native map sub-component — renders AppleMaps on iOS, GoogleMaps on Android.
 * Accepts a `layerFilter` to show/hide member and resource pins.
 *
 * Uses the same defensive require() pattern as MemberFindScreen to avoid Metro
 * bundling expo-maps on web. On web, CHWDualMapView.web.tsx takes over.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = React.ComponentType<any>;

const AppleMapsView: AnyComponent | null = (() => {
  if (Platform.OS !== 'ios') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-member-access
    return require('expo-maps').AppleMaps.View as AnyComponent;
  } catch {
    return null;
  }
})();

const GoogleMapsView: AnyComponent | null = (() => {
  if (Platform.OS !== 'android') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-member-access
    return require('expo-maps').GoogleMaps.View as AnyComponent;
  } catch {
    return null;
  }
})();

const LA_CENTER = { latitude: 34.0522, longitude: -118.2437 } as const;
const LA_COUNTY_ZOOM = 10;

interface NativeDualMapProps {
  layerFilter: MapLayerFilter;
  memberPins: MapMemberPin[];
  resourcePins: MapResourcePin[];
  onMemberPress: (pin: MapMemberPin) => void;
  onResourcePress: (pin: MapResourcePin) => void;
}

function NativeDualMap({
  layerFilter,
  memberPins,
  resourcePins,
  onMemberPress,
  onResourcePress,
}: NativeDualMapProps): React.JSX.Element | null {
  const showMembers = layerFilter === 'members' || layerFilter === 'both';
  const showResources = layerFilter === 'resources' || layerFilter === 'both';

  // Build a fast lookup from marker id → source pin so the onMarkerClick
  // callback can locate the full pin object without scanning arrays.
  const memberById = new Map<string, MapMemberPin>(
    memberPins.map((p) => [p.id, p]),
  );
  const resourceById = new Map<string, MapResourcePin>(
    resourcePins.map((p) => [p.id, p]),
  );

  const markers = [
    ...(showMembers ? memberPins.map((p) => ({
      id: `m:${p.id}`,
      coordinates: { latitude: p.latitude, longitude: p.longitude },
      title: `Member ${p.displayName}`,
    })) : []),
    ...(showResources ? resourcePins.map((p) => ({
      id: `r:${p.id}`,
      coordinates: { latitude: p.latitude, longitude: p.longitude },
      title: p.name,
    })) : []),
  ];

  function handleMarkerClick(marker: { id?: string }): void {
    if (!marker.id) return;
    if (marker.id.startsWith('m:')) {
      const pin = memberById.get(marker.id.slice(2));
      if (pin) onMemberPress(pin);
    } else if (marker.id.startsWith('r:')) {
      const pin = resourceById.get(marker.id.slice(2));
      if (pin) onResourcePress(pin);
    }
  }

  if (Platform.OS === 'ios' && AppleMapsView) {
    return (
      <AppleMapsView
        style={nativeMapStyles.map}
        cameraPosition={{ coordinates: LA_CENTER, zoom: LA_COUNTY_ZOOM }}
        markers={markers}
        onMarkerClick={handleMarkerClick}
      />
    );
  }

  if (Platform.OS === 'android' && GoogleMapsView) {
    return (
      <GoogleMapsView
        style={nativeMapStyles.map}
        cameraPosition={{ coordinates: LA_CENTER, zoom: LA_COUNTY_ZOOM }}
        markers={markers}
        onMarkerClick={handleMarkerClick}
      />
    );
  }

  return null;
}

const nativeMapStyles = StyleSheet.create({
  map: {
    flex: 1,
  },
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export function CHWMapScreen(): React.JSX.Element {
  const navigation = useNavigation<CHWMapNavigationProp>();
  const [layerFilter, setLayerFilter] = useState<MapLayerFilter>('both');
  const [selectedMember, setSelectedMember] = useState<MapMemberPin | null>(null);
  const [selectedResource, setSelectedResource] = useState<MapResourcePin | null>(null);

  const mapQuery = useChwMapData();

  const memberPins = mapQuery.data?.members ?? [];
  const resourcePins = mapQuery.data?.resources ?? [];

  const handleMemberPress = useCallback((pin: MapMemberPin) => {
    setSelectedResource(null);
    setSelectedMember(pin);
  }, []);

  const handleResourcePress = useCallback((pin: MapResourcePin) => {
    setSelectedMember(null);
    setSelectedResource(pin);
  }, []);

  const handleOpenMemberProfile = useCallback(
    (memberId: string) => {
      setSelectedMember(null);
      try {
        // Navigate to the MemberProfile screen inside the SessionsStack.
        // The parallel agent (compass-wt-member-profile) registers this route.
        // If it doesn't exist yet in this worktree, the navigation call will
        // throw at runtime — the catch block logs it and shows a toast.
        (navigation as any).navigate('SessionsStack', {
          screen: 'MemberProfile',
          // Epic S: origin so the profile's web back-link reads "Back to
          // Map" and returns to this screen.
          params: { memberId, backLabel: 'Map', backTo: 'Map' },
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          '[CHWMapScreen] CHWMemberProfileScreen not yet reachable from this navigator — ' +
          'merge compass-wt-member-profile to enable this navigation. memberId=' + memberId,
          err,
        );
      }
    },
    [navigation],
  );

  const handleCloseMemberSheet = useCallback(() => setSelectedMember(null), []);
  const handleCloseResourceSheet = useCallback(() => setSelectedResource(null), []);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.background} />

      {/* Page header */}
      <View style={styles.pageWrap}>
        <View style={styles.pageHeader}>
          <Text style={styles.pageTitle}>Member Map</Text>
          <Text style={styles.pageSub}>
            {mapQuery.isLoading
              ? 'Loading...'
              : `${memberPins.length} member${memberPins.length !== 1 ? 's' : ''} · ${resourcePins.length} resource${resourcePins.length !== 1 ? 's' : ''}`}
          </Text>
        </View>

        {/* Layer segmented control */}
        <LayerSegmentedControl value={layerFilter} onChange={setLayerFilter} />

        {/* Map fill area */}
        <View style={styles.mapArea}>
          {mapQuery.isLoading ? (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator color={colors.primary} size="large" />
              <Text style={styles.loadingText}>Loading map data…</Text>
            </View>
          ) : mapQuery.error ? (
            <ScrollView>
              <ErrorState
                message="Could not load map data. Please try again."
                onRetry={() => void mapQuery.refetch()}
              />
            </ScrollView>
          ) : Platform.OS === 'web' ? (
            <CHWDualMapView
              layerFilter={layerFilter}
              memberPins={memberPins}
              resourcePins={resourcePins}
              onMemberPress={handleMemberPress}
              onResourcePress={handleResourcePress}
            />
          ) : (
            <NativeDualMap
              layerFilter={layerFilter}
              memberPins={memberPins}
              resourcePins={resourcePins}
              onMemberPress={handleMemberPress}
              onResourcePress={handleResourcePress}
            />
          )}
        </View>
      </View>

      {/* Legend — visible when both layers are shown */}
      {layerFilter === 'both' && !mapQuery.isLoading && !mapQuery.error && (
        <View style={styles.legend}>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: colors.primary }]} />
            <Text style={styles.legendLabel}>Members (ZIP area)</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#3B82F6' }]} />
            <Text style={styles.legendLabel}>Housing</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#F59E0B' }]} />
            <Text style={styles.legendLabel}>Food</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#8B5CF6' }]} />
            <Text style={styles.legendLabel}>Mental Health</Text>
          </View>
        </View>
      )}

      {/* Bottom sheets */}
      {selectedMember ? (
        <MemberSheet
          pin={selectedMember}
          onClose={handleCloseMemberSheet}
          onOpenProfile={handleOpenMemberProfile}
        />
      ) : null}

      {selectedResource ? (
        <ResourceSheet pin={selectedResource} onClose={handleCloseResourceSheet} />
      ) : null}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  pageWrap: {
    flex: 1,
    width: '100%',
    maxWidth: 960,
    alignSelf: 'center',
  },
  pageHeader: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
  },
  pageTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    lineHeight: 30,
    color: colors.foreground,
  },
  pageSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: colors.mutedForeground,
    marginTop: 2,
  },
  mapArea: {
    flex: 1,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#FFFFFF',
  },
  loadingOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: colors.mutedForeground,
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 12,
    paddingTop: 4,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  legendLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: colors.mutedForeground,
  },
});
