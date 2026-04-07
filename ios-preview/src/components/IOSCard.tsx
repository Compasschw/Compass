import type { ReactNode } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface IOSCardProps {
  children: ReactNode;
  /** Optional section header — renders above the card in iOS inset-grouped style */
  sectionHeader?: string;
  /** Optional footer text below the card */
  sectionFooter?: string;
  /** Additional style overrides for the card container */
  style?: React.CSSProperties;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * iOS inset-grouped card section.
 * White background with 12px border radius and subtle shadow.
 * No border — depth is conveyed via shadow per iOS design language.
 * Matches the iOS Settings "Inset Grouped" table view section appearance.
 */
export function IOSCard({
  children,
  sectionHeader,
  sectionFooter,
  style,
}: IOSCardProps) {
  return (
    <div style={{ paddingLeft: '16px', paddingRight: '16px' }}>
      {/* Section header */}
      {sectionHeader && (
        <div
          style={{
            fontSize: '13px',
            fontWeight: 400,
            color: '#6C6C70',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            paddingLeft: '4px',
            paddingBottom: '7px',
            paddingTop: '2px',
            fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          }}
        >
          {sectionHeader}
        </div>
      )}

      {/* Card surface */}
      <div
        style={{
          backgroundColor: '#FFFFFF',
          borderRadius: '12px',
          overflow: 'hidden',
          boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.04)',
          ...style,
        }}
      >
        {children}
      </div>

      {/* Section footer */}
      {sectionFooter && (
        <div
          style={{
            fontSize: '13px',
            fontWeight: 400,
            color: '#6C6C70',
            paddingLeft: '4px',
            paddingTop: '7px',
            lineHeight: 1.4,
            fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          }}
        >
          {sectionFooter}
        </div>
      )}
    </div>
  );
}
