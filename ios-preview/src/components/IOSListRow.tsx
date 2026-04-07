import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface IOSListRowProps {
  /** Primary label text */
  label: string;
  /** Optional icon rendered in a colored rounded square (SF Symbol style) */
  icon?: ReactNode;
  /** Icon background color (defaults to ios-blue) */
  iconColor?: string;
  /** Secondary value displayed on right */
  value?: string | ReactNode;
  /** Show navigation chevron on right */
  showChevron?: boolean;
  /** Row tap handler */
  onPress?: () => void;
  /** Destructive styling for delete-style actions */
  destructive?: boolean;
  /** Show separator below row */
  showSeparator?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * iOS Settings-style list row.
 * Follows iOS HIG: 44pt minimum height, 16px leading padding, separator inset.
 * Supports icon, label, value text, and chevron navigation indicator.
 */
export function IOSListRow({
  label,
  icon,
  iconColor = '#007AFF',
  value,
  showChevron = false,
  onPress,
  destructive = false,
  showSeparator = true,
}: IOSListRowProps) {
  const isInteractive = onPress !== undefined;

  return (
    <div style={{ position: 'relative' }}>
      <div
        role={isInteractive ? 'button' : undefined}
        tabIndex={isInteractive ? 0 : undefined}
        onClick={onPress}
        onKeyDown={(e) => {
          if (isInteractive && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            onPress?.();
          }
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          minHeight: '44px',
          paddingLeft: '16px',
          paddingRight: '12px',
          paddingTop: '8px',
          paddingBottom: '8px',
          backgroundColor: '#FFFFFF',
          cursor: isInteractive ? 'pointer' : 'default',
          gap: '12px',
          WebkitTapHighlightColor: 'transparent',
          userSelect: 'none',
        }}
      >
        {/* Icon square */}
        {icon && (
          <div
            style={{
              width: '29px',
              height: '29px',
              borderRadius: '6px',
              backgroundColor: iconColor,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              color: '#FFFFFF',
            }}
          >
            {icon}
          </div>
        )}

        {/* Label */}
        <span
          style={{
            flex: 1,
            fontSize: '17px',
            fontWeight: 400,
            color: destructive ? '#FF3B30' : '#000000',
            fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
            lineHeight: 1.3,
          }}
        >
          {label}
        </span>

        {/* Right side: value + chevron */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
          {value !== undefined && (
            <span
              style={{
                fontSize: '17px',
                fontWeight: 400,
                color: '#8E8E93',
                fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
              }}
            >
              {value}
            </span>
          )}
          {showChevron && (
            <ChevronRight size={16} color="#C7C7CC" strokeWidth={2} />
          )}
        </div>
      </div>

      {/* Separator line — inset to match iOS style */}
      {showSeparator && (
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: icon ? '57px' : '16px',
            right: 0,
            height: '0.5px',
            backgroundColor: '#C6C6C8',
          }}
        />
      )}
    </div>
  );
}
