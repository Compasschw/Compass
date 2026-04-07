import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { IOSNavBar } from '../../components/IOSNavBar';
import { IOSTabBar } from '../../components/IOSTabBar';
import { IOSCard } from '../../components/IOSCard';
import { IOSListRow } from '../../components/IOSListRow';
import { IOSToggle } from '../../components/IOSToggle';
import { memberProfiles, verticalLabels } from '../../data/mock';
import { useState } from 'react';
import { Bell, Shield, HelpCircle, LogOut, Gift } from 'lucide-react';

export function MemberProfile() {
  const navigate = useNavigate();
  const { userName, logout } = useAuth();
  const member = memberProfiles[0]; // Rosa

  const [notifications, setNotifications] = useState(true);

  function handleLogout() {
    logout();
    navigate('/login');
  }

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
      <IOSNavBar title="Profile" />

      <div className="ios-scroll" style={{ flex: 1, overflowY: 'auto' }}>
        {/* Avatar + name */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            padding: '24px 16px 20px',
          }}
        >
          <div
            style={{
              width: '80px',
              height: '80px',
              borderRadius: '50%',
              backgroundColor: '#0077B6',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '28px',
              fontWeight: 700,
              color: '#FFFFFF',
              marginBottom: '12px',
            }}
          >
            RD
          </div>
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 700, color: '#000' }}>
            {userName ?? member.name}
          </h2>
          <p style={{ margin: '4px 0 0', fontSize: '14px', color: '#8E8E93' }}>
            Member · ZIP {member.zipCode}
          </p>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              marginTop: '10px',
              backgroundColor: '#E3F2FD',
              padding: '6px 14px',
              borderRadius: '20px',
            }}
          >
            <Gift size={14} color="#007AFF" />
            <span style={{ fontSize: '14px', fontWeight: 600, color: '#007AFF' }}>
              {member.rewardsBalance} Compass Points
            </span>
          </div>
        </div>

        {/* Member info */}
        <div style={{ padding: '0 16px 16px' }}>
          <IOSCard sectionHeader="My Info">
            <IOSListRow
              label="Primary Language"
              value={member.primaryLanguage}
              showSeparator
            />
            <IOSListRow
              label="Primary Need"
              value={verticalLabels[member.primaryNeed]}
              showSeparator
            />
            <IOSListRow
              label="ZIP Code"
              value={member.zipCode}
              showSeparator={false}
            />
          </IOSCard>
        </div>

        {/* Settings */}
        <div style={{ padding: '0 16px 16px' }}>
          <IOSCard sectionHeader="Settings">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 16px',
                borderBottom: '0.5px solid #C6C6C8',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div
                  style={{
                    width: '29px',
                    height: '29px',
                    borderRadius: '6px',
                    backgroundColor: '#FF9500',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Bell size={14} color="white" />
                </div>
                <span style={{ fontSize: '17px', color: '#000' }}>Notifications</span>
              </div>
              <IOSToggle value={notifications} onChange={setNotifications} label="Notifications" />
            </div>
            <IOSListRow
              label="Privacy &amp; Security"
              icon={<Shield size={14} color="white" />}
              iconColor="#34C759"
              showChevron
              showSeparator
            />
            <IOSListRow
              label="Help &amp; Support"
              icon={<HelpCircle size={14} color="white" />}
              iconColor="#AF52DE"
              showChevron
              showSeparator={false}
            />
          </IOSCard>
        </div>

        {/* Sign out */}
        <div style={{ padding: '0 16px 24px' }}>
          <IOSCard>
            <IOSListRow
              label="Sign Out"
              icon={<LogOut size={14} color="white" />}
              iconColor="#FF3B30"
              destructive
              onPress={handleLogout}
              showSeparator={false}
            />
          </IOSCard>
        </div>
      </div>

      <IOSTabBar role="member" activePath="/member/profile" onNavigate={navigate} />
    </div>
  );
}
