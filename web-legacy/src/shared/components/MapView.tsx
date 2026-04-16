/**
 * MapView — shared Leaflet/OpenStreetMap wrapper for the CompassCHW web app.
 *
 * Uses react-leaflet v5 + custom L.divIcon circle markers.
 * No API key required (OpenStreetMap tiles are free).
 *
 * IMPORTANT: Import 'leaflet/dist/leaflet.css' in any page-level component
 * that renders <MapView> (or import it once in your app entry point).
 */

import React, { useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  /** Short label shown in the marker circle (initials or emoji) */
  label: string;
  type: 'chw' | 'resource';
  /** Hex color for the marker background */
  color: string;
  /** React node rendered inside the Leaflet popup */
  popupContent: React.ReactNode;
}

export interface MapViewProps {
  /** Latitude of the initial map center */
  centerLat?: number;
  /** Longitude of the initial map center */
  centerLng?: number;
  zoom?: number;
  /** px value for the map container height */
  height?: number | string;
  markers?: MapMarker[];
  /** Additional className applied to the outermost wrapper div */
  className?: string;
  /** Border radius for rounded corners (default: 12) */
  borderRadius?: number;
  /** Use CartoDB Positron light tiles instead of OSM Standard */
  lightTiles?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a custom L.divIcon circle marker.
 * CHW markers: solid colored circle with white initials text.
 * Resource markers: slightly smaller circle with an emoji label.
 */
function buildDivIcon(marker: MapMarker): L.DivIcon {
  const size = marker.type === 'chw' ? 30 : 26;
  const fontSize = marker.type === 'chw' ? 10 : 13;

  const html = `
    <div style="
      width: ${size}px;
      height: ${size}px;
      border-radius: 50%;
      background-color: ${marker.color};
      border: 2px solid rgba(255,255,255,0.9);
      box-shadow: 0 2px 6px rgba(0,0,0,0.30);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: ${fontSize}px;
      font-weight: 700;
      color: #ffffff;
      font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      cursor: pointer;
      user-select: none;
      line-height: 1;
    ">${marker.label}</div>
  `;

  return L.divIcon({
    html,
    className: '',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2 + 4)],
  });
}

// ─── Internal: bounds-fitter ──────────────────────────────────────────────────

interface FitBoundsProps {
  markers: MapMarker[];
}

/**
 * Companion component that lives inside <MapContainer>.
 * Fits the map to the visible markers after the container mounts,
 * but only if there are multiple markers to frame.
 */
function FitBounds({ markers }: FitBoundsProps) {
  const map = useMap();
  const fitted = useRef(false);

  useEffect(() => {
    if (fitted.current || markers.length < 2) return;
    const bounds = L.latLngBounds(markers.map((m) => [m.lat, m.lng]));
    map.fitBounds(bounds, { padding: [24, 24], maxZoom: 13 });
    fitted.current = true;
  }, [map, markers]);

  return null;
}

// ─── Tile layer configs ───────────────────────────────────────────────────────

const OSM_TILE = {
  url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
} as const;

const CARTO_LIGHT_TILE = {
  url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  maxZoom: 19,
} as const;

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * MapView — interactive Leaflet map with custom circle markers.
 *
 * Renders a MapContainer from react-leaflet with OSM or CartoDB Positron tiles.
 * Markers are rendered with custom L.divIcon circles; clicking a marker opens
 * a popup with the provided HTML content.
 */
export function MapView({
  centerLat = 34.0522,
  centerLng = -118.2437,
  zoom = 11,
  height = 220,
  markers = [],
  className = '',
  borderRadius = 12,
  lightTiles = false,
}: MapViewProps) {
  const tile = lightTiles ? CARTO_LIGHT_TILE : OSM_TILE;
  const heightValue = typeof height === 'number' ? `${height}px` : height;

  return (
    <div
      className={className}
      style={{
        height: heightValue,
        borderRadius: `${borderRadius}px`,
        overflow: 'hidden',
        position: 'relative',
        // Ensure Leaflet z-index is scoped and doesn't bleed into page z-stack
        isolation: 'isolate',
      }}
      role="region"
      aria-label="Interactive map"
    >
      <MapContainer
        center={[centerLat, centerLng]}
        zoom={zoom}
        scrollWheelZoom={false}
        style={{ height: '100%', width: '100%' }}
        // Prevent keyboard focus trapping inside the map
        attributionControl={true}
      >
        <TileLayer
          url={tile.url}
          attribution={tile.attribution}
          maxZoom={tile.maxZoom}
        />

        {markers.map((marker) => (
          <Marker
            key={marker.id}
            position={[marker.lat, marker.lng]}
            icon={buildDivIcon(marker)}
          >
            <Popup>
              <div style={{ fontSize: '13px', lineHeight: 1.5, minWidth: '140px' }}>
                {marker.popupContent}
              </div>
            </Popup>
          </Marker>
        ))}

        {/* Auto-fit viewport when markers change */}
        {markers.length > 1 && <FitBounds markers={markers} />}
      </MapContainer>
    </div>
  );
}
