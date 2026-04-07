import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { IOSNavBar } from '../../components/IOSNavBar';
import { IOSTabBar } from '../../components/IOSTabBar';
import { IOSCard } from '../../components/IOSCard';
import { memberProfiles, goals, sessions, chwProfiles } from '../../data/mock';
import { ChevronRight, Star } from 'lucide-react';

// ─── Goal Progress Bar ────────────────────────────────────────────────────────

function GoalProgress({ title, emoji, progress, category }: { title: string; emoji: string; progress: number; category: string }) {
  const COLOR_MAP: Record<string, string> = {
    housing: '#007AFF',
    rehab: '#FF9500',
    food: '#34C759',
    mental_health: '#AF52DE',
    healthcare: '#00B050',
  };
  const color = COLOR_MAP[category] ?? '#007AFF';

  return (
    <div style={{ padding: '12px 16px', borderBottom: '0.5px solid #C6C6C8' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <span style={{ fontSize: '15px', fontWeight: 500, color: '#000' }}>
          {emoji} {title}
        </span>
        <span style={{ fontSize: '14px', fontWeight: 600, color }}>
          {progress}%
        </span>
      </div>
      <div style={{ height: '4px', backgroundColor: '#E5E5EA', borderRadius: '2px', overflow: 'hidden' }}>
        <div
          style={{
            height: '100%',
            width: `${progress}%`,
            backgroundColor: color,
            borderRadius: '2px',
            transition: 'width 0.3s ease',
          }}
        />
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MemberHome() {
  const navigate = useNavigate();
  const { userName } = useAuth();
  const member = memberProfiles[0]; // Rosa
  const firstName = userName?.split(' ')[0] ?? 'Rosa';
  const upcomingSession = sessions.find((s) => s.status === 'scheduled');
  const matchedCHW = chwProfiles[0]; // Maria

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
      <IOSNavBar title="Home" />

      <div className="ios-scroll" style={{ flex: 1, overflowY: 'auto' }}>
        {/* Greeting */}
        <div style={{ padding: '16px 20px 8px' }}>
          <p style={{ margin: 0, fontSize: '15px', color: '#8E8E93' }}>Welcome back,</p>
          <h2 style={{ margin: '2px 0 0', fontSize: '22px', fontWeight: 700, color: '#000', letterSpacing: '-0.3px' }}>
            {firstName}
          </h2>
        </div>

        {/* Rewards banner */}
        <div style={{ padding: '8px 16px 0' }}>
          <div
            style={{
              background: 'linear-gradient(135deg, #0077B6 0%, #005F8F 100%)',
              borderRadius: '12px',
              padding: '16px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div>
              <p style={{ margin: 0, fontSize: '13px', color: 'rgba(255,255,255,0.75)' }}>
                Compass Rewards
              </p>
              <p style={{ margin: '4px 0 0', fontSize: '28px', fontWeight: 700, color: '#FFFFFF', letterSpacing: '-0.5px' }}>
                {member.rewardsBalance} pts
              </p>
            </div>
            <button
              style={{
                backgroundColor: 'rgba(255,255,255,0.2)',
                border: 'none',
                borderRadius: '10px',
                padding: '8px 14px',
                color: '#FFFFFF',
                fontSize: '14px',
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Redeem
            </button>
          </div>
        </div>

        {/* Upcoming session */}
        {upcomingSession && (
          <div style={{ padding: '16px 16px 0' }}>
            <IOSCard sectionHeader="Upcoming Session">
              <div style={{ padding: '14px 16px' }}>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <div
                    style={{
                      width: '44px',
                      height: '44px',
                      borderRadius: '50%',
                      backgroundColor: '#00B050',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '15px',
                      fontWeight: 700,
                      color: '#FFFFFF',
                      flexShrink: 0,
                    }}
                  >
                    {matchedCHW.avatar}
                  </div>
                  <div style={{ flex: 1 }}>
                    <p style={{ margin: 0, fontSize: '15px', fontWeight: 600, color: '#000' }}>
                      {matchedCHW.name}
                    </p>
                    <p style={{ margin: '2px 0 0', fontSize: '13px', color: '#8E8E93' }}>
                      {new Date(upcomingSession.scheduledAt).toLocaleDateString('en-US', {
                        weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
                      })}
                    </p>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                    <Star size={13} color="#FFCC00" fill="#FFCC00" />
                    <span style={{ fontSize: '13px', fontWeight: 600, color: '#000' }}>
                      {matchedCHW.rating}
                    </span>
                  </div>
                </div>
              </div>
            </IOSCard>
          </div>
        )}

        {/* Goals progress */}
        <div style={{ padding: '16px 16px 0' }}>
          <IOSCard sectionHeader="My Goals">
            {goals.map((goal) => (
              <GoalProgress
                key={goal.id}
                title={goal.title}
                emoji={goal.emoji}
                progress={goal.progress}
                category={goal.category}
              />
            ))}
            <button
              onClick={() => navigate('/member/roadmap')}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '4px',
                padding: '12px 16px',
                background: 'none',
                border: 'none',
                color: '#007AFF',
                fontSize: '15px',
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              View Full Roadmap
              <ChevronRight size={16} />
            </button>
          </IOSCard>
        </div>

        <div style={{ height: '20px' }} />
      </div>

      <IOSTabBar role="member" activePath="/member/home" onNavigate={navigate} />
    </div>
  );
}
