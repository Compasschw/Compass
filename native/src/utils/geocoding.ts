/**
 * Geocoding helpers for LA County ZIP codes.
 *
 * Coordinates are approximate centroids derived from USPS ZIP code tabulation
 * areas (ZCTAs) via the US Census Bureau geographic data. These are NOT
 * precise addresses — suitable only for map pin placement at the ZIP level.
 *
 * HIPAA note: ZIP codes are not PHI on their own and are safe to geocode.
 * Do NOT include patient-linked ZIP codes in logs.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** A resolved geographic coordinate pair. */
export interface LatLng {
  lat: number;
  lng: number;
}

// ─── LA County ZIP → centroid table ──────────────────────────────────────────
// Source: approximate centroids from US Census ZCTA5 boundary data.
// Coverage: highest-density LA County residential ZIP codes.

const ZIP_CODE_TABLE: Record<string, LatLng> = {
  // South LA / Central LA
  '90001': { lat: 33.9731, lng: -118.2479 }, // Florence
  '90002': { lat: 33.9491, lng: -118.2462 }, // Watts
  '90003': { lat: 33.9641, lng: -118.2732 }, // South Central
  '90011': { lat: 34.0063, lng: -118.2585 }, // South LA
  '90015': { lat: 34.0368, lng: -118.2711 }, // Downtown / Exposition Park
  '90022': { lat: 34.0218, lng: -118.1567 }, // East LA / East Los Angeles
  '90033': { lat: 34.0471, lng: -118.2095 }, // Boyle Heights / East LA
  '90037': { lat: 34.0013, lng: -118.2877 }, // Vermont Square
  '90044': { lat: 33.9566, lng: -118.3038 }, // Athens / Gramercy Park
  '90059': { lat: 33.9278, lng: -118.2391 }, // Willowbrook

  // West LA / Westside
  '90034': { lat: 34.0222, lng: -118.4127 }, // Palms
  '90066': { lat: 34.0008, lng: -118.4256 }, // Mar Vista
  '90025': { lat: 34.0437, lng: -118.4429 }, // West LA
  '90064': { lat: 34.0348, lng: -118.4179 }, // Rancho Park

  // San Fernando Valley
  '91331': { lat: 34.2366, lng: -118.3981 }, // Pacoima
  '91406': { lat: 34.1936, lng: -118.5261 }, // Van Nuys
  '91342': { lat: 34.2742, lng: -118.4376 }, // Sylmar
  '91401': { lat: 34.1685, lng: -118.4541 }, // Van Nuys (central)
  '91601': { lat: 34.1756, lng: -118.3759 }, // North Hollywood

  // East LA / SGV
  '90032': { lat: 34.0804, lng: -118.1782 }, // El Sereno
  '91754': { lat: 34.0508, lng: -118.1321 }, // Monterey Park
  '91801': { lat: 34.0873, lng: -118.1279 }, // Alhambra
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolves a 5-digit US ZIP code to approximate geographic coordinates.
 *
 * Returns `null` when the ZIP is not in the local lookup table, so callers
 * should filter out unresolved entries rather than crashing.
 *
 * @param zip - A 5-digit ZIP code string (e.g. "90033").
 * @returns The approximate centroid `{ lat, lng }`, or `null` if unknown.
 */
export function zipToLatLng(zip: string): LatLng | null {
  const normalized = zip.trim();
  return ZIP_CODE_TABLE[normalized] ?? null;
}
