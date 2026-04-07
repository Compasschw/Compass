import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { IOSNavBar } from '../../components/IOSNavBar';
import { IOSTabBar } from '../../components/IOSTabBar';
import { MapView, type MapMarker } from '../../components/MapView';
import { serviceRequests, verticalLabels, urgencyLabels, sessionModeLabels } from '../../data/mock';
import type { RequestStatus } from '../../data/mock';
import { MapPin, Video, Phone } from 'lucide-react';

// ─── Map data ─────────────────────────────────────────────────────────────────

const REQUEST_COORDINATES: Record<string, { lat: number; lng: number }> = {
  'req-001': { lat: 34.0600, lng: -118.2250 }, // Rosa Delgado
  'req-002': { lat: 33.9650, lng: -118.2900 }, // Marcus Johnson
  'req-004': { lat: 34.0300, lng: -118.3500 }, // James Okonkwo
};

const VERTICAL_MARKER_COLOR: Record<string, string> = {
  housing:      '#007AFF',
  rehab:        '#FF3B30',
  food:         '#FF9500',
  mental_health:'#AF52DE',
  healthcare:   '#30B0C7',
};

// ─── Status badge helpers ─────────────────────────────────────────────────────

const STATUS_COLORS: Record<RequestStatus, { bg: string; text: string }> = {
  open: { bg: '#E8F5E9', text: '#00B050' },
  matched: { bg: '#E3F2FD', text: '#007AFF' },
  completed: { bg: '#F3E5F5', text: '#AF52DE' },
  cancelled: { bg: '#F5F5F5', text: '#8E8E93' },
};

const URGENCY_COLORS: Record<string, { bg: string; text: string }> = {
  urgent: { bg: '#FFF0EE', text: '#FF3B30' },
  soon: { bg: '#FFF8EE', text: '#FF9500' },
  routine: { bg: '#F0F0F5', text: '#8E8E93' },
};

const MODE_ICON: Record<string, typeof MapPin> = {
  in_person: MapPin,
  virtual: Video,
  phone: Phone,
};

// ─── Request Card ─────────────────────────────────────────────────────────────

function RequestCard({ req }: { req: (typeof serviceRequests)[0] }) {
  const statusColor = STATUS_COLORS[req.status];
  const urgencyColor = URGENCY_COLORS[req.urgency];
  const ModeIcon = MODE_ICON[req.preferredMode] ?? MapPin;

  return (
    <div
      style={{
        backgroundColor: '#FFFFFF',
        borderRadius: '12px',
        padding: '14px 16px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
        marginBottom: '10px',
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
        <div>
          <p style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#000' }}>
            {req.memberName}
          </p>
          <p style={{ margin: '2px 0 0', fontSize: '13px', color: '#8E8E93', fontWeight: 400 }}>
            {verticalLabels[req.vertical]}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
          <span
            style={{
              fontSize: '11px',
              fontWeight: 600,
              padding: '3px 8px',
              borderRadius: '6px',
              backgroundColor: urgencyColor.bg,
              color: urgencyColor.text,
            }}
          >
            {urgencyLabels[req.urgency].toUpperCase()}
          </span>
        </div>
      </div>

      {/* Description */}
      <p
        style={{
          margin: '0 0 10px',
          fontSize: '13px',
          color: '#3C3C43',
          lineHeight: 1.4,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {req.description}
      </p>

      {/* Footer row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#8E8E93' }}>
          <ModeIcon size={13} />
          <span style={{ fontSize: '12px' }}>{sessionModeLabels[req.preferredMode]}</span>
          <span style={{ fontSize: '12px', marginLeft: '6px' }}>
            {req.estimatedUnits * 15} min est.
          </span>
        </div>
        <span
          style={{
            fontSize: '12px',
            fontWeight: 600,
            padding: '3px 10px',
            borderRadius: '8px',
            backgroundColor: statusColor.bg,
            color: statusColor.text,
          }}
        >
          {req.status.charAt(0).toUpperCase() + req.status.slice(1)}
        </span>
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CHWRequests() {
  const navigate = useNavigate();
  const open = serviceRequests.filter((r) => r.status === 'open');

  /** Map markers for open requests that have known coordinate data. */
  const requestMarkers = useMemo<MapMarker[]>(
    () =>
      open
        .filter((r) => r.id in REQUEST_COORDINATES)
        .map((r) => {
          const coords = REQUEST_COORDINATES[r.id];
          const urgencyDot = r.urgency === 'urgent' ? '🔴' : r.urgency === 'soon' ? '🟡' : '🟢';
          return {
            id: r.id,
            lat: coords.lat,
            lng: coords.lng,
            label: urgencyDot,
            type: 'resource' as const,
            color: VERTICAL_MARKER_COLOR[r.vertical] ?? '#8E8E93',
            popupContent: `
              <strong>${r.memberName}</strong><br/>
              <span style="color:#3C3C43;font-size:11px">${verticalLabels[r.vertical]} · ${urgencyLabels[r.urgency]}</span>
            `,
          };
        }),
    [open],
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: '#F2F2F7',
        fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
      }}
    >
      <IOSNavBar title="Requests" />

      <div className="ios-scroll" style={{ flex: 1, overflowY: 'auto' }}>
        {/* Request location map */}
        {requestMarkers.length > 0 && (
          <div style={{ padding: '14px 16px 0' }}>
            <div
              style={{
                fontSize: '13px',
                fontWeight: 400,
                color: '#6C6C70',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                paddingLeft: '4px',
                paddingBottom: '7px',
              }}
            >
              Request Locations
            </div>
            <MapView
              centerLat={34.0200}
              centerLng={-118.2800}
              zoom={11}
              height={180}
              markers={requestMarkers}
              borderRadius={12}
            />
          </div>
        )}

        {/* Open requests */}
        <div style={{ padding: '16px 16px 0' }}>
          <div
            style={{
              fontSize: '13px',
              fontWeight: 400,
              color: '#6C6C70',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              paddingLeft: '4px',
              paddingBottom: '7px',
            }}
          >
            Open ({open.length})
          </div>
          {open.map((req) => (
            <RequestCard key={req.id} req={req} />
          ))}
        </div>

        {/* All requests */}
        <div style={{ padding: '8px 16px 0' }}>
          <div
            style={{
              fontSize: '13px',
              fontWeight: 400,
              color: '#6C6C70',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              paddingLeft: '4px',
              paddingBottom: '7px',
            }}
          >
            All Requests
          </div>
          {serviceRequests.map((req) => (
            <RequestCard key={req.id} req={req} />
          ))}
        </div>

        <div style={{ height: '20px' }} />
      </div>

      <IOSTabBar role="chw" activePath="/chw/requests" onNavigate={navigate} />
    </div>
  );
}
