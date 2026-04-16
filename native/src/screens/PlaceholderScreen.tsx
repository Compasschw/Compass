/**
 * Generic placeholder screen used during scaffolding.
 * Replace with real screen components as features are built out.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme/colors';
import { typography } from '../theme/typography';

interface PlaceholderScreenProps {
  name: string;
}

export function PlaceholderScreen({ name }: PlaceholderScreenProps): React.JSX.Element {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>{name}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  text: {
    ...typography.displaySm,
    color: colors.foreground,
  },
});
