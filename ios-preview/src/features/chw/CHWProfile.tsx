import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { IOSNavBar } from '../../components/IOSNavBar';
import { IOSTabBar } from '../../components/IOSTabBar';
import { IOSCard } from '../../components/IOSCard';
import { IOSListRow } from '../../components/IOSListRow';
import { IOSToggle } from '../../components/IOSToggle';
import { chwProfiles } from '../../data/mock';
import { useState } from 'react';
import { Bell, Shield, HelpCircle, LogOut } from 'lucide-react';

export function CHWProfile() {
  const navigate = useNavigate();
  const { userName, logout } = useAuth();
  const chw = chwProfiles[0]; // Maria

  const [available, setAvailable] = useState(chw.isAvailable);
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
              backgroundColor: '#00B050',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '28px',
              fontWeight: 700,
              color: '#FFFFFF',
              marginBottom: '12px',
            }}
          >
            {chw.avatar}
          </div>
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 700, color: '#000' }}>
            {userName ?? chw.name}
          </h2>
          <p style={{ margin: '4px 0 0', fontSize: '14px', color: '#8E8E93' }}>
            Community Health Worker · {chw.zipCode}
          </p>
          <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
            {chw.specializations.map((s) => (
              <span
                key={s}
                style={{
                  fontSize: '11px',
                  fontWeight: 500,
                  padding: '3px 8px',
                  borderRadius: '6px',
                  backgroundColor: '#E8F5E9',
                  color: '#00B050',
                }}
              >
                {s.replace('_', ' ')}
              </span>
            ))}
          </div>
        </div>

        {/* Availability toggle */}
        <div style={{ padding: '0 16px 16px' }}>
          <IOSCard>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '14px 16px',
              }}
            >
              <span style={{ fontSize: '17px', color: '#000', fontWeight: 400 }}>
                Available for Requests
              </span>
              <IOSToggle
                value={available}
                onChange={setAvailable}
                label="Toggle availability"
              />
            </div>
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
              <IOSToggle value={notifications} onChange={setNotifications} label="Toggle notifications" />
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

        {/* Stats card */}
        <div style={{ padding: '0 16px 16px' }}>
          <IOSCard sectionHeader="Stats">
            <IOSListRow
              label="Total Sessions"
              value={String(chw.totalSessions)}
              showSeparator
            />
            <IOSListRow
              label="Years Experience"
              value={String(chw.yearsExperience)}
              showSeparator
            />
            <IOSListRow
              label="Rating"
              value={`${chw.rating} ★`}
              showSeparator
            />
            <IOSListRow
              label="Languages"
              value={chw.languages.join(', ')}
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

      <IOSTabBar role="chw" activePath="/chw/profile" onNavigate={navigate} />
    </div>
  );
}
