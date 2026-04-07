import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { IOSNavBar } from '../../components/IOSNavBar';
import { IOSTabBar } from '../../components/IOSTabBar';
import { MapView, type MapMarker } from '../../components/MapView';
import { chwProfiles, verticalLabels } from '../../data/mock';
import { Star, MapPin, Globe } from 'lucide-react';

// ─── Map data ─────────────────────────────────────────────────────────────────

const CHW_COORDINATES: Record<string, { lat: number; lng: number }> = {
  '90033': { lat: 34.0445, lng: -118.2107 }, // Boyle Heights
  '90047': { lat: 33.9553, lng: -118.3071 }, // South LA
  '91801': { lat: 34.0953, lng: -118.1270 }, // Alhambra
};

const RESOURCE_MARKERS: MapMarker[] = [
  {
    id: 'res-food-1',
    lat: 34.0195,
    lng: -118.1675,
    label: '🛒',
    type: 'resource',
    color: '#F59E0B',
    popupContent: '<strong>LA Regional Food Bank</strong><br/><span style="color:#3C3C43">Food Pantry</span>',
  },
  {
    id: 'res-housing-1',
    lat: 34.0453,
    lng: -118.2441,
    label: '🏠',
    type: 'resource',
    color: '#007AFF',
    popupContent: '<strong>Union Rescue Mission</strong><br/><span style="color:#3C3C43">Emergency Shelter</span>',
  },
  {
    id: 'res-housing-2',
    lat: 34.0428,
    lng: -118.2556,
    label: '🏠',
    type: 'resource',
    color: '#007AFF',
    popupContent: '<strong>LAMP Community</strong><br/><span style="color:#3C3C43">Supportive Housing</span>',
  },
  {
    id: 'res-health-1',
    lat: 34.0082,
    lng: -118.3106,
    label: '🏥',
    type: 'resource',
    color: '#30B0C7',
    popupContent: "<strong>St. John's Well Child Center</strong><br/><span style=\"color:#3C3C43\">Community Clinic</span>",
  },
  {
    id: 'res-mh-1',
    lat: 34.0131,
    lng: -118.3950,
    label: '🧠',
    type: 'resource',
    color: '#AF52DE',
    popupContent: '<strong>Didi Hirsch Mental Health</strong><br/><span style="color:#3C3C43">Mental Health Services</span>',
  },
  {
    id: 'res-health-2',
    lat: 34.0759,
    lng: -118.3079,
    label: '🏥',
    type: 'resource',
    color: '#30B0C7',
    popupContent: '<strong>APLA Health</strong><br/><span style="color:#3C3C43">Community Clinic</span>',
  },
  {
    id: 'res-mh-2',
    lat: 34.0927,
    lng: -118.3443,
    label: '🧠',
    type: 'resource',
    color: '#AF52DE',
    popupContent: '<strong>LA LGBT Center</strong><br/><span style="color:#3C3C43">Mental Health &amp; Wellness</span>',
  },
  {
    id: 'res-rehab-1',
    lat: 34.0445,
    lng: -118.2444,
    label: '💪',
    type: 'resource',
    color: '#FF3B30',
    popupContent: '<strong>Midnight Mission</strong><br/><span style="color:#3C3C43">Rehab &amp; Recovery</span>',
  },
];

function CHWCard({ chw }: { chw: (typeof chwProfiles)[0] }) {
  return (
    <div
      style={{
        backgroundColor: '#FFFFFF',
        borderRadius: '12px',
        padding: '16px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
        marginBottom: '10px',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
        <div
          style={{
            width: '52px',
            height: '52px',
            borderRadius: '50%',
            backgroundColor: chw.isAvailable ? '#00B050' : '#8E8E93',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '17px',
            fontWeight: 700,
            color: '#FFFFFF',
            flexShrink: 0,
            position: 'relative',
          }}
        >
          {chw.avatar}
          {/* Availability dot */}
          <div
            style={{
              position: 'absolute',
              bottom: 2,
              right: 2,
              width: '12px',
              height: '12px',
              borderRadius: '50%',
              backgroundColor: chw.isAvailable ? '#34C759' : '#8E8E93',
              border: '2px solid #FFFFFF',
            }}
          />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <p style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#000' }}>
              {chw.name}
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '3px', flexShrink: 0 }}>
              <Star size={13} color="#FFCC00" fill="#FFCC00" />
              <span style={{ fontSize: '14px', fontWeight: 600, color: '#000' }}>{chw.rating}</span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
              <MapPin size={12} color="#8E8E93" />
              <span style={{ fontSize: '12px', color: '#8E8E93' }}>{chw.zipCode}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
              <Globe size={12} color="#8E8E93" />
              <span style={{ fontSize: '12px', color: '#8E8E93' }}>{chw.languages.join(', ')}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Bio */}
      <p
        style={{
          margin: '10px 0',
          fontSize: '13px',
          color: '#3C3C43',
          lineHeight: 1.4,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {chw.bio}
      </p>

      {/* Specialization tags */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
        {chw.specializations.map((spec) => (
          <span
            key={spec}
            style={{
              fontSize: '11px',
              fontWeight: 500,
              padding: '3px 8px',
              borderRadius: '6px',
              backgroundColor: '#F0F0F5',
              color: '#3C3C43',
            }}
          >
            {verticalLabels[spec]}
          </span>
        ))}
      </div>

      {/* CTA */}
      <button
        style={{
          width: '100%',
          height: '42px',
          backgroundColor: chw.isAvailable ? '#00B050' : '#E5E5EA',
          color: chw.isAvailable ? '#FFFFFF' : '#8E8E93',
          fontSize: '15px',
          fontWeight: 600,
          fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          border: 'none',
          borderRadius: '10px',
          cursor: chw.isAvailable ? 'pointer' : 'default',
        }}
      >
        {chw.isAvailable ? 'Request Session' : 'Not Available'}
      </button>
    </div>
  );
}

export function MemberFindCHW() {
  const navigate = useNavigate();

  /** Build CHW markers for available CHWs that have coordinate data. */
  const chwMarkers = useMemo<MapMarker[]>(
    () =>
      chwProfiles
        .filter((c) => c.isAvailable && c.zipCode in CHW_COORDINATES)
        .map((c) => {
          const coords = CHW_COORDINATES[c.zipCode];
          const jitter = () => (Math.random() - 0.5) * 0.008;
          const specs = c.specializations
            .map((s) => s.replace('_', ' '))
            .join(', ');
          return {
            id: c.id,
            lat: coords.lat + jitter(),
            lng: coords.lng + jitter(),
            label: c.avatar,
            type: 'chw' as const,
            color: '#00B050',
            popupContent: `<strong>${c.name}</strong><br/><span style="color:#3C3C43;font-size:11px">${specs}</span>`,
          };
        }),
    [],
  );

  const allMarkers = useMemo(
    () => [...chwMarkers, ...RESOURCE_MARKERS],
    [chwMarkers],
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
      <IOSNavBar title="Find CHW" />

      <div className="ios-scroll" style={{ flex: 1, overflowY: 'auto', padding: '12px 16px 0' }}>
        {/* Search bar */}
        <div
          style={{
            backgroundColor: '#E5E5EA',
            borderRadius: '10px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 12px',
            marginBottom: '14px',
          }}
        >
          <span style={{ fontSize: '14px', color: '#8E8E93' }}>Search by name, ZIP, language...</span>
        </div>

        {/* Map — Apple Maps aesthetic via CartoDB Positron tiles */}
        <div style={{ marginBottom: '14px' }}>
          {/* Legend row */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '6px',
            }}
          >
            <span
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color: '#6C6C70',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
            >
              Nearby Resources
            </span>
            <div style={{ display: 'flex', gap: '10px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: '#6C6C70' }}>
                <span
                  style={{
                    width: '10px',
                    height: '10px',
                    borderRadius: '50%',
                    backgroundColor: '#00B050',
                    display: 'inline-block',
                    flexShrink: 0,
                  }}
                />
                CHWs
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: '#6C6C70' }}>
                <span
                  style={{
                    width: '10px',
                    height: '10px',
                    borderRadius: '50%',
                    backgroundColor: '#007AFF',
                    display: 'inline-block',
                    flexShrink: 0,
                  }}
                />
                Resources
              </span>
            </div>
          </div>

          <MapView
            centerLat={34.0522}
            centerLng={-118.2437}
            zoom={11}
            height={180}
            markers={allMarkers}
            borderRadius={12}
          />
        </div>

        {/* CHW list */}
        {chwProfiles.map((chw) => (
          <CHWCard key={chw.id} chw={chw} />
        ))}
        <div style={{ height: '20px' }} />
      </div>

      <IOSTabBar role="member" activePath="/member/find-chw" onNavigate={navigate} />
    </div>
  );
}
