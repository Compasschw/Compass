import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

// ─── Sub-components ───────────────────────────────────────────────────────────

function IOSTextField({
  placeholder,
  value,
  onChange,
  type = 'text',
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <input
      type={type}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: '100%',
        height: '44px',
        backgroundColor: '#FFFFFF',
        border: 'none',
        borderRadius: 0,
        padding: '0 16px',
        fontSize: '17px',
        fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
        fontWeight: 400,
        color: '#000',
        outline: 'none',
        boxSizing: 'border-box',
      }}
    />
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * iOS-style login screen with:
 * - Large CompassCHW branding with compass-green accent
 * - iOS inset text fields (rounded rect group)
 * - Sign In CTA in compass-green
 * - Demo role buttons for quick access
 * - Create Account link at bottom
 */
export function LoginPage() {
  const navigate = useNavigate();
  const { login } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    // Mock sign-in as CHW with entered email as name
    login('chw', email || 'Maria Guadalupe Reyes');
    navigate('/chw/dashboard');
  }

  function handleDemoCHW() {
    login('chw', 'Maria Guadalupe Reyes');
    navigate('/chw/dashboard');
  }

  function handleDemoMember() {
    login('member', 'Rosa Delgado');
    navigate('/member/home');
  }

  return (
    <div
      style={{
        minHeight: '100%',
        backgroundColor: '#F2F2F7',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
        paddingBottom: '40px',
      }}
    >
      {/* Logo + Title area */}
      <div
        style={{
          paddingTop: '60px',
          paddingBottom: '40px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '12px',
        }}
      >
        {/* Compass icon */}
        <div
          style={{
            width: '80px',
            height: '80px',
            borderRadius: '20px',
            backgroundColor: '#00B050',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 8px 24px rgba(0,176,80,0.35)',
          }}
        >
          <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
            <circle cx="22" cy="22" r="16" stroke="white" strokeWidth="2" opacity="0.4" />
            <circle cx="22" cy="22" r="3" fill="white" />
            {/* Compass needle */}
            <path d="M22 8 L24 20 L22 22 L20 20 Z" fill="white" />
            <path d="M22 36 L24 24 L22 22 L20 24 Z" fill="rgba(255,255,255,0.4)" />
            {/* N marker */}
            <text x="22" y="6" textAnchor="middle" fill="white" fontSize="5" fontWeight="700">N</text>
          </svg>
        </div>

        <div style={{ textAlign: 'center' }}>
          <h1
            style={{
              margin: 0,
              fontSize: '32px',
              fontWeight: 700,
              letterSpacing: '-0.5px',
              color: '#000',
            }}
          >
            Compass<span style={{ color: '#00B050' }}>CHW</span>
          </h1>
          <p
            style={{
              margin: '6px 0 0',
              fontSize: '17px',
              fontWeight: 400,
              color: '#3C3C43',
              opacity: 0.6,
            }}
          >
            Welcome back
          </p>
        </div>
      </div>

      {/* Form */}
      <form onSubmit={handleSignIn} style={{ paddingLeft: '16px', paddingRight: '16px' }}>
        {/* Email + password grouped */}
        <div
          style={{
            backgroundColor: '#FFFFFF',
            borderRadius: '12px',
            overflow: 'hidden',
            boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
          }}
        >
          <IOSTextField
            placeholder="Email"
            value={email}
            onChange={setEmail}
            type="email"
          />
          <div
            style={{
              height: '0.5px',
              backgroundColor: '#C6C6C8',
              marginLeft: '16px',
            }}
          />
          <IOSTextField
            placeholder="Password"
            value={password}
            onChange={setPassword}
            type="password"
          />
        </div>

        {/* Sign In button */}
        <button
          type="submit"
          style={{
            width: '100%',
            height: '54px',
            backgroundColor: '#00B050',
            color: '#FFFFFF',
            fontSize: '17px',
            fontWeight: 600,
            fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
            border: 'none',
            borderRadius: '14px',
            cursor: 'pointer',
            marginTop: '16px',
            letterSpacing: '0.2px',
            boxShadow: '0 4px 16px rgba(0,176,80,0.3)',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          Sign In
        </button>

        {/* Forgot password */}
        <div style={{ textAlign: 'center', marginTop: '16px' }}>
          <button
            type="button"
            style={{
              background: 'none',
              border: 'none',
              color: '#007AFF',
              fontSize: '15px',
              fontFamily: 'inherit',
              cursor: 'pointer',
              padding: '4px 8px',
            }}
          >
            Forgot Password?
          </button>
        </div>
      </form>

      {/* Divider */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          paddingLeft: '24px',
          paddingRight: '24px',
          marginTop: '28px',
          marginBottom: '20px',
        }}
      >
        <div style={{ flex: 1, height: '0.5px', backgroundColor: '#C6C6C8' }} />
        <span
          style={{
            fontSize: '13px',
            fontWeight: 400,
            color: '#8E8E93',
            fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          }}
        >
          or try a demo
        </span>
        <div style={{ flex: 1, height: '0.5px', backgroundColor: '#C6C6C8' }} />
      </div>

      {/* Demo buttons */}
      <div
        style={{
          paddingLeft: '16px',
          paddingRight: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        <button
          onClick={handleDemoCHW}
          style={{
            width: '100%',
            height: '50px',
            backgroundColor: 'transparent',
            color: '#007AFF',
            fontSize: '17px',
            fontWeight: 500,
            fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
            border: '1.5px solid #007AFF',
            borderRadius: '14px',
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          Demo as CHW
        </button>

        <button
          onClick={handleDemoMember}
          style={{
            width: '100%',
            height: '50px',
            backgroundColor: 'transparent',
            color: '#007AFF',
            fontSize: '17px',
            fontWeight: 500,
            fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
            border: '1.5px solid #007AFF',
            borderRadius: '14px',
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          Demo as Member
        </button>
      </div>

      {/* Create account */}
      <div
        style={{
          marginTop: 'auto',
          paddingTop: '32px',
          textAlign: 'center',
        }}
      >
        <span
          style={{
            fontSize: '15px',
            color: '#8E8E93',
            fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          }}
        >
          Don't have an account?{' '}
        </span>
        <button
          style={{
            background: 'none',
            border: 'none',
            color: '#007AFF',
            fontSize: '15px',
            fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
            fontWeight: 500,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          Create Account
        </button>
      </div>
    </div>
  );
}
