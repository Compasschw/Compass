/**
 * Component test for AppDialogProvider — the global in-app replacement for
 * `window.alert`. Exercises the real call path: `showAlert()` (called the
 * way the ~17 production call sites call it, including outside React, e.g.
 * a mutation's `onError`) enqueues onto the module-level alertQueue store;
 * this provider is the sole subscriber and renders the front of the queue.
 * Tier 2 — jsdom + react-native-web (see native/TESTING.md).
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppDialogProvider } from './AppDialogProvider';
import { __resetAlertQueueForTests } from '../../utils/alertQueue';
import { showAlert } from '../../utils/showAlert';

beforeEach(() => {
  __resetAlertQueueForTests();
});

afterEach(() => {
  __resetAlertQueueForTests();
});

describe('AppDialogProvider', () => {
  it('renders nothing when no alert is queued', () => {
    const { container } = render(<AppDialogProvider />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the dialog with the title and message from showAlert()', () => {
    render(<AppDialogProvider />);

    act(() => {
      showAlert('Failed to schedule session', 'Please try again.');
    });

    expect(screen.getByText('Failed to schedule session')).toBeTruthy();
    expect(screen.getByText('Please try again.')).toBeTruthy();
  });

  it('shows the dialog with only a title when no message is passed', () => {
    render(<AppDialogProvider />);

    act(() => {
      showAlert('Begin a session first');
    });

    expect(screen.getByText('Begin a session first')).toBeTruthy();
  });

  it('dismisses on OK', () => {
    render(<AppDialogProvider />);

    act(() => {
      showAlert('Could not end session', 'Please try again.');
    });
    expect(screen.getByText('Could not end session')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('OK'));

    expect(screen.queryByText('Could not end session')).toBeNull();
  });

  it('queues a burst of alerts and shows them one at a time in order', () => {
    render(<AppDialogProvider />);

    act(() => {
      showAlert('Failed to schedule session', 'Please try again.');
      showAlert('Could not save note', 'Please try again.');
    });

    // First alert visible; second is queued, not yet shown.
    expect(screen.getByText('Failed to schedule session')).toBeTruthy();
    expect(screen.queryByText('Could not save note')).toBeNull();

    fireEvent.click(screen.getByLabelText('OK'));

    // Dismissing the first reveals the second.
    expect(screen.queryByText('Failed to schedule session')).toBeNull();
    expect(screen.getByText('Could not save note')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('OK'));
    expect(screen.queryByText('Could not save note')).toBeNull();
  });
});
