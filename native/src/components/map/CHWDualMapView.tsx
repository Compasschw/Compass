/**
 * CHWDualMapView — non-web stub.
 *
 * The real implementation lives in `CHWDualMapView.web.tsx` and is loaded
 * by Metro on the web platform via the `.web.tsx` extension. Native
 * platforms (iOS/Android) render AppleMaps/GoogleMaps directly inside
 * CHWMapScreen, so this stub returns null and is never rendered.
 */

import type { MapMemberPin, MapResourcePin } from '../../hooks/useApiQueries';

/** Which layers are visible — controlled by the segmented picker in CHWMapScreen. */
export type MapLayerFilter = 'members' | 'resources' | 'both';

export interface CHWDualMapViewProps {
  /** Layer visibility toggle from the segmented control above the map. */
  layerFilter: MapLayerFilter;
  /** Member pins (ZIP-centroid, PHI-minimised). */
  memberPins: MapMemberPin[];
  /** Resource pins (precise coordinates, not PHI). */
  resourcePins: MapResourcePin[];
  /** Called when the user taps a member pin. */
  onMemberPress: (pin: MapMemberPin) => void;
  /** Called when the user taps a resource pin. */
  onResourcePress: (pin: MapResourcePin) => void;
}

export function CHWDualMapView(_props: CHWDualMapViewProps): null {
  return null;
}
