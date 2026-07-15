/**
 * Component test for PressableMember — proves the Epic S follow-up contract:
 * optional `backLabel`/`backTo` props thread into the MemberProfile
 * navigation params (`{ memberId, backLabel?, backTo? }`) when both are
 * provided, and are omitted entirely (today's default — pre-Epic-S-follow-up
 * behavior) when either is absent, so existing consumers that don't pass them
 * (e.g. CHWJourneysScreen) see no behavior change.
 *
 * Tier 2 — jsdom + react-native-web (see native/TESTING.md).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
  }),
}));

import { PressableMember } from './PressableMember';

const MEMBER_ID = 'member-42';
const DISPLAY_NAME = 'Rosa Gutierrez';

beforeEach(() => {
  mockNavigate.mockClear();
});

describe('PressableMember — Epic S follow-up: optional backLabel/backTo', () => {
  it('navigates to MemberProfile WITHOUT backLabel/backTo when neither prop is passed (default, unchanged)', () => {
    render(
      <PressableMember memberId={MEMBER_ID} displayName={DISPLAY_NAME}>
        <span>member row</span>
      </PressableMember>,
    );

    screen.getByLabelText(`Open ${DISPLAY_NAME}'s profile`).click();

    expect(mockNavigate).toHaveBeenCalledWith('SessionsStack', {
      screen: 'MemberProfile',
      params: { memberId: MEMBER_ID },
    });
    const params = mockNavigate.mock.calls[0][1].params;
    expect(params).not.toHaveProperty('backLabel');
    expect(params).not.toHaveProperty('backTo');
  });

  it('threads backLabel/backTo into the MemberProfile navigation params when both are provided', () => {
    render(
      <PressableMember
        memberId={MEMBER_ID}
        displayName={DISPLAY_NAME}
        backLabel="Dashboard"
        backTo="DashboardStack"
      >
        <span>member row</span>
      </PressableMember>,
    );

    screen.getByLabelText(`Open ${DISPLAY_NAME}'s profile`).click();

    expect(mockNavigate).toHaveBeenCalledWith('SessionsStack', {
      screen: 'MemberProfile',
      params: { memberId: MEMBER_ID, backLabel: 'Dashboard', backTo: 'DashboardStack' },
    });
  });

  it('threads backLabel "Messages" / backTo "Messages" (the CHWMessagesScreen call-site contract)', () => {
    render(
      <PressableMember
        memberId={MEMBER_ID}
        displayName={DISPLAY_NAME}
        backLabel="Messages"
        backTo="Messages"
      >
        <span>member row</span>
      </PressableMember>,
    );

    screen.getByLabelText(`Open ${DISPLAY_NAME}'s profile`).click();

    expect(mockNavigate).toHaveBeenCalledWith('SessionsStack', {
      screen: 'MemberProfile',
      params: { memberId: MEMBER_ID, backLabel: 'Messages', backTo: 'Messages' },
    });
  });

  it('renders children without a Pressable wrapper when enabled is false, regardless of backLabel/backTo', () => {
    render(
      <PressableMember
        memberId={MEMBER_ID}
        displayName={DISPLAY_NAME}
        enabled={false}
        backLabel="Dashboard"
        backTo="DashboardStack"
      >
        <span>member row</span>
      </PressableMember>,
    );

    expect(screen.queryByLabelText(`Open ${DISPLAY_NAME}'s profile`)).toBeNull();
    expect(screen.getByText('member row')).toBeTruthy();
  });
});
