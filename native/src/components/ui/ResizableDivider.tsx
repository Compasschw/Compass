/**
 * ResizableDivider — web-only draggable column resize handle.
 *
 * Renders a 5px-wide transparent hit area between two panes. On mousedown,
 * attaches global mousemove/mouseup listeners to track the delta and calls
 * onChange with the clamped next width. On native (iOS/Android) renders null.
 *
 * Usage:
 *   <ResizableDivider width={leftWidth} onChange={setLeftWidth} min={200} max={500} />
 */

import React, { useCallback } from 'react';
import { Platform, View } from 'react-native';

export interface ResizableDividerProps {
  /** Current width (in px) of the pane this divider resizes. */
  readonly width: number;
  /** Called with the new clamped width as the user drags. */
  readonly onChange: (nextWidth: number) => void;
  /** Minimum allowed width in px. Defaults to 200. */
  readonly min?: number;
  /** Maximum allowed width in px. Defaults to 600. */
  readonly max?: number;
  /**
   * Which side of the divider the resized pane sits on.
   * - 'left'  (default): pane is LEFT of the divider — dragging right grows it.
   * - 'right': pane is RIGHT of the divider — dragging right SHRINKS it.
   */
  readonly side?: 'left' | 'right';
}

/**
 * Draggable vertical divider for web 3-pane layouts.
 * Returns null on iOS/Android — native panes use fixed widths.
 */
export function ResizableDivider({
  width,
  onChange,
  min = 200,
  max = 600,
  side = 'left',
}: ResizableDividerProps): React.JSX.Element | null {
  if (Platform.OS !== 'web') return null;

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      const sign = side === 'right' ? -1 : 1;

      const onMouseMove = (ev: MouseEvent): void => {
        const next = Math.max(min, Math.min(max, startWidth + sign * (ev.clientX - startX)));
        onChange(next);
      };

      const onMouseUp = (): void => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [width, onChange, min, max, side],
  );

  return (
    <View
      // @ts-ignore — web-only DOM event handler not in RN types
      onMouseDown={handleMouseDown}
      style={{
        width: 5,
        flexShrink: 0,
        backgroundColor: 'transparent',
        // @ts-ignore — web-only CSS properties
        cursor: 'col-resize',
        userSelect: 'none',
        zIndex: 10,
      }}
      accessibilityRole="separator"
      accessibilityLabel="Drag to resize pane"
    />
  );
}
