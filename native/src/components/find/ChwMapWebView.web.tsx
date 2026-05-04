/**
 * ChwMapWebView (web variant) — TEMPORARILY DISABLED.
 *
 * The Mapbox-powered map view has been stubbed out because the top-level
 * `import Map from 'react-map-gl'` and `import 'mapbox-gl/dist/mapbox-gl.css'`
 * statements were causing /member/find to blank on web:
 *
 *   1. Both imports run at module-load time, BEFORE the MAPBOX_TOKEN
 *      placeholder branch can short-circuit the render.
 *   2. mapbox-gl probes WebGL on load. On certain browser/PWA cache
 *      combinations (and under React 19 + Strict Mode double-mount), that
 *      probe throws synchronously.
 *   3. The thrown error tripped <ErrorBoundary>, whose fallback used
 *      <SafeAreaView> while sitting above <SafeAreaProvider> — that second
 *      throw nuked the entire React tree, leaving an empty `<div id="root">`.
 *
 * The ErrorBoundary cascade is fixed (see ErrorBoundary.tsx + App.tsx), but
 * the underlying Mapbox crash will still show "Something went wrong" until
 * the Mapbox integration is properly configured. Stubbing the map view
 * lets the CHW list render normally so members can still browse and
 * schedule sessions while we sort out the token deploy.
 *
 * TO RE-ENABLE:
 *   1. Set EXPO_PUBLIC_MAPBOX_TOKEN in Vercel (Settings → Env Variables)
 *      AND in native/.env for local dev. Use a public token (`pk.…`).
 *   2. Confirm URL restrictions on the Mapbox token allow
 *      https://joincompasschw.com/* and https://www.joincompasschw.com/*.
 *   3. Restore the original imports + render below (see TODO blocks).
 *   4. Test in prod with hard-refresh + service-worker unregister.
 *   5. Wrap the <Map> in its own <ErrorBoundary> with a list-only fallback
 *      so future Mapbox issues don't degrade the whole screen.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Map as MapIcon } from 'lucide-react-native';

import { colors } from '../../theme/colors';
import type { ChwBrowseItem } from '../../hooks/useApiQueries';

// TODO: restore these when Mapbox is re-enabled (see file header).
// import Map, { Marker, NavigationControl } from 'react-map-gl';
// import 'mapbox-gl/dist/mapbox-gl.css';
// import { useMemo } from 'react';
// import { Pressable } from 'react-native';
// import { zipToLatLng } from '../../utils/geocoding';
//
// const MAPBOX_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';
// const LA_CENTER = { latitude: 34.0522, longitude: -118.2437 };
// const LA_COUNTY_ZOOM = 9;

interface Props {
  chws: ChwBrowseItem[];
  onMarkerPress: (chw: ChwBrowseItem) => void;
}

/**
 * Placeholder card that replaces the live Mapbox view while the integration
 * is disabled. The CHW list below this component still renders the full
 * directory, so search + schedule remain fully functional.
 */
export function ChwMapWebView(_props: Props): React.JSX.Element {
  return (
    <View style={styles.placeholder} accessibilityRole="alert">
      <View style={styles.iconWrap}>
        <MapIcon color={colors.primary} size={20} />
      </View>
      <Text style={styles.title}>Map view coming soon</Text>
      <Text style={styles.sub}>
        Browse the full CHW directory below — every CHW is searchable and
        schedulable from the list.
      </Text>
    </View>
  );
}

const PLACEHOLDER_HEIGHT = 140;

const styles = StyleSheet.create({
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
