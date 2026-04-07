// ─── Types ────────────────────────────────────────────────────────────────────

interface IOSToggleProps {
  value: boolean;
  onChange: (value: boolean) => void;
  /** Accessible label for the toggle */
  label?: string;
  disabled?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * iOS-style toggle switch.
 * Green (#34C759) when on, gray (#E5E5EA) when off.
 * Smooth 200ms transition matching native iOS feel.
 */
export function IOSToggle({ value, onChange, label, disabled = false }: IOSToggleProps) {
  return (
    <button
      role="switch"
      aria-checked={value}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!value)}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        width: '51px',
        height: '31px',
        borderRadius: '15.5px',
        backgroundColor: value ? '#34C759' : '#E5E5EA',
        border: 'none',
        padding: 0,
        cursor: disabled ? 'default' : 'pointer',
        transition: 'background-color 200ms ease',
        outline: 'none',
        flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
        WebkitTapHighlightColor: 'transparent',
        boxShadow: value
          ? 'inset 0 0 0 0.5px rgba(0,0,0,0.04)'
          : 'inset 0 0 0 0.5px rgba(0,0,0,0.12)',
      }}
    >
      {/* Thumb (white circle) */}
      <div
        style={{
          position: 'absolute',
          left: value ? '22px' : '2px',
          width: '27px',
          height: '27px',
          borderRadius: '50%',
          backgroundColor: '#FFFFFF',
          boxShadow: '0 2px 6px rgba(0,0,0,0.25), 0 0.5px 1px rgba(0,0,0,0.12)',
          transition: 'left 200ms ease',
        }}
      />
    </button>
  );
}
