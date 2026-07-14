/**
 * Integration test for AddMemberModal (CHW "Add New Member").
 *
 * Focus: the required signup-consent gate. The Add Member button must stay
 * disabled until BOTH consent boxes are checked (in addition to the existing
 * field validation), and the create call must carry both consent booleans.
 *
 * Tier 2 (jsdom + react-native-web). Only the network boundary is mocked
 * (`../api/client` → `api`); the component, the useCreateChwMember hook, and the
 * snake_case body construction all run for real against a live QueryClient.
 */
import React from 'react';
import { Linking } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub only the network call; keep ApiError real so the component's import loads.
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});
import { api } from '../../api/client';
// Assert the on-brand success confirmation without needing AppDialogProvider
// mounted in the test tree — the modal fires showAlert() on success.
vi.mock('../../utils/showAlert', () => ({ showAlert: vi.fn() }));
import { showAlert } from '../../utils/showAlert';
import { AddMemberModal } from './AddMemberModal';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;
const mockedShowAlert = showAlert as unknown as ReturnType<typeof vi.fn>;

function renderModal() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AddMemberModal visible onClose={() => {}} />
    </QueryClientProvider>,
  );
}

function setText(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Fill every non-consent required field so clientError === null. */
function fillRequiredFields(): void {
  setText('Member first name', 'Jordan');
  setText('Member last name', 'Rivera');
  setText('Member email', 'jordan@example.com');
  setText('Member phone', '(310) 555-0142');
  setText('Temporary password', 'TempPass123!');
  setText('Member date of birth in MM/DD/YYYY format', '04/12/1990');
  fireEvent.click(screen.getByLabelText('Sex Female'));
  fireEvent.click(screen.getByLabelText('Select insurance company'));
  fireEvent.click(screen.getByLabelText('Health Net'));
  setText('Member CIN Medi-Cal ID', '12345678A');
  // Address is required for the Pear Member Import export (line 2 is optional).
  setText('Member address line 1', '123 Main St');
  setText('Member city', 'Los Angeles');
  setText('Member state', 'CA');
  setText('Member ZIP code', '90001');
}

beforeEach(() => {
  mockedApi.mockReset();
  mockedShowAlert.mockReset();
  mockedApi.mockResolvedValue({
    id: 'm1',
    name: 'Jordan Rivera',
    email: 'jordan@example.com',
  });
  // react-native-web's Linking.openURL calls window.open; stub it so link taps
  // are observable without actually opening a tab in the jsdom test runner.
  vi.spyOn(Linking, 'openURL').mockResolvedValue(true);
});

describe('AddMemberModal — required consent gate', () => {
  it('keeps Add Member disabled until BOTH consent boxes are checked', async () => {
    renderModal();
    fillRequiredFields();

    const submit = screen.getByLabelText('Add member');

    // All fields valid but no consent → disabled; pressing does nothing.
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(submit);
    expect(mockedApi).not.toHaveBeenCalled();

    // Only one box checked → still disabled.
    fireEvent.click(screen.getByTestId('consent-terms'));
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(submit);
    expect(mockedApi).not.toHaveBeenCalled();

    // Both boxes checked → enabled.
    fireEvent.click(screen.getByTestId('consent-communications'));
    expect(submit.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('sends terms_accepted + communications_consent in the create payload', async () => {
    renderModal();
    fillRequiredFields();
    fireEvent.click(screen.getByTestId('consent-terms'));
    fireEvent.click(screen.getByTestId('consent-communications'));

    fireEvent.click(screen.getByLabelText('Add member'));

    await waitFor(() => expect(mockedApi).toHaveBeenCalledTimes(1));
    const [path, options] = mockedApi.mock.calls[0];
    expect(path).toBe('/chw/members');
    const body = JSON.parse((options as { body: string }).body);
    expect(body.terms_accepted).toBe(true);
    expect(body.communications_consent).toBe(true);
    // Sanity: the rest of the payload still rides along.
    expect(body.email).toBe('jordan@example.com');
    expect(body.zip_code).toBe('90001');
  });

  it('blocks submit until the Pear-required address + phone are provided', async () => {
    // Regression: a member created without an address was silently dropped
    // from the Pear Member CSV export (is_pear_complete === false). These
    // fields are now required in the form so that can't happen.
    renderModal();
    // Everything EXCEPT phone + address filled in.
    setText('Member first name', 'Jordan');
    setText('Member last name', 'Rivera');
    setText('Member email', 'jordan@example.com');
    setText('Temporary password', 'TempPass123!');
    setText('Member date of birth in MM/DD/YYYY format', '04/12/1990');
    fireEvent.click(screen.getByLabelText('Sex Female'));
    fireEvent.click(screen.getByLabelText('Select insurance company'));
    fireEvent.click(screen.getByLabelText('Health Net'));
    setText('Member CIN Medi-Cal ID', '12345678A');
    setText('Member ZIP code', '90001');
    fireEvent.click(screen.getByTestId('consent-terms'));
    fireEvent.click(screen.getByTestId('consent-communications'));

    // Consent is satisfied, but missing phone/address keeps submit disabled.
    const submit = screen.getByLabelText('Add member');
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(submit);
    expect(mockedApi).not.toHaveBeenCalled();

    // Fill phone + address line 1 + city + state → now submittable.
    setText('Member phone', '(310) 555-0142');
    setText('Member address line 1', '123 Main St');
    setText('Member city', 'Los Angeles');
    setText('Member state', 'CA');
    expect(submit.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('surfaces an on-brand confirmation after a member is created', async () => {
    renderModal();
    fillRequiredFields();
    fireEvent.click(screen.getByTestId('consent-terms'));
    fireEvent.click(screen.getByTestId('consent-communications'));

    fireEvent.click(screen.getByLabelText('Add member'));

    await waitFor(() => expect(mockedShowAlert).toHaveBeenCalledTimes(1));
    const [title, message] = mockedShowAlert.mock.calls[0];
    expect(title).toBe('Member added');
    // Personalized to the created member and reassures the CHW they can sign in.
    expect(message).toContain('Jordan');
    expect(message).toContain('sign in');
  });

  it('accepts the 555-555-5555 no-phone sentinel', async () => {
    // CHWs enter 555-555-5555 when a member has no phone. It's 10 digits so it
    // clears the phone check; the backend treats it as SMS-ineligible.
    renderModal();
    fillRequiredFields();
    setText('Member phone', '555-555-5555');
    fireEvent.click(screen.getByTestId('consent-terms'));
    fireEvent.click(screen.getByTestId('consent-communications'));

    expect(
      screen.getByLabelText('Add member').getAttribute('aria-disabled'),
    ).not.toBe('true');
  });

  it('does not submit when only one consent box is checked', async () => {
    renderModal();
    fillRequiredFields();
    fireEvent.click(screen.getByTestId('consent-communications')); // only one

    fireEvent.click(screen.getByLabelText('Add member'));
    expect(mockedApi).not.toHaveBeenCalled();
  });
});

describe('AddMemberModal — Sex options', () => {
  it('offers only Male and Female (no "Other")', () => {
    renderModal();
    expect(screen.getByLabelText('Sex Male')).toBeTruthy();
    expect(screen.getByLabelText('Sex Female')).toBeTruthy();
    expect(screen.queryByLabelText('Sex Other')).toBeNull();
    expect(screen.queryByText('Other')).toBeNull();
  });
});

describe('AddMemberModal — Terms of Service / Privacy Policy links', () => {
  it('opens the public Terms page when "Terms of Service" is tapped', () => {
    renderModal();
    fireEvent.click(screen.getByText('Terms of Service'));
    expect(Linking.openURL).toHaveBeenCalledWith('https://joincompasschw.com/legal/terms');
  });

  it('opens the public Privacy page when "Privacy Policy" is tapped', () => {
    renderModal();
    fireEvent.click(screen.getByText('Privacy Policy'));
    expect(Linking.openURL).toHaveBeenCalledWith('https://joincompasschw.com/legal/privacy');
  });
});

describe('AddMemberModal — communications consent copy', () => {
  it('conveys call/text/email/in-person communication via the CompassCHW platform, and no-cost insurance billing', () => {
    renderModal();
    const label = screen.getByTestId('consent-communications').textContent ?? '';
    expect(label).toContain('call, text, email, or in person');
    expect(label).toContain('CompassCHW platform');
    expect(label).toContain('bill their insurance for covered services');
    expect(label).toContain('no cost to them');
  });
});

describe('AddMemberModal — QA2: first/last name split + password policy + show/hide', () => {
  it('requires BOTH first and last name as separate fields', () => {
    renderModal();
    fillRequiredFields();
    // Blank out just the last name — submit must disable again.
    setText('Member last name', '');
    expect(screen.getByLabelText('Add member').getAttribute('aria-disabled')).toBe('true');
    setText('Member last name', 'Rivera');
    setText('Member first name', '');
    expect(screen.getByLabelText('Add member').getAttribute('aria-disabled')).toBe('true');
  });

  it('rejects a temp password missing complexity (no uppercase/number/special)', () => {
    renderModal();
    fillRequiredFields();
    fireEvent.click(screen.getByTestId('consent-terms'));
    fireEvent.click(screen.getByTestId('consent-communications'));
    setText('Temporary password', 'weakpassword'); // 12 chars but no upper/digit/special
    expect(screen.getByLabelText('Add member').getAttribute('aria-disabled')).toBe('true');
    setText('Temporary password', 'TempPass123!');
    // Enabled = aria-disabled absent (null) or 'false', depending on RN-web version.
    expect(screen.getByLabelText('Add member').getAttribute('aria-disabled')).not.toBe('true');
  });

  it('temp password is hidden by default with a working show/hide toggle', () => {
    renderModal();
    const input = screen.getByLabelText('Temporary password') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.click(screen.getByLabelText('Show password'));
    expect((screen.getByLabelText('Temporary password') as HTMLInputElement).type).toBe('text');
    fireEvent.click(screen.getByLabelText('Hide password'));
    expect((screen.getByLabelText('Temporary password') as HTMLInputElement).type).toBe('password');
  });
});
