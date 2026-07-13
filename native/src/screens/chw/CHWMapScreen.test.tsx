/**
 * Component test for CHWMapScreen's "Open Profile" call site (Epic S —
 * dynamic "Back to …" link on Member Profile).
 *
 * Opening a member's profile from the map must pass `backLabel: 'Map'` /
 * `backTo: 'Map'` so CHWMemberProfileScreen's web back-link reads "Back to
 * Map" and returns here (see CHWMemberProfileScreen.test.tsx for the
 * receiving-side assertions).
 *
 * `components/map/CHWDualMapView` is the Mapbox (react-map-gl) visualization
 * layer — under Vitest's plain module resolution (no Metro platform
 * extensions), importing it resolves to `CHWDualMapView.tsx`, the
 * non-web/native stub that renders `null`, so member pins can never be
 * reached through the real component in this harness. It's mocked here with
 * a minimal pressable stand-in that exposes the same `onMemberPress` callback
 * prop, so the test still exercises CHWMapScreen's OWN production wiring —
 * `handleMemberPress` → `MemberSheet` → `handleOpenMemberProfile` →
 * `navigation.navigate(...)` — end to end; only the third-party map
 * rendering is stubbed, not any Compass logic under test.
 *
 * Only the network boundary (`../../hooks/useApiQueries`'s `api` import via
 * `../../api/client`), the map view, and navigation are mocked — Tier 2
 * (jsdom + react-native-web, see native/TESTING.md).
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { Text, TouchableOpacity } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});
// See CHWCalendarScreen.test.tsx for why this needs a full literal
// replacement rather than `importOriginal`. `mockNavigate` is hoisted so
// every `useNavigation()` call returns the SAME spy.
const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
  }),
}));
// Minimal stand-in for the Mapbox visualization layer — see file header for
// why the real component can't be exercised in this harness. Renders one
// pressable per member pin so the test can trigger the real
// `onMemberPress` callback CHWMapScreen passes down.
vi.mock('../../components/map/CHWDualMapView', () => ({
  CHWDualMapView: (props: {
    memberPins: Array<{ id: string; displayName: string }>;
    onMemberPress: (pin: { id: string; displayName: string }) => void;
  }) => (
    <>
      {props.memberPins.map((pin) => (
        <TouchableOpacity
          key={pin.id}
          accessibilityRole="button"
          accessibilityLabel={`mock-member-pin-${pin.id}`}
          onPress={() => props.onMemberPress(pin)}
        >
          <Text>{pin.displayName}</Text>
        </TouchableOpacity>
      ))}
    </>
  ),
}));

import { api } from '../../api/client';
import { CHWMapScreen } from './CHWMapScreen';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const MEMBER_ID = 'member-1';
const MEMBER_PIN_DISPLAY_NAME = 'M.';

const mapDataFixture = {
  members: [
    {
      id: MEMBER_ID,
      display_name: MEMBER_PIN_DISPLAY_NAME,
      zip_code: '93701',
      latitude: 36.7,
      longitude: -119.7,
      primary_categories: ['housing'],
      session_count: 2,
    },
  ],
  resources: [],
};

function routeApi(path: string, options?: { method?: string }): unknown {
  const method = options?.method ?? 'GET';

  if (path === '/chw/map-data' && method === 'GET') {
    return mapDataFixture;
  }

  throw new Error(`Unhandled api() call in CHWMapScreen test: ${method} ${path}`);
}

// ─── Harness ──────────────────────────────────────────────────────────────────

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CHWMapScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockNavigate.mockClear();
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string }) =>
    routeApi(path, options),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CHWMapScreen — Member Profile origin params (Epic S "Back to …")', () => {
  it('opening a member from the map ("Open Profile" in the member sheet) passes backLabel "Map" / backTo "Map"', async () => {
    renderScreen();

    const pin = await screen.findByLabelText(`mock-member-pin-${MEMBER_ID}`);
    fireEvent.click(pin);

    const openProfileBtn = await screen.findByLabelText('Open member profile');
    fireEvent.click(openProfileBtn);

    expect(mockNavigate).toHaveBeenCalledWith('SessionsStack', {
      screen: 'MemberProfile',
      params: { memberId: MEMBER_ID, backLabel: 'Map', backTo: 'Map' },
    });
  });
});
