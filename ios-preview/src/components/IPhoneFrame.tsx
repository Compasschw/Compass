import type { ReactNode } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface IPhoneFrameProps {
  children: ReactNode;
}

// ─── Status Bar ───────────────────────────────────────────────────────────────

function StatusBar() {
  return (
    <div
      style={{
        height: '54px',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        paddingLeft: '24px',
        paddingRight: '20px',
        paddingBottom: '8px',
        position: 'relative',
        zIndex: 50,
        flexShrink: 0,
      }}
    >
      {/* Time */}
      <span
        style={{
          fontSize: '15px',
          fontWeight: 600,
          color: '#000',
          letterSpacing: '-0.3px',
          fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
        }}
      >
        9:41
      </span>

      {/* Right icons: signal, wifi, battery */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        {/* Signal bars */}
        <svg width="17" height="12" viewBox="0 0 17 12" fill="none">
          <rect x="0" y="8" width="3" height="4" rx="0.5" fill="#000" />
          <rect x="4.5" y="5.5" width="3" height="6.5" rx="0.5" fill="#000" />
          <rect x="9" y="3" width="3" height="9" rx="0.5" fill="#000" />
          <rect x="13.5" y="0" width="3" height="12" rx="0.5" fill="#000" />
        </svg>

        {/* WiFi */}
        <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
          <path
            d="M8 9.5C8.69 9.5 9.25 10.06 9.25 10.75C9.25 11.44 8.69 12 8 12C7.31 12 6.75 11.44 6.75 10.75C6.75 10.06 7.31 9.5 8 9.5Z"
            fill="#000"
          />
          <path
            d="M8 6.5C9.38 6.5 10.62 7.06 11.52 7.96L12.58 6.9C11.4 5.72 9.78 5 8 5C6.22 5 4.6 5.72 3.42 6.9L4.48 7.96C5.38 7.06 6.62 6.5 8 6.5Z"
            fill="#000"
          />
          <path
            d="M8 3.5C10.35 3.5 12.47 4.48 13.98 6.07L15.04 5.01C13.25 3.13 10.76 2 8 2C5.24 2 2.75 3.13 0.96 5.01L2.02 6.07C3.53 4.48 5.65 3.5 8 3.5Z"
            fill="#000"
          />
          <path
            d="M8 0.5C11.32 0.5 14.3 1.9 16.38 4.14L15.32 5.2C13.52 3.24 10.91 2 8 2C5.09 2 2.48 3.24 0.68 5.2L-0.38 4.14C1.7 1.9 4.68 0.5 8 0.5Z"
            fill="#000"
            opacity="0"
          />
        </svg>

        {/* Battery */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1px' }}>
          <div
            style={{
              width: '25px',
              height: '12px',
              border: '1px solid rgba(0,0,0,0.35)',
              borderRadius: '3.5px',
              padding: '2px',
              position: 'relative',
            }}
          >
            <div
              style={{
                width: '78%',
                height: '100%',
                backgroundColor: '#000',
                borderRadius: '1.5px',
              }}
            />
          </div>
          {/* Battery cap */}
          <div
            style={{
              width: '2px',
              height: '5px',
              backgroundColor: 'rgba(0,0,0,0.4)',
              borderRadius: '0 1px 1px 0',
            }}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Dynamic Island ───────────────────────────────────────────────────────────

function DynamicIsland() {
  return (
    <div
      style={{
        position: 'absolute',
        top: '12px',
        left: '50%',
        transform: 'translateX(-50%)',
        width: '126px',
        height: '37px',
        backgroundColor: '#000',
        borderRadius: '20px',
        zIndex: 100,
      }}
    />
  );
}

// ─── iPhone Frame ─────────────────────────────────────────────────────────────

/**
 * Renders children inside a realistic iPhone 15 Pro device frame.
 * The frame is centered on the page with a dark background behind it.
 * Content renders at 393×852 logical resolution (iPhone 15 Pro).
 */
export function IPhoneFrame({ children }: IPhoneFrameProps) {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 20px',
        fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
      }}
    >
      {/* Page title */}
      <div
        style={{
          color: 'rgba(255,255,255,0.9)',
          fontSize: '14px',
          fontWeight: 500,
          letterSpacing: '0.5px',
          textTransform: 'uppercase',
          marginBottom: '24px',
          opacity: 0.7,
        }}
      >
        CompassCHW — iOS App Preview
      </div>

      {/* Phone outer shell */}
      <div
        style={{
          position: 'relative',
          width: '430px',
          height: '932px',
          background: 'linear-gradient(145deg, #2d2d2d 0%, #1a1a1a 40%, #111 100%)',
          borderRadius: '55px',
          boxShadow: `
            0 0 0 1px rgba(255,255,255,0.12),
            0 0 0 2px rgba(0,0,0,0.8),
            0 40px 80px rgba(0,0,0,0.6),
            0 20px 40px rgba(0,0,0,0.4),
            inset 0 1px 0 rgba(255,255,255,0.08)
          `,
        }}
      >
        {/* Side buttons — volume up */}
        <div
          style={{
            position: 'absolute',
            left: '-3px',
            top: '160px',
            width: '3px',
            height: '36px',
            background: 'linear-gradient(to right, #2a2a2a, #3a3a3a)',
            borderRadius: '2px 0 0 2px',
          }}
        />
        {/* Side buttons — volume down */}
        <div
          style={{
            position: 'absolute',
            left: '-3px',
            top: '208px',
            width: '3px',
            height: '36px',
            background: 'linear-gradient(to right, #2a2a2a, #3a3a3a)',
            borderRadius: '2px 0 0 2px',
          }}
        />
        {/* Side buttons — silent switch */}
        <div
          style={{
            position: 'absolute',
            left: '-3px',
            top: '112px',
            width: '3px',
            height: '30px',
            background: 'linear-gradient(to right, #2a2a2a, #3a3a3a)',
            borderRadius: '2px 0 0 2px',
          }}
        />
        {/* Side buttons — power */}
        <div
          style={{
            position: 'absolute',
            right: '-3px',
            top: '180px',
            width: '3px',
            height: '68px',
            background: 'linear-gradient(to left, #2a2a2a, #3a3a3a)',
            borderRadius: '0 2px 2px 0',
          }}
        />

        {/* Screen bezel */}
        <div
          style={{
            position: 'absolute',
            inset: '8px',
            backgroundColor: '#000',
            borderRadius: '48px',
            overflow: 'hidden',
          }}
        >
          {/* Screen glass */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              backgroundColor: '#F2F2F7',
              borderRadius: '48px',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {/* Dynamic Island */}
            <DynamicIsland />

            {/* Status bar */}
            <StatusBar />

            {/* App content area */}
            <div
              className="ios-scroll"
              style={{
                flex: 1,
                overflowY: 'auto',
                overflowX: 'hidden',
                position: 'relative',
                backgroundColor: '#F2F2F7',
              }}
            >
              {children}
            </div>
          </div>

          {/* Screen glare overlay */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background:
                'linear-gradient(135deg, rgba(255,255,255,0.03) 0%, transparent 50%)',
              borderRadius: '48px',
              pointerEvents: 'none',
              zIndex: 200,
            }}
          />
        </div>
      </div>

      {/* Bottom label */}
      <div
        style={{
          color: 'rgba(255,255,255,0.4)',
          fontSize: '11px',
          marginTop: '20px',
          letterSpacing: '0.3px',
        }}
      >
        iPhone 15 Pro · 393 × 852
      </div>
    </div>
  );
}
