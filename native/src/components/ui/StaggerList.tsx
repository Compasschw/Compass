/**
 * StaggerList — cascading mount animation for lists of items.
 *
 * Wraps each direct child in an `Animated.View` that fades from opacity 0→1
 * and slides from translateY 8→0 over `durationMs` (default 240ms), starting
 * after `index * delayMs` (default 50ms). Uses `useNativeDriver: true` so the
 * animation runs on the UI thread on native and composes on the GPU on web.
 *
 * Rules of Hooks prevent calling a hook inside `.map()`, so this component
 * encapsulates the per-item `Animated.Value` creation and the stagger timing
 * logic. Callers pass children as normal JSX:
 *
 * ```tsx
 * <StaggerList delayMs={50} durationMs={240}>
 *   {items.map(item => <SessionCard key={item.id} session={item} />)}
 * </StaggerList>
 * ```
 *
 * Animations are cleaned up on unmount to prevent memory leaks.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StaggerListProps {
  /**
   * Stagger offset between adjacent children in milliseconds.
   * Each child starts animating `index * delayMs` after mount.
   * @default 50
   */
  delayMs?: number;
  /**
   * Duration of each child's individual fade+slide animation.
   * @default 240
   */
  durationMs?: number;
  children: React.ReactNode;
}

// ─── Sub-component: single staggered item ────────────────────────────────────

interface StaggerItemProps {
  delay: number;
  duration: number;
  children: React.ReactNode;
}

/**
 * Internal wrapper that owns a single item's `opacity` and `translateY`
 * Animated values. Separated so each item has isolated state and the parent
 * list does not re-create refs on re-render.
 */
function StaggerItem({ delay, duration, children }: StaggerItemProps): React.JSX.Element {
  const opacity    = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(8)).current;

  useEffect(() => {
    const animation = Animated.parallel([
      Animated.timing(opacity, {
        toValue:         1,
        duration,
        delay,
        easing:          Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue:         0,
        duration,
        delay,
        easing:          Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]);

    animation.start();

    return () => {
      animation.stop();
      opacity.stopAnimation();
      translateY.stopAnimation();
    };
  }, [opacity, translateY, delay, duration]);

  return (
    <Animated.View
      style={{
        opacity,
        transform: [{ translateY }],
      }}
    >
      {children}
    </Animated.View>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Cascading entrance animation for list content.
 *
 * Place any number of children inside; each receives an automatic stagger
 * offset so items enter sequentially rather than all at once.
 *
 * ```tsx
 * <StaggerList>
 *   <MemberCard key="a" />
 *   <MemberCard key="b" />
 *   <MemberCard key="c" />
 * </StaggerList>
 * ```
 */
export function StaggerList({
  delayMs  = 50,
  durationMs = 240,
  children,
}: StaggerListProps): React.JSX.Element {
  const items = React.Children.toArray(children);

  return (
    <>
      {items.map((child, index) => (
        <StaggerItem
          key={(child as React.ReactElement).key ?? index}
          delay={index * delayMs}
          duration={durationMs}
        >
          {child}
        </StaggerItem>
      ))}
    </>
  );
}
