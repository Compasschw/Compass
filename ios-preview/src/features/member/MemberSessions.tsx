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

export function MemberSessions() {
  const navigate = useNavigate();
  // Show Rosa's sessions
  const memberSessions = sessions.filter(
    (s) => s.memberName === 'Rosa Delgado' || s.memberName === 'Marcus Johnson'
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
      <IOSNavBar title="Sessions" />

      <div className="ios-scroll" style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 0' }}>
        {memberSessions.length === 0 ? (
          <div style={{ textAlign: 'center', paddingTop: '60px' }}>
            <p style={{ fontSize: '17px', color: '#8E8E93' }}>No sessions yet</p>
          </div>
        ) : (
          memberSessions.map((s) => {
            const style = STATUS_STYLE[s.status];
            const ModeIcon = MODE_ICON[s.mode] ?? Calendar;
            const date = new Date(s.scheduledAt);
            return (
              <div
                key={s.id}
                style={{
                  backgroundColor: '#FFFFFF',
                  borderRadius: '12px',
                  padding: '14px 16px',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                  marginBottom: '10px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <p style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#000' }}>
                      {s.chwName}
                    </p>
                    <p style={{ margin: '2px 0 0', fontSize: '13px', color: '#8E8E93' }}>
                      {verticalLabels[s.vertical]}
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
                    {s.status.replace('_', ' ').toUpperCase()}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#8E8E93' }}>
                    <Calendar size={13} />
                    <span style={{ fontSize: '13px' }}>
                      {date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#8E8E93' }}>
                    <ModeIcon size={13} />
                    <span style={{ fontSize: '13px' }}>{sessionModeLabels[s.mode]}</span>
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div style={{ height: '20px' }} />
      </div>

      <IOSTabBar role="member" activePath="/member/sessions" onNavigate={navigate} />
    </div>
  );
}
