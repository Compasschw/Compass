/**
 * Harness smoke test — proves the jsdom + react-native-web + @testing-library
 * setup actually renders RN components and runs hooks. If this fails, the
 * component/hook harness is broken; fix it before trusting other .test.tsx files.
 */
import React, { useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { render, renderHook, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

function Counter(): React.JSX.Element {
  const [n, setN] = useState(0);
  return (
    <View>
      <Text>count: {n}</Text>
      <TouchableOpacity accessibilityRole="button" onPress={() => setN((v) => v + 1)}>
        <Text>increment</Text>
      </TouchableOpacity>
    </View>
  );
}

describe('component/hook harness', () => {
  it('renders a react-native component to the DOM', () => {
    render(<Counter />);
    expect(screen.getByText('count: 0')).toBeTruthy();
  });

  it('handles press events and re-renders', () => {
    render(<Counter />);
    fireEvent.click(screen.getByText('increment'));
    expect(screen.getByText('count: 1')).toBeTruthy();
  });

  it('runs a hook with renderHook', () => {
    const { result } = renderHook(() => useState(41));
    act(() => result.current[1](42));
    expect(result.current[0]).toBe(42);
  });
});
