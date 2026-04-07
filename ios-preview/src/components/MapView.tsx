/**
 * MapView — shared Leaflet/CartoDB map wrapper for the Compass iOS preview.
 *
 * Styled to resemble Apple Maps: light CartoDB Positron tile layer, subtle
 * rounded corners, and compact layout that fits within the 393px iPhone frame.
 *
 * Uses react-leaflet v5. No API key required.
 */

import { useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  /** Short label: initials (CHW) or single emoji (resource) */
  label: string;
  type: 'chw' | 'resource';
  /** Hex color for the marker circle background */
  color: string;
  /** HTML string rendered inside the popup */
  popupContent: string;
}

export interface MapViewProps {
  centerLat?: number;
  centerLng?: number;
  zoom?: number;
  /** Height of the map in px (keep compact — sits inside an iPhone frame) */
  height?: number;
  markers?: MapMarker[];
  borderRadius?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a custom L.divIcon circle for each marker.
 * Sized for the compact iOS frame — 26px for CHWs, 22px for resources.
 */
function buildDivIcon(marker: MapMarker): L.DivIcon {
  const size = marker.type === 'chw' ? 26 : 22;
  const fontSize = marker.type === 'chw' ? 9 : 12;

  const html = `
    <div style="
      width: ${size}px;
      height: ${size}px;
      border-radius: 50%;
      background-color: ${marker.color};
      border: 2px solid rgba(255,255,255,0.95);
      box-shadow: 0 1px 5px rgba(0,0,0,0.28);
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

// ─── Internal: bounds fitter ──────────────────────────────────────────────────

interface FitBoundsProps {
  markers: MapMarker[];
}

/**
 * Companion component (must live inside MapContainer).
 * Fits the viewport to all markers after initial mount.
 */
function FitBounds({ markers }: FitBoundsProps) {
  const map = useMap();
  const fitted = useRef(false);

  useEffect(() => {
    if (fitted.current || markers.length < 2) return;
    const bounds = L.latLngBounds(markers.map((m) => [m.lat, m.lng]));
    map.fitBounds(bounds, { padding: [20, 20], maxZoom: 13 });
    fitted.current = true;
  }, [map, markers]);

  return null;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * MapView — iOS-preview map component.
 *
 * Uses CartoDB Positron tiles for a clean, Apple Maps-like aesthetic.
 * Constrained to 100% width so it never overflows the 393px iPhone frame.
 */
export function MapView({
  centerLat = 34.0522,
  centerLng = -118.2437,
  zoom = 11,
  height = 180,
  markers = [],
  borderRadius = 12,
}: MapViewProps) {
  return (
    <div
      style={{
        width: '100%',
        height: `${height}px`,
        borderRadius: `${borderRadius}px`,
        overflow: 'hidden',
        position: 'relative',
        // Isolate stacking context so Leaflet popups don't leak outside the frame
        isolation: 'isolate',
        flexShrink: 0,
      }}
      role="region"
      aria-label="Interactive map"
    >
      <MapContainer
        center={[centerLat, centerLng]}
        zoom={zoom}
        scrollWheelZoom={false}
        zoomControl={false}
        attributionControl={true}
        style={{ height: '100%', width: '100%' }}
      >
        {/* CartoDB Positron — light, minimal, Apple Maps-like */}
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
          maxZoom={19}
        />

        {markers.map((marker) => (
          <Marker
            key={marker.id}
            position={[marker.lat, marker.lng]}
            icon={buildDivIcon(marker)}
          >
            <Popup>
              <div
                dangerouslySetInnerHTML={{ __html: marker.popupContent }}
                style={{
                  fontSize: '12px',
                  lineHeight: 1.5,
                  minWidth: '120px',
                  fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
                }}
              />
            </Popup>
          </Marker>
        ))}

        {markers.length > 1 && <FitBounds markers={markers} />}
      </MapContainer>
    </div>
  );
}
