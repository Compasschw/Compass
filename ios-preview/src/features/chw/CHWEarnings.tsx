import { useNavigate } from 'react-router-dom';
import { IOSNavBar } from '../../components/IOSNavBar';
import { IOSTabBar } from '../../components/IOSTabBar';
import { IOSCard } from '../../components/IOSCard';
import { IOSListRow } from '../../components/IOSListRow';
import { earningsSummary, sessions } from '../../data/mock';
import { DollarSign, TrendingUp, Clock, Star } from 'lucide-react';

export function CHWEarnings() {
  const navigate = useNavigate();
  const completedSessions = sessions.filter((s) => s.status === 'completed' && s.netAmount);

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
      <IOSNavBar title="Earnings" />

      <div className="ios-scroll" style={{ flex: 1, overflowY: 'auto' }}>
        {/* Big balance card */}
        <div style={{ padding: '20px 16px 0' }}>
          <div
            style={{
              background: 'linear-gradient(135deg, #00B050 0%, #00872A 100%)',
              borderRadius: '16px',
              padding: '24px',
              marginBottom: '4px',
            }}
          >
            <p style={{ margin: 0, fontSize: '14px', color: 'rgba(255,255,255,0.8)', fontWeight: 400 }}>
              Pending Payout
            </p>
            <p
              style={{
                margin: '6px 0 0',
                fontSize: '40px',
                fontWeight: 700,
                color: '#FFFFFF',
                letterSpacing: '-1px',
              }}
            >
              ${earningsSummary.pendingPayout.toFixed(2)}
            </p>
            <p style={{ margin: '6px 0 0', fontSize: '13px', color: 'rgba(255,255,255,0.7)' }}>
              Paid out every Friday · Medi-Cal rate $26.66/unit
            </p>
          </div>
        </div>

        {/* Stats */}
        <div style={{ padding: '16px 16px 0' }}>
          <IOSCard sectionHeader="Summary">
            <IOSListRow
              label="This Week"
              icon={<Clock size={14} color="white" />}
              iconColor="#FF9500"
              value={`$${earningsSummary.thisWeek.toFixed(2)}`}
              showSeparator
            />
            <IOSListRow
              label="This Month"
              icon={<TrendingUp size={14} color="white" />}
              iconColor="#007AFF"
              value={`$${earningsSummary.thisMonth.toFixed(2)}`}
              showSeparator
            />
            <IOSListRow
              label="All Time"
              icon={<DollarSign size={14} color="white" />}
              iconColor="#00B050"
              value={`$${earningsSummary.allTime.toLocaleString()}`}
              showSeparator
            />
            <IOSListRow
              label="Average Rating"
              icon={<Star size={14} color="white" />}
              iconColor="#AF52DE"
              value={`${earningsSummary.avgRating} ★`}
              showSeparator={false}
            />
          </IOSCard>
        </div>

        {/* Recent payouts */}
        <div style={{ padding: '16px 16px 0' }}>
          <IOSCard sectionHeader="Recent Sessions">
            {completedSessions.map((s, idx) => (
              <div
                key={s.id}
                style={{
                  padding: '12px 16px',
                  borderBottom:
                    idx < completedSessions.length - 1 ? '0.5px solid #C6C6C8' : 'none',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <div>
                    <p style={{ margin: 0, fontSize: '15px', fontWeight: 500, color: '#000' }}>
                      {s.memberName}
                    </p>
                    <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#8E8E93' }}>
                      {s.durationMinutes} min · {s.unitsBilled} units
                    </p>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <p style={{ margin: 0, fontSize: '15px', fontWeight: 700, color: '#00B050' }}>
                      +${s.netAmount?.toFixed(2)}
                    </p>
                    <p style={{ margin: '2px 0 0', fontSize: '11px', color: '#8E8E93' }}>
                      gross ${s.grossAmount?.toFixed(2)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </IOSCard>
        </div>

        <div style={{ height: '20px' }} />
      </div>

      <IOSTabBar role="chw" activePath="/chw/earnings" onNavigate={navigate} />
    </div>
  );
}
