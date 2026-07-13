/**
 * Component test for PromptDialog — the reusable text/password-input modal
 * built for Epic G2's mandatory first-login password change (and intended
 * for later reuse by the B2/B3 rating-prompt work).
 *
 * Pure component test — no network boundary to mock (PromptDialog owns no
 * fetching; the caller supplies values/handlers). Tier 2 (jsdom +
 * react-native-web, see native/TESTING.md).
 */
import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PromptDialog, type PromptDialogField } from './PromptDialog';

const FIELDS: PromptDialogField[] = [
  { key: 'currentPassword', label: 'Current password', secureTextEntry: true },
  { key: 'newPassword', label: 'New password', secureTextEntry: true },
];

/** Thin controlled harness so tests exercise the real onChangeValue wiring,
 * the same way a production caller (e.g. MemberHomeScreen) would. */
function ControlledPromptDialog(props: {
  onConfirm: () => void;
  onCancel?: () => void;
  submitting?: boolean;
  errorText?: string | null;
  fields?: PromptDialogField[];
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <PromptDialog
      visible
      title="Set your password"
      message="Please set a new password before continuing."
      fields={props.fields ?? FIELDS}
      values={values}
      onChangeValue={(key, value) => setValues((prev) => ({ ...prev, [key]: value }))}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
      confirmLabel="Update password"
      cancelLabel="Not now"
      submitting={props.submitting}
      errorText={props.errorText}
    />
  );
}

describe('PromptDialog', () => {
  it('renders nothing when visible is false', () => {
    const { container } = render(
      <PromptDialog
        visible={false}
        title="Hidden"
        fields={FIELDS}
        values={{}}
        onChangeValue={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders the title, message, and one input per field', () => {
    render(<ControlledPromptDialog onConfirm={vi.fn()} />);

    expect(screen.getByText('Set your password')).toBeTruthy();
    expect(screen.getByText('Please set a new password before continuing.')).toBeTruthy();
    expect(screen.getByLabelText('Current password')).toBeTruthy();
    expect(screen.getByLabelText('New password')).toBeTruthy();
  });

  it('does not render a Cancel button when onCancel is omitted (mandatory prompt)', () => {
    render(<ControlledPromptDialog onConfirm={vi.fn()} />);
    expect(screen.queryByLabelText('Not now')).toBeNull();
  });

  it('renders and wires a Cancel button when onCancel is supplied', () => {
    const onCancel = vi.fn();
    render(<ControlledPromptDialog onConfirm={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByLabelText('Not now'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('routes typed text through onChangeValue by field key', () => {
    render(<ControlledPromptDialog onConfirm={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'temp-pass-1234' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'brand-new-password-1' },
    });

    expect(screen.getByLabelText('Current password')).toHaveProperty('value', 'temp-pass-1234');
    expect(screen.getByLabelText('New password')).toHaveProperty('value', 'brand-new-password-1');
  });

  it('calls onConfirm when the confirm button is pressed', () => {
    const onConfirm = vi.fn();
    render(<ControlledPromptDialog onConfirm={onConfirm} />);

    fireEvent.click(screen.getByLabelText('Update password'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('shows a form-level error banner', () => {
    render(<ControlledPromptDialog onConfirm={vi.fn()} errorText="Current password is incorrect." />);
    expect(screen.getByText('Current password is incorrect.')).toBeTruthy();
  });

  it('shows a field-level error next to the relevant input', () => {
    const fieldsWithError: PromptDialogField[] = [
      { key: 'currentPassword', label: 'Current password', secureTextEntry: true },
      {
        key: 'newPassword',
        label: 'New password',
        secureTextEntry: true,
        errorText: 'Must be at least 8 characters.',
      },
    ];
    render(<ControlledPromptDialog onConfirm={vi.fn()} fields={fieldsWithError} />);
    expect(screen.getByText('Must be at least 8 characters.')).toBeTruthy();
  });

  it('disables the confirm button while submitting', () => {
    render(<ControlledPromptDialog onConfirm={vi.fn()} submitting />);
    const confirmButton = screen.getByLabelText('Update password');
    expect(confirmButton.getAttribute('aria-disabled')).toBe('true');
  });

  // ── Epic B3: maxLength + live counter (additive props) ──────────────────

  it('renders no counter when a field omits maxLength (default, G2-compatible)', () => {
    render(<ControlledPromptDialog onConfirm={vi.fn()} />);
    // Neither password field sets maxLength — no "N/max" text anywhere.
    expect(screen.queryByText(/^\d+\/\d+$/)).toBeNull();
  });

  it('renders a live "N/max" counter for a field with maxLength set', () => {
    const fieldsWithCounter: PromptDialogField[] = [
      { key: 'feedback', label: 'Feedback', maxLength: 120, multiline: true },
    ];
    render(<ControlledPromptDialog onConfirm={vi.fn()} fields={fieldsWithCounter} />);

    expect(screen.getByText('0/120')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Feedback'), {
      target: { value: 'Great CHW, very helpful!' },
    });

    expect(screen.getByText('24/120')).toBeTruthy();
  });

  it('caps input at maxLength via the native maxLength attribute', () => {
    const fieldsWithCounter: PromptDialogField[] = [
      { key: 'feedback', label: 'Feedback', maxLength: 120, multiline: true },
    ];
    render(<ControlledPromptDialog onConfirm={vi.fn()} fields={fieldsWithCounter} />);

    const input = screen.getByLabelText('Feedback') as HTMLTextAreaElement | HTMLInputElement;
    expect(input.maxLength).toBe(120);
  });
});
