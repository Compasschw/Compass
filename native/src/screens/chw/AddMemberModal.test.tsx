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
  setText('Member full name', 'Jordan Rivera');
  setText('Member email', 'jordan@example.com');
  setText('Temporary password', 'temp-pass-1234');
  setText('Member date of birth in MM/DD/YYYY format', '04/12/1990');
  fireEvent.click(screen.getByLabelText('Sex Female'));
  fireEvent.click(screen.getByLabelText('Select insurance company'));
  fireEvent.click(screen.getByLabelText('Health Net'));
  setText('Member CIN Medi-Cal ID', '12345678A');
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

  it('does not submit when only one consent box is checked', async () => {
    renderModal();
    fillRequiredFields();
    fireEvent.click(screen.getByTestId('consent-communications')); // only one

    fireEvent.click(screen.getByLabelText('Add member'));
    expect(mockedApi).not.toHaveBeenCalled();
  });
});
