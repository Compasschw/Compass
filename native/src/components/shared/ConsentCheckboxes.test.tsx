/**
 * Component test for ConsentCheckboxes — the shared required-consent block used
 * by both member-signup surfaces. Tier 2 (jsdom + react-native-web). Verifies
 * the two rows render as accessible checkboxes, reflect their checked state, and
 * emit a toggle when tapped.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ConsentCheckboxes, type ConsentPalette } from './ConsentCheckboxes';

const PALETTE: ConsentPalette = {
  accent: '#6B8F71',
  text: '#111827',
  muted: '#6B7280',
  border: '#E5E7EB',
  checkmark: '#FFFFFF',
  fontRegular: 'System',
  fontSemibold: 'System',
};

function renderBlock(overrides: Partial<React.ComponentProps<typeof ConsentCheckboxes>> = {}) {
  const onToggleTerms = vi.fn();
  const onToggleCommunications = vi.fn();
  render(
    <ConsentCheckboxes
      intro="Before creating your account, please review and agree:"
      termsPrefix="I agree to the Compass"
      communicationsLabel="I consent to receive calls and text messages from Compass and my Community Health Worker about my care."
      termsAccepted={false}
      communicationsConsent={false}
      onToggleTerms={onToggleTerms}
      onToggleCommunications={onToggleCommunications}
      palette={PALETTE}
      {...overrides}
    />,
  );
  return { onToggleTerms, onToggleCommunications };
}

describe('ConsentCheckboxes', () => {
  it('renders the intro line and both checkbox rows', () => {
    renderBlock();
    expect(
      screen.getByText('Before creating your account, please review and agree:'),
    ).toBeTruthy();
    expect(screen.getByTestId('consent-terms')).toBeTruthy();
    expect(screen.getByTestId('consent-communications')).toBeTruthy();
    // The Terms of Service + Privacy Policy phrases render (bold spans).
    expect(screen.getByText('Terms of Service')).toBeTruthy();
    expect(screen.getByText('Privacy Policy')).toBeTruthy();
  });

  it('reflects the unchecked state via aria-checked=false', () => {
    renderBlock();
    expect(screen.getByTestId('consent-terms').getAttribute('aria-checked')).toBe('false');
    expect(
      screen.getByTestId('consent-communications').getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('reflects the checked state via aria-checked=true and shows a checkmark', () => {
    renderBlock({ termsAccepted: true, communicationsConsent: true });
    expect(screen.getByTestId('consent-terms').getAttribute('aria-checked')).toBe('true');
    expect(
      screen.getByTestId('consent-communications').getAttribute('aria-checked'),
    ).toBe('true');
    // Two checkmark glyphs — one per checked box.
    expect(screen.getAllByText('✓')).toHaveLength(2);
  });

  it('calls the matching toggle when a row is tapped', () => {
    const { onToggleTerms, onToggleCommunications } = renderBlock();
    fireEvent.click(screen.getByTestId('consent-terms'));
    expect(onToggleTerms).toHaveBeenCalledTimes(1);
    expect(onToggleCommunications).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('consent-communications'));
    expect(onToggleCommunications).toHaveBeenCalledTimes(1);
  });

  it('does not emit toggles when disabled', () => {
    const { onToggleTerms, onToggleCommunications } = renderBlock({ disabled: true });
    fireEvent.click(screen.getByTestId('consent-terms'));
    fireEvent.click(screen.getByTestId('consent-communications'));
    expect(onToggleTerms).not.toHaveBeenCalled();
    expect(onToggleCommunications).not.toHaveBeenCalled();
  });

  it('renders Terms / Privacy as links when press handlers are provided', () => {
    const onPressTerms = vi.fn();
    const onPressPrivacy = vi.fn();
    renderBlock({ onPressTerms, onPressPrivacy });
    fireEvent.click(screen.getByText('Terms of Service'));
    expect(onPressTerms).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Privacy Policy'));
    expect(onPressPrivacy).toHaveBeenCalledTimes(1);
  });
});
