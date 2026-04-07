import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { IOSNavBar } from '../../components/IOSNavBar';
import { IOSTabBar } from '../../components/IOSTabBar';
import { IOSCard } from '../../components/IOSCard';
import { earningsSummary, serviceRequests, sessions } from '../../data/mock';
import { TrendingUp, Clock, Star, Bell } from 'lucide-react';

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color: string;
}) {
  return (
    <div
      style={{
        flex: 1,
        backgroundColor: '#FFFFFF',
        borderRadius: '12px',
        padding: '14px 12px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
      }}
    >
      <div style={{ fontSize: '12px', color: '#8E8E93', fontWeight: 400, marginBottom: '4px' }}>
        {label}
      </div>
      <div
        style={{
          fontSize: '22px',
          fontWeight: 700,
          color,
          letterSpacing: '-0.5px',
          lineHeight: 1,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: '11px', color: '#8E8E93', marginTop: '3px' }}>{sub}</div>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CHWDashboard() {
  const navigate = useNavigate();
  const { userName } = useAuth();

  const openRequests = serviceRequests.filter((r) => r.status === 'open').length;
  const upcomingSessions = sessions.filter((s) => s.status === 'scheduled').length;
  const firstName = userName?.split(' ')[0] ?? 'Maria';

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
      {/* Nav bar with notification bell */}
      <IOSNavBar
        title="Dashboard"
        rightAction={
          <button
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px', color: '#007AFF' }}
          >
            <Bell size={22} />
          </button>
        }
      />

      {/* Scrollable content */}
      <div
        className="ios-scroll"
        style={{ flex: 1, overflowY: 'auto', paddingBottom: '8px' }}
      >
        {/* Greeting */}
        <div style={{ padding: '16px 20px 8px' }}>
          <p style={{ margin: 0, fontSize: '15px', color: '#8E8E93' }}>Good morning,</p>
          <h2
            style={{
              margin: '2px 0 0',
              fontSize: '22px',
              fontWeight: 700,
              color: '#000',
              letterSpacing: '-0.3px',
            }}
          >
            {firstName}
          </h2>
        </div>

        {/* Earnings stats row */}
        <div style={{ padding: '8px 16px 0' }}>
          <div style={{ display: 'flex', gap: '10px', marginBottom: '8px' }}>
            <StatCard
              label="This Week"
              value={`$${earningsSummary.thisWeek.toFixed(2)}`}
              sub={`${earningsSummary.sessionsThisWeek} sessions`}
              color="#00B050"
            />
            <StatCard
              label="This Month"
              value={`$${earningsSummary.thisMonth.toFixed(2)}`}
              color="#007AFF"
            />
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <StatCard
              label="Pending Payout"
              value={`$${earningsSummary.pendingPayout.toFixed(2)}`}
              color="#FF9500"
            />
            <StatCard
              label="Avg Rating"
              value={`${earningsSummary.avgRating}`}
              sub="out of 5.0"
              color="#AF52DE"
            />
          </div>
        </div>

        {/* Quick actions */}
        <div style={{ padding: '20px 16px 0' }}>
          <IOSCard sectionHeader="Quick Actions">
            <button
              onClick={() => navigate('/chw/requests')}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '14px 16px',
                background: 'none',
                border: 'none',
                borderBottom: '0.5px solid #C6C6C8',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '8px',
                    backgroundColor: '#FF9500',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Clock size={16} color="white" />
                </div>
                <span style={{ fontSize: '16px', color: '#000', fontWeight: 400 }}>
                  Open Requests
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span
                  style={{
                    backgroundColor: '#FF3B30',
                    color: '#FFF',
                    borderRadius: '10px',
                    padding: '2px 8px',
                    fontSize: '12px',
                    fontWeight: 600,
                  }}
                >
                  {openRequests}
                </span>
              </div>
            </button>

            <button
              onClick={() => navigate('/chw/sessions')}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '14px 16px',
                background: 'none',
                border: 'none',
                borderBottom: '0.5px solid #C6C6C8',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '8px',
                    backgroundColor: '#34C759',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <TrendingUp size={16} color="white" />
                </div>
                <span style={{ fontSize: '16px', color: '#000', fontWeight: 400 }}>
                  Upcoming Sessions
                </span>
              </div>
              <span
                style={{
                  backgroundColor: '#34C759',
                  color: '#FFF',
                  borderRadius: '10px',
                  padding: '2px 8px',
                  fontSize: '12px',
                  fontWeight: 600,
                }}
              >
                {upcomingSessions}
              </span>
            </button>

            <button
              onClick={() => navigate('/chw/earnings')}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '14px 16px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '8px',
                    backgroundColor: '#AF52DE',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Star size={16} color="white" />
                </div>
                <span style={{ fontSize: '16px', color: '#000', fontWeight: 400 }}>
                  All-Time Earnings
                </span>
              </div>
              <span style={{ fontSize: '16px', color: '#8E8E93' }}>
                ${earningsSummary.allTime.toLocaleString()}
              </span>
            </button>
          </IOSCard>
        </div>

        {/* Recent requests preview */}
        <div style={{ padding: '20px 16px 0' }}>
          <IOSCard sectionHeader="Recent Requests">
            {serviceRequests.slice(0, 3).map((req, idx) => (
              <div
                key={req.id}
                style={{
                  padding: '12px 16px',
                  borderBottom: idx < 2 ? '0.5px solid #C6C6C8' : 'none',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p
                      style={{
                        margin: 0,
                        fontSize: '15px',
                        fontWeight: 500,
                        color: '#000',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {req.memberName}
                    </p>
                    <p
                      style={{
                        margin: '2px 0 0',
                        fontSize: '13px',
                        color: '#8E8E93',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {req.description.slice(0, 60)}...
                    </p>
                  </div>
                  <span
                    style={{
                      marginLeft: '8px',
                      fontSize: '11px',
                      fontWeight: 600,
                      padding: '3px 8px',
                      borderRadius: '6px',
                      backgroundColor:
                        req.urgency === 'urgent'
                          ? '#FFF0EE'
                          : req.urgency === 'soon'
                          ? '#FFF8EE'
                          : '#F0F0F5',
                      color:
                        req.urgency === 'urgent'
                          ? '#FF3B30'
                          : req.urgency === 'soon'
                          ? '#FF9500'
                          : '#8E8E93',
                      flexShrink: 0,
                    }}
                  >
                    {req.urgency.toUpperCase()}
                  </span>
                </div>
              </div>
            ))}
          </IOSCard>
        </div>

        <div style={{ height: '20px' }} />
      </div>

      {/* Tab bar */}
      <IOSTabBar
        role="chw"
        activePath="/chw/dashboard"
        onNavigate={navigate}
      />
    </div>
  );
}
