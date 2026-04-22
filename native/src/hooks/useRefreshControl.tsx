/**
 * useRefreshControl — small hook that wires the ScrollView / FlatList
 * `refreshControl` prop to a set of TanStack Query refetchers.
 *
 * Usage:
 *   const refresh = useRefreshControl([query1.refetch, query2.refetch]);
 *   <ScrollView refreshControl={refresh.control} ... />
 *
 * Why this exists: pull-to-refresh is the same 10 lines on every screen —
 * stale state in `refreshing`, an async onRefresh that awaits all refetches,
 * the RefreshControl element. Centralizing it here keeps every screen
 * consistent and cuts the per-screen change to three lines.
 */

import React, { useCallback, useState } from 'react';
import { RefreshControl } from 'react-native';

import { colors } from '../theme/colors';

export interface RefreshControlBundle {
  /** Controlled `refreshing` flag — true while any refetch is in flight. */
  refreshing: boolean;
  /** Async callback to pass as onRefresh. */
  onRefresh: () => Promise<void>;
  /** Pre-built <RefreshControl /> element — drop into ScrollView.refreshControl. */
  control: React.ReactElement<React.ComponentProps<typeof RefreshControl>>;
}

/**
 * @param refetchers Array of TanStack Query `refetch` fns (or any async ()=>Promise<unknown>).
 *                   All are awaited in parallel on pull.
 */
export function useRefreshControl(
  refetchers: Array<() => Promise<unknown>>,
): RefreshControlBundle {
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all(refetchers.map((fn) => fn()));
    } catch {
      // Swallow — individual query error states already drive their own UI
      // via TanStack Query; a failed refetch shouldn't crash the pull-to-refresh.
    } finally {
      setRefreshing(false);
    }
    // Depend on the array identity — screens pass a freshly composed array
    // each render, which is fine since refetchers are stable methods on the
    // query objects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, refetchers);

  const control = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      tintColor={colors.primary}
      colors={[colors.primary]}
    />
  );

  return { refreshing, onRefresh, control };
}
