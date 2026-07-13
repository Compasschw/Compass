/**
 * Component test for DocumentationModal — proves both the 2026-07-12
 * redesign and the 2026-07-13 "modal v2" redesign (Epics Q1-Q3):
 *  - Members Served / Member Goals Discussed / Resources Referred /
 *    Follow-Up Needed / AI Summary are gone from the rendered form.
 *  - Q1: Session Start / Session End render at the BOTTOM of the form
 *    (after Your Notes), CHW-editable, pre-filled from
 *    `sessionStartedAt` / `sessionEndedAt`. The old Gross/Net/Rate
 *    "Units to Bill" card is gone — replaced by a plain inline "Units: N"
 *    line with no revenue/rate display.
 *  - Q2: a session under 16 minutes shows a not-billable notice and
 *    blocks submit entirely — the CHW can never file a <16-minute claim.
 *  - Q3: Diagnosis Codes render grouped by resource-need vertical
 *    (Housing, Utilities, Food Security, Transportation, Mental Health,
 *    Healthcare, Employment, Others) instead of the old ICD-10 taxonomy
 *    categories.
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
const END_ISO_10MIN = new Date(2026, 6, 12, 9, 10, 0).toISOString(); // "07/12/2026 09:10" (10 min → 0 units, not billable)

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

/**
 * Reads the inline "Units: N" line's value specifically — distinct from
 * `getByExactText`, which would ambiguously also match a diagnosis-code
 * group's "N selected" count badge (also rendered as bare digit text).
 * Locates the "Units:" label and reads its sibling's text.
 */
function getUnitsLineValue(): string {
  const label = screen.getByText('Units:');
  const row = label.parentElement;
  if (!row) throw new Error('Units: label has no parent row');
  return row.textContent?.replace('Units:', '').trim() ?? '';
}

/** Expands the "Mental Health" vertical group and selects Z71.89 (Q3 regrouping). */
function selectADiagnosisCode(): void {
  fireEvent.click(screen.getByLabelText('Mental Health'));
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

  it('keeps Diagnosis Codes, Procedure, Your Notes, and Session Time', () => {
    renderModal();

    expect(screen.getByText('Diagnosis Codes (Z-Codes)')).toBeTruthy();
    expect(screen.getByText('Procedure and Modifiers')).toBeTruthy();
    expect(screen.getByText('Your Notes')).toBeTruthy();
    expect(screen.getByText('Session Time')).toBeTruthy();
  });

  it('Q1: removes the old Gross/Net/Rate "Units to Bill" card entirely', () => {
    renderModal({ sessionStartedAt: START_ISO, sessionEndedAt: END_ISO_50MIN });

    // The old section had its own "Units to Bill" SectionHeader — gone now,
    // replaced by a plain inline "Units:" line (asserted below).
    expect(screen.queryByText('Units to Bill')).toBeNull();
    expect(screen.queryByText('Gross')).toBeNull();
    expect(screen.queryByText('Net (85%)')).toBeNull();
    expect(screen.queryByText('Rate')).toBeNull();
    expect(screen.queryByText(/\/unit/)).toBeNull();
  });
});

describe('DocumentationModal — Q1: Session Time at the bottom + inline units line', () => {
  it('renders Session Time AFTER Your Notes (bottom of the form)', () => {
    const { container } = renderModal({
      sessionStartedAt: START_ISO,
      sessionEndedAt: END_ISO_50MIN,
    });

    const notesHeading = screen.getByText('Your Notes');
    const sessionTimeHeading = screen.getByText('Session Time');

    // DOM order: Your Notes must appear before Session Time.
    const position = notesHeading.compareDocumentPosition(sessionTimeHeading);
    // Node.DOCUMENT_POSITION_FOLLOWING === 4 — sessionTimeHeading follows notesHeading.
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container).toBeTruthy();
  });

  it('pre-fills Session Start/End from props and shows the inline computed units line', () => {
    renderModal({ sessionStartedAt: START_ISO, sessionEndedAt: END_ISO_50MIN });

    const startInput = screen.getByLabelText('Session start date and time') as HTMLInputElement;
    const endInput = screen.getByLabelText('Session end date and time') as HTMLInputElement;
    expect(startInput.value).toBe('07/12/2026 09:00');
    expect(endInput.value).toBe('07/12/2026 09:50');

    // 50-minute duration falls in the 46–75 min bracket → 2 units.
    expect(getUnitsLineValue()).toBe('2');
    expect(screen.getByText('Units:')).toBeTruthy();
  });

  it('leaves both fields blank when sessionStartedAt/sessionEndedAt are not provided', () => {
    renderModal();

    const startInput = screen.getByLabelText('Session start date and time') as HTMLInputElement;
    const endInput = screen.getByLabelText('Session end date and time') as HTMLInputElement;
    expect(startInput.value).toBe('');
    expect(endInput.value).toBe('');
  });

  it('recomputes the units line live as the CHW edits Session End', () => {
    renderModal({ sessionStartedAt: START_ISO, sessionEndedAt: END_ISO_50MIN });

    expect(getUnitsLineValue()).toBe('2');

    // Push the end time out to a 90-minute duration → 3-unit bracket.
    setDateTimeField('Session end date and time', '07/12/2026 10:30');

    expect(getUnitsLineValue()).toBe('3');
  });
});

describe('DocumentationModal — Q2: 16-minute billable floor', () => {
  it('shows the not-billable notice for a sub-16-minute session', () => {
    renderModal({ sessionStartedAt: START_ISO, sessionEndedAt: END_ISO_10MIN });

    expect(
      screen.getByText('Under 16 minutes — not billable; no claim will be filed.'),
    ).toBeTruthy();
    // No "Units:" line while below the floor — the notice replaces it.
    expect(screen.queryByText('Units:')).toBeNull();
  });

  it('blocks submit for a sub-16-minute session even with notes/diagnosis/procedure filled in', () => {
    renderModal({ sessionStartedAt: START_ISO, sessionEndedAt: END_ISO_10MIN });

    selectADiagnosisCode();
    fillNotes('Brief check-in, member was in a hurry.');

    const submit = screen.getByLabelText('Submit documentation and billing');
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    expect(
      screen.getByText(
        'Session is under 16 minutes and is not billable — no claim can be filed.',
      ),
    ).toBeTruthy();
  });

  it('re-enables submit once the session is extended past the 16-minute floor', () => {
    renderModal({ sessionStartedAt: START_ISO, sessionEndedAt: END_ISO_10MIN });

    selectADiagnosisCode();
    fillNotes('Brief check-in, member was in a hurry.');

    const submit = screen.getByLabelText('Submit documentation and billing');
    expect(submit.getAttribute('aria-disabled')).toBe('true');

    // Extend to exactly the 16-minute floor boundary → billable (1 unit).
    setDateTimeField('Session end date and time', '07/12/2026 09:16');

    expect(submit.getAttribute('aria-disabled')).not.toBe('true');
    expect(getUnitsLineValue()).toBe('1');
  });

  it('a 15-minute session (one minute under the floor) stays not billable', () => {
    renderModal({ sessionStartedAt: START_ISO, sessionEndedAt: new Date(2026, 6, 12, 9, 15, 0).toISOString() });

    expect(
      screen.getByText('Under 16 minutes — not billable; no claim will be filed.'),
    ).toBeTruthy();
  });
});

describe('DocumentationModal — Q3: diagnosis codes grouped by resource-need vertical', () => {
  it('renders vertical group headers instead of the old ICD-10 taxonomy categories', () => {
    renderModal();

    // New vertical groupings present.
    expect(screen.getByText('Housing')).toBeTruthy();
    expect(screen.getByText('Utilities')).toBeTruthy();
    expect(screen.getByText('Food Security')).toBeTruthy();
    expect(screen.getByText('Mental Health')).toBeTruthy();
    expect(screen.getByText('Healthcare')).toBeTruthy();
    expect(screen.getByText('Employment')).toBeTruthy();

    // Old category labels are gone.
    expect(screen.queryByText('Counseling & Wellness')).toBeNull();
    expect(screen.queryByText('Housing & Economic')).toBeNull();
    expect(screen.queryByText('Health Access & Literacy')).toBeNull();
    expect(screen.queryByText('Behavioral')).toBeNull();
    expect(screen.queryByText('Legal Circumstances')).toBeNull();
  });

  it('groups a housing-coded example (Z59.00 Homelessness) under the Housing group', () => {
    renderModal();

    fireEvent.click(screen.getByLabelText('Housing'));
    expect(
      screen.getByLabelText('Z59.00: Homelessness, unspecified'),
    ).toBeTruthy();
  });

  it('groups a utilities-coded example (Z59.861) under the Utilities group', () => {
    renderModal();

    fireEvent.click(screen.getByLabelText('Utilities'));
    expect(
      screen.getByLabelText('Z59.861: Financial insecurity, difficulty paying for utilities'),
    ).toBeTruthy();
  });

  it('selecting a code in one group updates that group\'s selected-count badge', () => {
    renderModal();

    fireEvent.click(screen.getByLabelText('Housing'));
    fireEvent.click(screen.getByLabelText('Z59.00: Homelessness, unspecified'));

    // Badge text is the count "1" rendered inside the (now re-labeled,
    // still-accessible) group header button.
    expect(screen.getByLabelText('Housing, 1 selected')).toBeTruthy();
  });
});

describe('DocumentationModal — Q4: on-brand Messages overlay presentation', () => {
  it('defaults to the fullscreen presentation when `presentation` is not passed (other-launch-path regression)', () => {
    const { container } = renderModal({
      sessionStartedAt: START_ISO,
      sessionEndedAt: END_ISO_50MIN,
    });

    // Fullscreen presentation renders RN's `Modal`, which react-native-web
    // portals to a dedicated DOM node OUTSIDE the render() container — so
    // the form content is NOT found inside `container` when unscoped, but
    // IS found via `screen` (which searches `document.body`). This is the
    // structural signature of the pre-existing pageSheet Modal takeover.
    expect(container.querySelector('[aria-label="Close documentation modal"]')).toBeNull();
    expect(screen.getByLabelText('Close documentation modal')).toBeTruthy();
    expect(screen.getByText('Session Time')).toBeTruthy();
  });

  it('overlay presentation renders in-place (no Modal portal) with the Q1-Q3 internals intact', () => {
    const { container } = renderModal({
      presentation: 'overlay',
      sessionStartedAt: START_ISO,
      sessionEndedAt: END_ISO_50MIN,
    });

    // Overlay presentation is a plain View tree rendered inline — found
    // directly inside the test's own render() container, unlike the Modal
    // portal case above.
    expect(container.querySelector('[aria-label="Close documentation modal"]')).toBeTruthy();

    // Q1: inline "Units: N" line still present and correct (50 min → 2 units).
    expect(getUnitsLineValue()).toBe('2');
    expect(screen.getByText('Units:')).toBeTruthy();

    // Q3: a grouped diagnosis chip renders inside the overlay.
    fireEvent.click(screen.getByLabelText('Housing'));
    expect(screen.getByLabelText('Z59.00: Homelessness, unspecified')).toBeTruthy();

    // Q1: Session Time still after Your Notes.
    const notesHeading = screen.getByText('Your Notes');
    const sessionTimeHeading = screen.getByText('Session Time');
    const position = notesHeading.compareDocumentPosition(sessionTimeHeading);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('overlay presentation renders nothing when visible is false (no dangling scrim/card)', () => {
    const { container } = renderModal({ presentation: 'overlay', visible: false });

    expect(container.querySelector('[aria-label="Close documentation modal"]')).toBeNull();
    expect(screen.queryByText('Session Time')).toBeNull();
  });

  it('overlay presentation still enforces the 16-minute not-billable gate', () => {
    renderModal({
      presentation: 'overlay',
      sessionStartedAt: START_ISO,
      sessionEndedAt: END_ISO_10MIN,
    });

    selectADiagnosisCode();
    fillNotes('Brief check-in, member was in a hurry.');

    expect(
      screen.getByText('Under 16 minutes — not billable; no claim will be filed.'),
    ).toBeTruthy();
    const submit = screen.getByLabelText('Submit documentation and billing');
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    expect(
      screen.getByText(
        'Session is under 16 minutes and is not billable — no claim can be filed.',
      ),
    ).toBeTruthy();
  });

  it('overlay presentation still submits successfully once valid and past the billable floor', async () => {
    const { onSubmit } = renderModal({
      presentation: 'overlay',
      sessionStartedAt: START_ISO,
      sessionEndedAt: END_ISO_50MIN,
    });

    selectADiagnosisCode();
    fillNotes('Discussed housing options and next steps.');

    const submit = screen.getByLabelText('Submit documentation and billing');
    expect(submit.getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(submit);

    // Web confirm gate — in-app panel, not window.confirm.
    fireEvent.click(await screen.findByLabelText('Submit for billing'));

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      sessionId: 'sess-1',
      unitsToBill: 2,
    });
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
