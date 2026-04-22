/**
 * Rough zip-code → (lat, lng) lookup for the California service area we're
 * piloting in. Used as a stand-in until we wire a real geocoder (Google
 * Geocoding API, Mapbox, or Nominatim) into the Find-CHW flow.
 *
 * Coverage: LA County core (South LA, Southeast LA, Downtown, East LA,
 * San Fernando Valley core) + a few Orange County + Inland Empire
 * neighborhoods common in Medi-Cal managed care. Add more entries as
 * pilot coverage expands.
 *
 * When we move to a real geocoder, change the signature of `coordsForZip`
 * to async and call the API; callers already await it.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const ZIP_TO_LATLNG: Record<string, LatLng> = {
  // South LA / Southeast LA
  '90001': { lat: 33.9730, lng: -118.2487 },
  '90002': { lat: 33.9490, lng: -118.2468 },
  '90003': { lat: 33.9653, lng: -118.2731 },
  '90011': { lat: 34.0072, lng: -118.2587 },
  '90044': { lat: 33.9533, lng: -118.2913 },
  // Downtown / Historic Core
  '90012': { lat: 34.0615, lng: -118.2390 },
  '90013': { lat: 34.0430, lng: -118.2438 },
  '90014': { lat: 34.0454, lng: -118.2521 },
  '90015': { lat: 34.0410, lng: -118.2634 },
  '90021': { lat: 34.0348, lng: -118.2390 },
  // East LA / Boyle Heights
  '90022': { lat: 34.0227, lng: -118.1555 },
  '90023': { lat: 34.0240, lng: -118.1998 },
  '90033': { lat: 34.0496, lng: -118.2100 },
  '90063': { lat: 34.0464, lng: -118.1704 },
  // San Fernando Valley core
  '91331': { lat: 34.2569, lng: -118.4174 },
  '91340': { lat: 34.2832, lng: -118.4462 },
  '91342': { lat: 34.3024, lng: -118.4338 },
  '91343': { lat: 34.2313, lng: -118.4892 },
  '91405': { lat: 34.1970, lng: -118.4472 },
  '91411': { lat: 34.1856, lng: -118.4543 },
  // Hollywood / Koreatown
  '90028': { lat: 34.0979, lng: -118.3316 },
  '90029': { lat: 34.0900, lng: -118.2938 },
  '90038': { lat: 34.0879, lng: -118.3265 },
  '90004': { lat: 34.0764, lng: -118.3086 },
  '90005': { lat: 34.0580, lng: -118.3078 },
  '90006': { lat: 34.0494, lng: -118.2948 },
  // Orange County (Santa Ana / Anaheim)
  '92701': { lat: 33.7456, lng: -117.8677 },
  '92703': { lat: 33.7403, lng: -117.9167 },
  '92704': { lat: 33.7120, lng: -117.9113 },
  '92801': { lat: 33.8420, lng: -117.9544 },
  '92802': { lat: 33.8038, lng: -117.9162 },
  // Inland Empire (Riverside / San Bernardino highlights)
  '92501': { lat: 33.9873, lng: -117.3731 },
  '92503': { lat: 33.9141, lng: -117.4498 },
  '92410': { lat: 34.0938, lng: -117.3011 },
};

/**
 * Centroid of LA County — safe default when we have no user location and
 * no known zip (e.g. a brand-new member hasn't set zipCode yet).
 */
export const DEFAULT_COORDS: LatLng = { lat: 34.0522, lng: -118.2437 };

/**
 * Look up approximate lat/lng for a zip code. Returns the LA centroid when
 * the zip isn't in our table so callers don't have to null-check.
 */
export function coordsForZip(zip: string | null | undefined): LatLng {
  if (!zip) return DEFAULT_COORDS;
  const trimmed = zip.trim();
  return ZIP_TO_LATLNG[trimmed] ?? DEFAULT_COORDS;
}

/**
 * Whether we have a real entry for this zip (vs. defaulting to LA centroid).
 * Useful for deciding whether to render a specific pin vs. a "somewhere in
 * the county" badge.
 */
export function hasKnownCoords(zip: string | null | undefined): boolean {
  if (!zip) return false;
  return zip.trim() in ZIP_TO_LATLNG;
}

/**
 * Great-circle distance in miles between two points. Duplicates the
 * backend's matching_service.haversine — keep them in sync if edited.
 */
export function haversineMiles(a: LatLng, b: LatLng): number {
  const R = 3959;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(s));
}
