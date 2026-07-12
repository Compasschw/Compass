/**
 * Component test for DocumentationModal — proves the 2026-07-12 redesign:
 *  - Members Served / Member Goals Discussed / Resources Referred /
 *    Follow-Up Needed / AI Summary are gone from the rendered form.
 *  - Session Start / Session End are CHW-editable, pre-filled from
 *    `sessionStartedAt` / `sessionEndedAt`.
 *  - Units to Bill recomputes live as the CHW edits Session End.
 *  - Submit stays disabled while End <= Start (and re-enables once fixed).
 *
 * No `memberId` prop is passed in these tests, so `useCaseNotes` (the one
 * network-backed hook DocumentationModal still calls) stays disabled — see
 * its `enabled: visible && !!memberId` gate — so no `api()` mock is needed;
 * this is a pure component test against a live (but idle) QueryClient.
 *
 * Tier 2 — jsdom + react-native-web (see native/TESTING.md).
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// DocumentationModal pulls in the `../ui` barrel (for Card/SectionHeader),
// which also re-exports DashboardSidebar → @react-navigation/native. That
// package's real ESM build does an extension-less `import ... from
// './useBackButton'` that Vite/vite-node's resolver can't satisfy under
// jsdom (Metro's platform-extension resolver isn't in play here), so loading
// the real module throws ERR_MODULE_NOT_FOUND. Nothing under test actually
// calls into navigation, so a literal stub is enough — same fix as
// CHWMessagesScreen.test.tsx.
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: vi.fn(),
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
    setOptions: vi.fn(),
  }),
  useRoute: () => ({ params: {} }),
}));

import { DocumentationModal, type DocumentationModalProps } from './DocumentationModal';

// Local wall-clock fixtures built the same way the implementation reads them
// back (via `new Date(iso)` local getters) — round-trips correctly no matter
// what timezone the test runner is in, unlike hardcoding a UTC ISO string
// and a separately-hardcoded expected local display. The comments record the
// exact "MM/DD/YYYY HH:MM" string each ISO value round-trips to/from, since
// that string is what the assertions below match against.
const START_ISO = new Date(2026, 6, 12, 9, 0, 0).toISOString(); // "07/12/2026 09:00"
const END_ISO_50MIN = new Date(2026, 6, 12, 9, 50, 0).toISOString(); // "07/12/2026 09:50" (50 min → 2 units)

function renderModal(overrides: Partial<DocumentationModalProps> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <QueryClientProvider client={qc}>
      <DocumentationModal
        visible
        onClose={onClose}
        sessionId="sess-1"
        onSubmit={onSubmit}
        {...overrides}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onSubmit, onClose };
}

/** Finds the element whose full text content is exactly `text`, regardless
 *  of how react-native-web splits it across child text nodes. */
function getByExactText(text: string): HTMLElement {
  return screen.getByText((_, element) => element?.textContent?.trim() === text);
}

function setDateTimeField(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Expands the "Counseling & Wellness" Z-code category and selects Z71.89. */
function selectADiagnosisCode(): void {
  fireEvent.click(screen.getByLabelText('Counseling & Wellness'));
  fireEvent.click(
    screen.getByLabelText('Z71.89: Other specified counseling'),
  );
}

function fillNotes(text: string): void {
  fireEvent.change(
    screen.getByLabelText('Your notes — CHW-authored. Type @ to mention a resource.'),
    { target: { value: text } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DocumentationModal — redesigned sections', () => {
  it('removes Members Served, Member Goals, Resources Referred, Follow-Up, and AI Summary', () => {
    renderModal();

    expect(screen.queryByText('Members Served')).toBeNull();
    expect(screen.queryByText('Member Goals Discussed')).toBeNull();
    expect(screen.queryByText('Resources Referred')).toBeNull();
    expect(screen.queryByText('Follow-Up Needed?')).toBeNull();
    expect(screen.queryByText('AI Summary')).toBeNull();
  });

  it('keeps Diagnosis Codes, Procedure, Your Notes, Session Time, and Units to Bill', () => {
    renderModal();

    expect(screen.getByText('Diagnosis Codes (Z-Codes)')).toBeTruthy();
    expect(screen.getByText('Procedure and Modifiers')).toBeTruthy();
    expect(screen.getByText('Your Notes')).toBeTruthy();
    expect(screen.getByText('Session Time')).toBeTruthy();
    expect(screen.getByText('Units to Bill')).toBeTruthy();
  });
});

describe('DocumentationModal — Session Start/End + live Units to Bill', () => {
  it('pre-fills Session Start/End from props and shows the derived unit count', () => {
    renderModal({ sessionStartedAt: START_ISO, sessionEndedAt: END_ISO_50MIN });

    const startInput = screen.getByLabelText('Session start date and time') as HTMLInputElement;
    const endInput = screen.getByLabelText('Session end date and time') as HTMLInputElement;
    expect(startInput.value).toBe('07/12/2026 09:00');
    expect(endInput.value).toBe('07/12/2026 09:50');

    // 50-minute duration falls in the 45–75 min bracket → 2 units.
    expect(getByExactText('2 units')).toBeTruthy();
  });

  it('leaves both fields blank when sessionStartedAt/sessionEndedAt are not provided', () => {
    renderModal();

    const startInput = screen.getByLabelText('Session start date and time') as HTMLInputElement;
    const endInput = screen.getByLabelText('Session end date and time') as HTMLInputElement;
    expect(startInput.value).toBe('');
    expect(endInput.value).toBe('');
  });

  it('recomputes Units to Bill live as the CHW edits Session End', () => {
    renderModal({ sessionStartedAt: START_ISO, sessionEndedAt: END_ISO_50MIN });

    expect(getByExactText('2 units')).toBeTruthy();

    // Push the end time out to a 90-minute duration → 3-unit bracket.
    setDateTimeField('Session end date and time', '07/12/2026 10:30');

    expect(getByExactText('3 units')).toBeTruthy();
    expect(screen.queryByText('2 units')).toBeNull();
  });
});

describe('DocumentationModal — Submit gating on session times', () => {
  it('stays disabled while End <= Start, even with notes/diagnosis/procedure filled in', () => {
    renderModal({ sessionStartedAt: START_ISO, sessionEndedAt: END_ISO_50MIN });

    selectADiagnosisCode();
    fillNotes('Discussed housing options and next steps.');

    const submit = screen.getByLabelText('Submit documentation and billing');
    // Valid end (> start) + diagnosis + procedure (defaults to the first
    // code) + notes → enabled.
    expect(submit.getAttribute('aria-disabled')).not.toBe('true');

    // Move End to before Start — must re-disable and surface an inline error.
    setDateTimeField('Session end date and time', '07/12/2026 08:00');

    expect(submit.getAttribute('aria-disabled')).toBe('true');
    // Shown both as the inline field error and the footer validation hint.
    expect(screen.getAllByText('Session end must be after session start.').length).toBeGreaterThan(0);
  });

  it('stays disabled when the session time fields are empty/unfilled', () => {
    renderModal(); // no sessionStartedAt/sessionEndedAt — fields start blank

    selectADiagnosisCode();
    fillNotes('Discussed housing options and next steps.');

    const submit = screen.getByLabelText('Submit documentation and billing');
    expect(submit.getAttribute('aria-disabled')).toBe('true');
  });

  it('re-enables once End is fixed back to after Start', () => {
    renderModal({ sessionStartedAt: START_ISO, sessionEndedAt: END_ISO_50MIN });

    selectADiagnosisCode();
    fillNotes('Discussed housing options and next steps.');

    const submit = screen.getByLabelText('Submit documentation and billing');
    setDateTimeField('Session end date and time', '07/12/2026 08:00');
    expect(submit.getAttribute('aria-disabled')).toBe('true');

    setDateTimeField('Session end date and time', '07/12/2026 10:30');
    expect(submit.getAttribute('aria-disabled')).not.toBe('true');
  });
});
