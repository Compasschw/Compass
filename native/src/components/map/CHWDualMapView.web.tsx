/**
 * CHWDualMapView (web variant) — Mapbox-powered two-layer map for CHWMapScreen.
 *
 * Renders two independent pin layers on a single Mapbox map:
 *  1. Member layer — ZIP-centroid pins in brand sage green. PHI-minimised:
 *     display name is first initial only ("J."). Tapping opens the member
 *     bottom sheet → CHWMemberProfileScreen.
 *  2. Resource layer — precise-location pins coloured by category (housing=blue,
 *     food=amber, mental_health=violet, transportation=teal, healthcare=cyan, employment=indigo). Tapping
 *     opens the resource bottom sheet → "Get Directions" deep-link.
 *
 * The `layerFilter` prop (driven by the segmented control in CHWMapScreen)
 * hides/shows each layer without unmounting the map.
 *
 * SAFETY ARCHITECTURE
 * -------------------
 * Mirrors ChwMapWebView.web.tsx:
 *  1. Local `MapErrorBoundary` catches Mapbox render failures and shows a
 *     placeholder card. The page-level boundary in App.tsx is no longer the
 *     only safety net.
 *  2. `MAPBOX_TOKEN` guard renders the placeholder before `<Map>` is mounted
 *     when no token is configured.
 *
 * TOKEN CONFIG
 * ------------
 * Same token as ChwMapWebView — `EXPO_PUBLIC_MAPBOX_TOKEN` in `native/.env`.
 * On Vercel, the prod URL-restricted token should be used.
 */

import React, {
  Component,
  useMemo,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Map, { Marker, NavigationControl } from 'react-map-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { Map as MapIcon } from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { VERTICAL_COLOR } from '../../lib/verticals';
import type { MapMemberPin, MapResourcePin } from '../../hooks/useApiQueries';
import type { CHWDualMapViewProps } from './CHWDualMapView';

const MAPBOX_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';

/** LA County center — same default camera as ChwMapWebView. */
const LA_CENTER = { latitude: 34.0522, longitude: -118.2437 } as const;
const LA_COUNTY_ZOOM = 10;

/**
 * Member pins render in brand sage green regardless of category.
 * Category colour is shown inside the bottom sheet via category pills.
 */
const MEMBER_PIN_COLOR = colors.primary; // '#3D5A3E'

/**
 * Resolve the pin background colour for a resource by category.
 * Falls back to compassSage for unknown categories.
 */
function resourcePinColor(category: string): string {
  const known = VERTICAL_COLOR[category as keyof typeof VERTICAL_COLOR];
  return known ?? colors.compassSage;
}

// ─── Placeholder card ─────────────────────────────────────────────────────────

interface PlaceholderProps {
  afterCrash?: boolean;
}

function Placeholder({ afterCrash = false }: PlaceholderProps): React.JSX.Element {
  return (
    <View style={styles.placeholder} accessibilityRole="alert">
      <View style={styles.iconWrap}>
        <MapIcon color={colors.primary} size={20} />
      </View>
      <Text style={styles.title}>
        {afterCrash ? 'Map view unavailable' : 'Map view coming soon'}
      </Text>
      <Text style={styles.sub}>
        {afterCrash
          ? 'The map failed to load. Check the console for details.'
          : 'Configure EXPO_PUBLIC_MAPBOX_TOKEN to enable the map.'}
      </Text>
    </View>
  );
}

// ─── Local error boundary ─────────────────────────────────────────────────────

interface BoundaryState {
  hasError: boolean;
}

class MapErrorBoundary extends Component<
  { children: ReactNode },
  BoundaryState
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[CHWDualMapView] Mapbox render failed — falling back to placeholder.', {
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return <Placeholder afterCrash />;
    }
    return this.props.children;
  }
}

// ─── Member pin marker ────────────────────────────────────────────────────────

interface MemberMarkerProps {
  pin: MapMemberPin;
  onPress: (pin: MapMemberPin) => void;
}

function MemberMarker({ pin, onPress }: MemberMarkerProps): React.JSX.Element {
  return (
    <Marker
      key={pin.id}
      latitude={pin.latitude}
      longitude={pin.longitude}
      anchor="center"
      onClick={(e) => {
        e.originalEvent.stopPropagation();
        onPress(pin);
      }}
    >
      <Pressable
        style={[memberStyles.pin, { backgroundColor: MEMBER_PIN_COLOR }]}
        accessibilityRole="button"
        accessibilityLabel={`Member ${pin.displayName} on map`}
      >
        <Text style={memberStyles.initial}>{pin.displayName}</Text>
        {pin.sessionCount > 1 && (
          <View style={memberStyles.badge}>
            <Text style={memberStyles.badgeText}>
              {pin.sessionCount > 9 ? '9+' : String(pin.sessionCount)}
            </Text>
          </View>
        )}
      </Pressable>
    </Marker>
  );
}

const memberStyles = StyleSheet.create({
  pin: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2.5,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer' as unknown as undefined,
    // Web-only drop shadow.
    ...(typeof window !== 'undefined' && {
      boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
    }),
  },
  initial: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: '#FFFFFF',
    lineHeight: 16,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.compassGold,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 2,
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
  },
  badgeText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 9,
    color: '#FFFFFF',
    lineHeight: 12,
  },
});

// ─── Resource pin marker ──────────────────────────────────────────────────────

interface ResourceMarkerProps {
  pin: MapResourcePin;
  onPress: (pin: MapResourcePin) => void;
}

function ResourceMarker({ pin, onPress }: ResourceMarkerProps): React.JSX.Element {
  const bgColor = resourcePinColor(pin.category);

  return (
    <Marker
      key={pin.id}
      latitude={pin.latitude}
      longitude={pin.longitude}
      anchor="bottom"
      onClick={(e) => {
        e.originalEvent.stopPropagation();
        onPress(pin);
      }}
    >
      <Pressable
        style={[resourceStyles.pin, { backgroundColor: bgColor }]}
        accessibilityRole="button"
        accessibilityLabel={`${pin.name} on map`}
      >
        {/* Teardrop tail */}
        <View style={[resourceStyles.tail, { borderTopColor: bgColor }]} />
      </Pressable>
    </Marker>
  );
}

const resourceStyles = StyleSheet.create({
  pin: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: '#FFFFFF',
    cursor: 'pointer' as unknown as undefined,
    ...(typeof window !== 'undefined' && {
      boxShadow: '0 2px 6px rgba(0,0,0,0.20)',
    }),
  },
  tail: {
    position: 'absolute',
    bottom: -6,
    left: 3,
    borderLeftWidth: 4,
    borderRightWidth: 4,
    borderTopWidth: 6,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
});

// ─── Live Mapbox map ──────────────────────────────────────────────────────────

function LiveMap({
  layerFilter,
  memberPins,
  resourcePins,
  onMemberPress,
  onResourcePress,
}: CHWDualMapViewProps): React.JSX.Element {
  const showMembers = layerFilter === 'members' || layerFilter === 'both';
  const showResources = layerFilter === 'resources' || layerFilter === 'both';

  // Stable pin references — only recompute if the underlying data arrays change.
  const visibleMembers = useMemo(
    () => (showMembers ? memberPins : []),
    [showMembers, memberPins],
  );
  const visibleResources = useMemo(
    () => (showResources ? resourcePins : []),
    [showResources, resourcePins],
  );

  return (
    <View style={styles.container}>
      <Map
        mapboxAccessToken={MAPBOX_TOKEN}
        initialViewState={{
          latitude: LA_CENTER.latitude,
          longitude: LA_CENTER.longitude,
          zoom: LA_COUNTY_ZOOM,
        }}
        mapStyle="mapbox://styles/mapbox/streets-v12"
        style={{ width: '100%', height: '100%' }}
      >
        <NavigationControl position="top-right" showCompass={false} />

        {/* Member layer — sage green pins, ZIP-centroid */}
        {visibleMembers.map((pin) => (
          <MemberMarker key={pin.id} pin={pin} onPress={onMemberPress} />
        ))}

        {/* Resource layer — category-coloured teardrop pins */}
        {visibleResources.map((pin) => (
          <ResourceMarker key={pin.id} pin={pin} onPress={onResourcePress} />
        ))}
      </Map>
    </View>
  );
}

// ─── Public entry — token gate + boundary ─────────────────────────────────────

export function CHWDualMapView(props: CHWDualMapViewProps): React.JSX.Element {
  if (!MAPBOX_TOKEN) {
    return <Placeholder />;
  }

  return (
    <MapErrorBoundary>
      <LiveMap {...props} />
    </MapErrorBoundary>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const PLACEHOLDER_HEIGHT = 140;

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  placeholder: {
    height: PLACEHOLDER_HEIGHT,
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 8,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: `${colors.primary}18`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: colors.foreground,
  },
  sub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: colors.mutedForeground,
    textAlign: 'center',
    lineHeight: 18,
  },
});
