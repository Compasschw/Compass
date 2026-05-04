/**
 * ChwMapWebView (web variant) — Mapbox-powered CHW map for /member/find.
 *
 * Renders a Mapbox map with one pin per CHW whose ZIP resolves to a
 * coordinate, mirroring the native AppleMaps/GoogleMaps branch in
 * MemberFindScreen. Tapping a pin opens the schedule modal for that CHW.
 *
 * SAFETY ARCHITECTURE
 * -------------------
 * The original version of this file blanked /member/find when Mapbox
 * threw at module-load time (WebGL probe under React 19 Strict Mode +
 * cached PWA bundles — see PR #32). Two layers protect against a repeat:
 *
 *  1. The map render is wrapped in `<MapErrorBoundary>`, a small class
 *     boundary local to this file. If `<Map>` throws on mount or
 *     re-render, the boundary swaps in the placeholder card and the
 *     CHW directory list below keeps working. The page-level
 *     <ErrorBoundary> in App.tsx is no longer the only safety net.
 *
 *  2. The `MAPBOX_TOKEN` check renders the placeholder *before* the map
 *     mounts when no token is configured. mapbox-gl + react-map-gl
 *     module-level imports still execute at bundle parse time, but
 *     they're declarative and don't trigger WebGL on import — only on
 *     `<Map>` construction.
 *
 * TOKEN CONFIG
 * ------------
 * - Local dev: `EXPO_PUBLIC_MAPBOX_TOKEN` in `native/.env` (default
 *   unrestricted token, works on localhost).
 * - Production: same env var on Vercel, scoped to a separate
 *   URL-restricted prod token (e.g. `joincompasschw-web-prod`) so a
 *   leaked bundle can't be used from any other origin.
 */

import React, { Component, useMemo, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Map, { Marker, NavigationControl } from 'react-map-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { Map as MapIcon } from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { zipToLatLng } from '../../utils/geocoding';
import type { ChwBrowseItem } from '../../hooks/useApiQueries';

const MAPBOX_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';

// LA County center — same default camera as the native AppleMaps/GoogleMaps view.
const LA_CENTER = { latitude: 34.0522, longitude: -118.2437 };
const LA_COUNTY_ZOOM = 9;

interface Props {
  chws: ChwBrowseItem[];
  onMarkerPress: (chw: ChwBrowseItem) => void;
}

// ─── Placeholder card (shown for: no token, or map crash) ─────────────────────

interface PlaceholderProps {
  /** When true, the placeholder is the fallback after a Mapbox crash —
   *  show a slightly different message so we know to look at logs. */
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
          ? 'The map failed to load. Browse the full CHW directory below.'
          : 'Browse the full CHW directory below — every CHW is searchable and schedulable from the list.'}
      </Text>
    </View>
  );
}

// ─── Local ErrorBoundary so a Mapbox crash doesn't degrade the whole page ─────

interface BoundaryProps {
  children: ReactNode;
}

interface BoundaryState {
  hasError: boolean;
}

class MapErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ChwMapWebView] Mapbox render failed — falling back to placeholder.', {
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

// ─── Live Mapbox map ──────────────────────────────────────────────────────────

function LiveMap({ chws, onMarkerPress }: Props): React.JSX.Element {
  const markers = useMemo(
    () =>
      chws.flatMap((chw) => {
        const coords = zipToLatLng(chw.zipCode);
        if (!coords) return [];
        return [{ chw, lat: coords.lat, lng: coords.lng }];
      }),
    [chws],
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
        {markers.map(({ chw, lat, lng }) => (
          <Marker
            key={chw.id}
            latitude={lat}
            longitude={lng}
            anchor="bottom"
            onClick={(e) => {
              // Stop the click from also firing the underlying map click handler.
              e.originalEvent.stopPropagation();
              onMarkerPress(chw);
            }}
          >
            <Pressable
              style={styles.marker}
              accessibilityRole="button"
              accessibilityLabel={`${chw.name} on map`}
            >
              <View style={styles.markerDot} />
            </Pressable>
          </Marker>
        ))}
      </Map>
    </View>
  );
}

// ─── Public entry — token gate + boundary ─────────────────────────────────────

export function ChwMapWebView({ chws, onMarkerPress }: Props): React.JSX.Element {
  if (!MAPBOX_TOKEN) {
    return <Placeholder />;
  }

  return (
    <MapErrorBoundary>
      <LiveMap chws={chws} onMarkerPress={onMarkerPress} />
    </MapErrorBoundary>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const MAP_HEIGHT = 320;
const PLACEHOLDER_HEIGHT = 140;

const styles = StyleSheet.create({
  container: {
    height: MAP_HEIGHT,
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#FFFFFF',
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
  marker: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primary,
    borderWidth: 2,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer' as unknown as undefined,
  },
  markerDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FFFFFF',
  },
});
