import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface IOSNavBarProps {
  /** Large title displayed prominently */
  title: string;
  /** Show a back chevron with optional label */
  backLabel?: string;
  /** Callback for back button press */
  onBack?: () => void;
  /** Optional right-side action element */
  rightAction?: ReactNode;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * iOS-style navigation bar with large title mode.
 * Uses backdrop-filter blur to match native iOS translucency.
 * Back button with chevron follows iOS HIG standards (44pt touch target).
 */
export function IOSNavBar({
  title,
  backLabel,
  onBack,
  rightAction,
}: IOSNavBarProps) {
  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 40,
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        backgroundColor: 'rgba(242,242,247,0.85)',
        borderBottom: '0.5px solid rgba(60,60,67,0.29)',
        flexShrink: 0,
      }}
    >
      {/* Inline nav row — back button + right action */}
      {(backLabel !== undefined || rightAction !== undefined) && (
        <div
          style={{
            height: '44px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingLeft: '8px',
            paddingRight: '16px',
          }}
        >
          {/* Back button */}
          {backLabel !== undefined ? (
            <button
              onClick={onBack}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '2px',
                background: 'none',
                border: 'none',
                padding: '0 8px',
                minHeight: '44px',
                cursor: 'pointer',
                color: '#007AFF',
                fontSize: '17px',
                fontFamily: 'inherit',
                fontWeight: 400,
              }}
            >
              <ChevronLeft size={20} strokeWidth={2.5} />
              <span>{backLabel || 'Back'}</span>
            </button>
          ) : (
            <div style={{ flex: 1 }} />
          )}

          {/* Right action */}
          {rightAction && (
            <div
              style={{
                color: '#007AFF',
                fontSize: '17px',
                fontWeight: 400,
                minHeight: '44px',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              {rightAction}
            </div>
          )}
        </div>
      )}

      {/* Large title row */}
      <div
        style={{
          paddingLeft: '20px',
          paddingRight: '20px',
          paddingBottom: '12px',
          paddingTop: backLabel === undefined && rightAction === undefined ? '8px' : '0',
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: '34px',
            fontWeight: 700,
            letterSpacing: '-0.5px',
            color: '#000',
            lineHeight: 1.1,
            fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          }}
        >
          {title}
        </h1>
      </div>
    </div>
  );
}
