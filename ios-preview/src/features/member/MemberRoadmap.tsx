import { useNavigate } from 'react-router-dom';
import { IOSNavBar } from '../../components/IOSNavBar';
import { IOSTabBar } from '../../components/IOSTabBar';
import { goals, verticalLabels } from '../../data/mock';
import { CheckCircle2, Circle, Clock } from 'lucide-react';

const CATEGORY_COLORS: Record<string, string> = {
  housing: '#007AFF',
  rehab: '#FF9500',
  food: '#34C759',
  mental_health: '#AF52DE',
  healthcare: '#00B050',
};

export function MemberRoadmap() {
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
      <IOSNavBar title="Roadmap" />

      <div className="ios-scroll" style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 0' }}>
        <p style={{ margin: '0 4px 16px', fontSize: '13px', color: '#8E8E93' }}>
          Your personalized wellness journey tracked milestone by milestone.
        </p>

        {goals.map((goal) => {
          const color = CATEGORY_COLORS[goal.category] ?? '#007AFF';
          const isAlmostDone = goal.status === 'almost_done';
          const nextDate = new Date(goal.nextSession);

          return (
            <div
              key={goal.id}
              style={{
                backgroundColor: '#FFFFFF',
                borderRadius: '12px',
                padding: '16px',
                boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                marginBottom: '12px',
              }}
            >
              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <span style={{ fontSize: '28px' }}>{goal.emoji}</span>
                  <div>
                    <p style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#000' }}>
                      {goal.title}
                    </p>
                    <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#8E8E93' }}>
                      {verticalLabels[goal.category]}
                    </p>
                  </div>
                </div>
                <div
                  style={{
                    width: '44px',
                    height: '44px',
                    borderRadius: '50%',
                    border: `3px solid ${color}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <span style={{ fontSize: '13px', fontWeight: 700, color }}>{goal.progress}%</span>
                </div>
              </div>

              {/* Progress bar */}
              <div style={{ height: '6px', backgroundColor: '#E5E5EA', borderRadius: '3px', overflow: 'hidden', marginBottom: '12px' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${goal.progress}%`,
                    backgroundColor: color,
                    borderRadius: '3px',
                  }}
                />
              </div>

              {/* Milestones */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
                {Array.from({ length: goal.sessionsCompleted }).map((_, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <CheckCircle2 size={16} color={color} fill={color} />
                    <span style={{ fontSize: '13px', color: '#3C3C43' }}>Session {i + 1} completed</span>
                  </div>
                ))}
                {/* Upcoming */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Circle size={16} color={color} />
                  <span style={{ fontSize: '13px', color: '#3C3C43' }}>
                    Next session ·{' '}
                    {nextDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                </div>
              </div>

              {/* Status badge */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Clock size={13} color="#8E8E93" />
                  <span style={{ fontSize: '12px', color: '#8E8E93' }}>
                    {goal.sessionsCompleted} sessions done
                  </span>
                </div>
                <span
                  style={{
                    fontSize: '11px',
                    fontWeight: 600,
                    padding: '3px 10px',
                    borderRadius: '6px',
                    backgroundColor: isAlmostDone ? '#E8F5E9' : '#E3F2FD',
                    color: isAlmostDone ? '#00B050' : '#007AFF',
                  }}
                >
                  {isAlmostDone ? 'ALMOST DONE' : 'ON TRACK'}
                </span>
              </div>
            </div>
          );
        })}
        <div style={{ height: '20px' }} />
      </div>

      <IOSTabBar role="member" activePath="/member/roadmap" onNavigate={navigate} />
    </div>
  );
}
