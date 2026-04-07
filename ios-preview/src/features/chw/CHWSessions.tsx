import { useNavigate } from 'react-router-dom';
import { IOSNavBar } from '../../components/IOSNavBar';
import { IOSTabBar } from '../../components/IOSTabBar';
import { sessions, verticalLabels, sessionModeLabels } from '../../data/mock';
import type { SessionStatus } from '../../data/mock';
import { Calendar, Video, Phone, MapPin } from 'lucide-react';

const STATUS_STYLE: Record<SessionStatus, { bg: string; text: string }> = {
  scheduled: { bg: '#E3F2FD', text: '#007AFF' },
  in_progress: { bg: '#E8F5E9', text: '#00B050' },
  completed: { bg: '#F3E5F5', text: '#AF52DE' },
  cancelled: { bg: '#F5F5F5', text: '#8E8E93' },
};

const MODE_ICON = {
  in_person: MapPin,
  virtual: Video,
  phone: Phone,
};

function SessionCard({ session }: { session: (typeof sessions)[0] }) {
  const style = STATUS_STYLE[session.status];
  const ModeIcon = MODE_ICON[session.mode] ?? Calendar;
  const date = new Date(session.scheduledAt);
  const formatted = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <p style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#000' }}>
            {session.memberName}
          </p>
          <p style={{ margin: '2px 0 0', fontSize: '13px', color: '#8E8E93' }}>
            {verticalLabels[session.vertical]}
          </p>
        </div>
        <span
          style={{
            fontSize: '11px',
            fontWeight: 600,
            padding: '3px 8px',
            borderRadius: '6px',
            backgroundColor: style.bg,
            color: style.text,
          }}
        >
          {session.status.replace('_', ' ').toUpperCase()}
        </span>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#8E8E93' }}>
          <Calendar size={13} />
          <span style={{ fontSize: '13px' }}>{formatted} at {time}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#8E8E93' }}>
          <ModeIcon size={13} />
          <span style={{ fontSize: '13px' }}>{sessionModeLabels[session.mode]}</span>
        </div>
      </div>

      {session.netAmount !== undefined && (
        <div
          style={{
            marginTop: '8px',
            paddingTop: '8px',
            borderTop: '0.5px solid #C6C6C8',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span style={{ fontSize: '13px', color: '#8E8E93' }}>
            {session.durationMinutes} min · {session.unitsBilled} units
          </span>
          <span style={{ fontSize: '16px', fontWeight: 700, color: '#00B050' }}>
            +${session.netAmount?.toFixed(2)}
          </span>
        </div>
      )}
    </div>
  );
}

export function CHWSessions() {
  const navigate = useNavigate();

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
      <IOSNavBar title="Sessions" />

      <div className="ios-scroll" style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 0' }}>
        {sessions.map((s) => (
          <SessionCard key={s.id} session={s} />
        ))}
        <div style={{ height: '20px' }} />
      </div>

      <IOSTabBar role="chw" activePath="/chw/sessions" onNavigate={navigate} />
    </div>
  );
}
