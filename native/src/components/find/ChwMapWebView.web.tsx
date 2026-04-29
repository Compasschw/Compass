/**
 * ChwMapWebView — Mapbox-powered map view for the Find CHW screen on web.
 *
 * Pinned-CHW interactions match the native AppleMaps/GoogleMaps branch
 * already in MemberFindScreen — tapping a pin opens the schedule modal
 * for that CHW.
 *
 * Token: requires `EXPO_PUBLIC_MAPBOX_TOKEN` in the .env file. Without
 * it, the component renders a friendly setup placeholder instead of an
 * empty container, so a missing token is obvious in dev.
 *
 * Mapbox free tier: 50K monthly map loads. Get a token at:
 *   https://account.mapbox.com/access-tokens
 */

import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Map, { Marker, NavigationControl } from 'react-map-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

import { colors } from '../../theme/colors';
import { zipToLatLng } from '../../utils/geocoding';
import type { ChwBrowseItem } from '../../hooks/useApiQueries';

const MAPBOX_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';

// Same defaults as the native AppleMaps/GoogleMaps view.
const LA_CENTER = { latitude: 34.0522, longitude: -118.2437 };
const LA_COUNTY_ZOOM = 9;

interface Props {
  chws: ChwBrowseItem[];
  onMarkerPress: (chw: ChwBrowseItem) => void;
}

export function ChwMapWebView({ chws, onMarkerPress }: Props): React.JSX.Element {
  const markers = useMemo(() => {
    return chws.flatMap((chw) => {
      const coords = zipToLatLng(chw.zipCode);
      if (!coords) return [];
      return [{ chw, lat: coords.lat, lng: coords.lng }];
    });
  }, [chws]);

  if (!MAPBOX_TOKEN) {
    return (
      <View style={styles.placeholder} accessibilityRole="alert">
        <Text style={styles.placeholderTitle}>Map view needs setup</Text>
        <Text style={styles.placeholderSub}>
          Add{' '}
          <Text style={styles.placeholderCode}>EXPO_PUBLIC_MAPBOX_TOKEN</Text>{' '}
          to <Text style={styles.placeholderCode}>native/.env</Text> and restart
          the dev server. Free Mapbox tokens at{' '}
          <Text style={styles.placeholderCode}>account.mapbox.com</Text>.
        </Text>
      </View>
    );
  }

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

const MAP_HEIGHT = 320;
const PLACEHOLDER_HEIGHT = 160;

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
    gap: 6,
  },
  placeholderTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: colors.foreground,
  },
  placeholderSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: colors.mutedForeground,
    textAlign: 'center',
    lineHeight: 18,
  },
  placeholderCode: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    color: colors.foreground,
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
