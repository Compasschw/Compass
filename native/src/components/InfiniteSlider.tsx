/**
 * InfiniteSlider — cross-platform infinite horizontal scrolling marquee.
 *
 * Continuously scrolls its children from right to left (or left to right with
 * `reverse`). The children row is rendered twice so the loop is seamless.
 *
 * Works on iOS, Android, and web via React Native's Animated API.
 * Use `useNativeDriver: true` for smooth 60fps animation on all platforms.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Animated, Easing, View, type LayoutChangeEvent } from 'react-native';

interface InfiniteSliderProps {
  children: React.ReactNode;
  /** Horizontal gap between items in px. */
  gap?: number;
  /** Total loop duration in seconds (lower = faster). */
  duration?: number;
  /** Reverse direction (left to right). */
  reverse?: boolean;
  /** Apply a fade mask on both edges. Web only. */
  fadeEdges?: boolean;
  style?: React.ComponentProps<typeof View>['style'];
}

export function InfiniteSlider({
  children,
  gap = 24,
  duration = 40,
  reverse = false,
  fadeEdges = true,
  style,
}: InfiniteSliderProps): React.JSX.Element {
  const translateX = useRef(new Animated.Value(0)).current;
  const [contentWidth, setContentWidth] = useState(0);
  const animationRef = useRef<Animated.CompositeAnimation | null>(null);

  // Measure the width of a single copy of the children. We duplicate them
  // internally, so the measured width must be divided by 2.
  const handleContentLayout = useCallback((e: LayoutChangeEvent): void => {
    const w = e.nativeEvent.layout.width;
    // Divide by 2 because we render the children twice.
    const singleCopyWidth = w / 2;
    if (Math.abs(singleCopyWidth - contentWidth) > 1) {
      setContentWidth(singleCopyWidth);
    }
  }, [contentWidth]);

  useEffect(() => {
    if (contentWidth <= 0) return;

    const from = reverse ? -contentWidth : 0;
    const to = reverse ? 0 : -contentWidth;

    translateX.setValue(from);

    const loop = Animated.loop(
      Animated.timing(translateX, {
        toValue: to,
        duration: duration * 1000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
      { resetBeforeIteration: true },
    );

    animationRef.current = loop;
    loop.start();

    return () => {
      loop.stop();
    };
  }, [contentWidth, duration, reverse, translateX]);

  // Web-only edge fade using CSS maskImage (no-op on native)
  const maskStyle = fadeEdges
    ? ({
        maskImage: 'linear-gradient(to right, transparent, black 10%, black 90%, transparent)',
        WebkitMaskImage: 'linear-gradient(to right, transparent, black 10%, black 90%, transparent)',
      } as Record<string, unknown>)
    : null;

  return (
    <View style={[{ overflow: 'hidden' }, maskStyle, style]}>
      <Animated.View
        onLayout={handleContentLayout}
        style={{
          flexDirection: 'row',
          transform: [{ translateX }],
        }}
      >
        {/* First copy of children */}
        <View style={{ flexDirection: 'row', gap, paddingRight: gap }}>
          {children}
        </View>
        {/* Second copy for seamless loop */}
        <View style={{ flexDirection: 'row', gap, paddingRight: gap }}>
          {children}
        </View>
      </Animated.View>
    </View>
  );
}
