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
 * Most suites in this file omit the `memberId` prop, so `useCaseNotes` (the
 * one network-backed hook DocumentationModal calls) stays disabled — see its
 * `enabled: visible && !!memberId` gate — making those tests pure component
 * tests against a live (but idle) QueryClient. The `#24 case-note prefill vs.
 * draft restoration` suite near the bottom of this file DOES pass `memberId`
 * and drives the mocked `api()` boundary, since it specifically tests the
 * interaction between the case-notes-fetched prefill and #23 draft
 * restoration.
 *
 * Also covers #21 (session-time format now matches the billing CSV export:
 * MM/DD/YYYY hh:MM AM/PM, 12hr), #22 (Potential Earnings line, $14/unit),
 * and #23 (per-sessionId draft persistence via AsyncStorage).
 *
 * Tier 2 — jsdom + react-native-web (see native/TESTING.md).
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

// #23 draft persistence — in-memory AsyncStorage mock, same pattern as
// CHWDashboardScreen.test.tsx's compliance-banner-dismissal tests. Keeps
// tests deterministic and avoids depending on a real native module (there
// isn't one under jsdom).
vi.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => store.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      clear: vi.fn(async () => {
        store.clear();
      }),
    },
  };
});

// Network boundary — only exercised by the #24 case-note-prefill-vs-draft
// interaction tests below (which pass `memberId`, enabling `useCaseNotes`).
// Every other test in this file omits `memberId`, which keeps `useCaseNotes`
// disabled (see its `enabled: visible && !!memberId` gate) — so this mock
// stays idle/unused for the rest of the suite.
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});

import { DocumentationModal, type DocumentationModalProps } from './DocumentationModal';
import AsyncStorageMock from '@react-native-async-storage/async-storage';
import { api } from '../../api/client';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

// Local wall-clock fixtures built the same way the implementation reads them
// back (via `new Date(iso)` local getters) — round-trips correctly no matter
// what timezone the test runner is in, unlike hardcoding a UTC ISO string
// and a separately-hardcoded expected local display. The comments record the
// exact "MM/DD/YYYY hh:MM AM/PM" string each ISO value round-trips to/from
// (#21 — matches the billing CSV export format), since that string is what
// the assertions below match against.
const START_ISO = new Date(2026, 6, 12, 9, 0, 0).toISOString(); // "07/12/2026 09:00 AM"
const END_ISO_50MIN = new Date(2026, 6, 12, 9, 50, 0).toISOString(); // "07/12/2026 09:50 AM" (50 min → 2 units)
const END_ISO_10MIN = new Date(2026, 6, 12, 9, 10, 0).toISOString(); // "07/12/2026 09:10 AM" (10 min → 0 units, not billable)

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

beforeEach(async () => {
  vi.clearAllMocks();
  await AsyncStorageMock.clear();
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string) => {
    if (path.startsWith('/members/') && path.includes('/case-notes')) {
      return { items: [], total: 0, limit: 50, offset: 0 };
    }
    throw new Error(`Unhandled api() call in DocumentationModal test: ${path}`);
  });
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
    expect(startInput.value).toBe('07/12/2026 09:00 AM');
    expect(endInput.value).toBe('07/12/2026 09:50 AM');

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
    setDateTimeField('Session end date and time', '07/12/2026 10:30 AM');

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
    setDateTimeField('Session end date and time', '07/12/2026 09:16 AM');

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
    setDateTimeField('Session end date and time', '07/12/2026 08:00 AM');

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
    setDateTimeField('Session end date and time', '07/12/2026 08:00 AM');
    expect(submit.getAttribute('aria-disabled')).toBe('true');

    setDateTimeField('Session end date and time', '07/12/2026 10:30 AM');
    expect(submit.getAttribute('aria-disabled')).not.toBe('true');
  });
});

// ─── #22 — Potential Earnings ───────────────────────────────────────────────

describe('DocumentationModal — #22 Potential Earnings', () => {
  it('shows Potential Earnings at $14/unit under the Units line for a billable session', () => {
    renderModal({ sessionStartedAt: START_ISO, sessionEndedAt: END_ISO_50MIN });

    // 50-minute session → 2 units → 2 * $14 = $28.
    expect(getUnitsLineValue()).toBe('2');
    expect(screen.getByText('Potential Earnings:')).toBeTruthy();
    expect(screen.getByText('$28')).toBeTruthy();
  });

  it('recomputes Potential Earnings live as the units bracket changes', () => {
    renderModal({ sessionStartedAt: START_ISO, sessionEndedAt: END_ISO_50MIN });

    expect(screen.getByText('$28')).toBeTruthy(); // 2 units

    // Push to a 90-minute duration → 3-unit bracket → 3 * $14 = $42.
    setDateTimeField('Session end date and time', '07/12/2026 10:30 AM');

    expect(getUnitsLineValue()).toBe('3');
    expect(screen.getByText('$42')).toBeTruthy();
  });

  it('shows "$0 — not billable" instead of a dollar figure for a sub-16-minute session', () => {
    renderModal({ sessionStartedAt: START_ISO, sessionEndedAt: END_ISO_10MIN });

    expect(
      screen.getByText('Under 16 minutes — not billable; no claim will be filed.'),
    ).toBeTruthy();
    expect(screen.getByText('$0 — not billable')).toBeTruthy();
    // No plain "$0" (ambiguous with a real $0 payout) — must read as explicitly not billable.
    expect(screen.queryByText('$0')).toBeNull();
  });

  it('1-unit session shows $14', () => {
    // 16-minute session → 1 unit exactly at the billable floor.
    renderModal({
      sessionStartedAt: START_ISO,
      sessionEndedAt: new Date(2026, 6, 12, 9, 16, 0).toISOString(),
    });

    expect(getUnitsLineValue()).toBe('1');
    expect(screen.getByText('$14')).toBeTruthy();
  });

  it('4-unit (capped) session shows $56', () => {
    renderModal({
      sessionStartedAt: START_ISO,
      sessionEndedAt: new Date(2026, 6, 12, 12, 0, 0).toISOString(), // 180 min → capped at 4 units
    });

    expect(getUnitsLineValue()).toBe('4');
    expect(screen.getByText('$56')).toBeTruthy();
  });
});

// ─── #23 — Draft persistence ─────────────────────────────────────────────────

describe('DocumentationModal — #23 draft persistence', () => {
  /** Debounce window the component saves drafts on — see DRAFT_SAVE_DEBOUNCE_MS. */
  const DRAFT_DEBOUNCE_MS = 500;

  it('persists notes/diagnosis/procedure/times to AsyncStorage (debounced) as the CHW edits', async () => {
    renderModal({ sessionId: 'sess-draft-1' });

    selectADiagnosisCode();
    fillNotes('Discussed housing options.');

    await waitFor(
      () => {
        expect(AsyncStorageMock.setItem).toHaveBeenCalledWith(
          'compass:documentationDraft:sess-draft-1',
          expect.stringContaining('Discussed housing options.'),
        );
      },
      { timeout: DRAFT_DEBOUNCE_MS + 1000 },
    );

    const [, rawDraft] = (AsyncStorageMock.setItem as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [
      string,
      string,
    ];
    const draft = JSON.parse(rawDraft);
    expect(draft.chwNotes).toBe('Discussed housing options.');
    expect(draft.selectedDiagnosisCodes).toEqual(['Z71.89']);
  });

  it('restores a persisted draft when the modal reopens for the same session (navigate-away-and-back)', async () => {
    await AsyncStorageMock.setItem(
      'compass:documentationDraft:sess-draft-2',
      JSON.stringify({
        chwNotes: 'Draft note from before navigating away.',
        selectedDiagnosisCodes: ['Z59.00'],
        selectedProcedureCode: '98960',
        sessionStartInput: '07/12/2026 09:00 AM',
        sessionEndInput: '07/12/2026 09:50 AM',
      }),
    );

    renderModal({ sessionId: 'sess-draft-2' });

    await waitFor(() => {
      expect(
        (screen.getByLabelText(
          'Your notes — CHW-authored. Type @ to mention a resource.',
        ) as HTMLTextAreaElement).value,
      ).toBe('Draft note from before navigating away.');
    });

    const startInput = screen.getByLabelText('Session start date and time') as HTMLInputElement;
    const endInput = screen.getByLabelText('Session end date and time') as HTMLInputElement;
    expect(startInput.value).toBe('07/12/2026 09:00 AM');
    expect(endInput.value).toBe('07/12/2026 09:50 AM');

    // The restored diagnosis code already shows as selected in its group's
    // badge count, even before the group is expanded.
    expect(screen.getByLabelText('Housing, 1 selected')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Housing, 1 selected'));
    expect(screen.getByLabelText('Z59.00: Homelessness, unspecified')).toBeTruthy();
  });

  it('a fresh session with no persisted draft starts blank/pre-filled from props as usual (no draft to restore)', async () => {
    renderModal({
      sessionId: 'sess-no-draft',
      sessionStartedAt: START_ISO,
      sessionEndedAt: END_ISO_50MIN,
    });

    // Give the (empty) draft-load check a chance to resolve.
    await waitFor(() => expect(AsyncStorageMock.getItem).toHaveBeenCalled());

    const startInput = screen.getByLabelText('Session start date and time') as HTMLInputElement;
    expect(startInput.value).toBe('07/12/2026 09:00 AM'); // from props, not a draft
    expect(
      (screen.getByLabelText(
        'Your notes — CHW-authored. Type @ to mention a resource.',
      ) as HTMLTextAreaElement).value,
    ).toBe('');
  });

  it('clears the persisted draft on successful submit', async () => {
    await AsyncStorageMock.setItem(
      'compass:documentationDraft:sess-draft-3',
      JSON.stringify({
        chwNotes: 'Will be submitted.',
        selectedDiagnosisCodes: ['Z59.00'],
        selectedProcedureCode: '98960',
        sessionStartInput: '07/12/2026 09:00 AM',
        sessionEndInput: '07/12/2026 09:50 AM',
      }),
    );

    const { onSubmit } = renderModal({ sessionId: 'sess-draft-3' });

    await waitFor(() => {
      expect(
        (screen.getByLabelText(
          'Your notes — CHW-authored. Type @ to mention a resource.',
        ) as HTMLTextAreaElement).value,
      ).toBe('Will be submitted.');
    });

    const submit = screen.getByLabelText('Submit documentation and billing');
    expect(submit.getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(submit);

    fireEvent.click(await screen.findByLabelText('Submit for billing'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(AsyncStorageMock.removeItem).toHaveBeenCalledWith('compass:documentationDraft:sess-draft-3');
    });
  });

  it('does not persist an all-empty draft (nothing worth restoring)', async () => {
    renderModal({ sessionId: 'sess-draft-4' });

    // Give any debounced-save timers (and the async draft-load state update
    // that gates them) a chance to fire — wrapped in `act` since this is
    // asserting an absence, so there's no positive DOM change for `waitFor`
    // to poll toward.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, DRAFT_DEBOUNCE_MS + 200));
    });

    expect(AsyncStorageMock.setItem).not.toHaveBeenCalledWith(
      'compass:documentationDraft:sess-draft-4',
      expect.anything(),
    );
  });
});

// ─── #24 — case-note prefill vs. draft restoration interaction ────────────────

describe('DocumentationModal — #24 case-note prefill vs. draft restoration', () => {
  it('prefills Session Notes from a case note saved during the session when there is no draft', async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path.startsWith('/members/member-1/case-notes')) {
        return {
          items: [
            {
              id: 'note-1',
              memberId: 'member-1',
              chwId: 'chw-1',
              sessionId: 'sess-prefill-1',
              body: 'Case note taken live during the session.',
              isPinned: false,
              createdAt: '2026-07-12T09:10:00.000Z',
              updatedAt: '2026-07-12T09:10:00.000Z',
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        };
      }
      throw new Error(`Unhandled api() call: ${path}`);
    });

    renderModal({ sessionId: 'sess-prefill-1', memberId: 'member-1' });

    await waitFor(() => {
      expect(
        (screen.getByLabelText(
          'Your notes — CHW-authored. Type @ to mention a resource.',
        ) as HTMLTextAreaElement).value,
      ).toBe('Case note taken live during the session.');
    });
  });

  it('does NOT clobber a restored draft with the case-note prefill — draft wins', async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path.startsWith('/members/member-1/case-notes')) {
        return {
          items: [
            {
              id: 'note-1',
              memberId: 'member-1',
              chwId: 'chw-1',
              sessionId: 'sess-prefill-2',
              body: 'This case note must NOT overwrite the restored draft.',
              isPinned: false,
              createdAt: '2026-07-12T09:10:00.000Z',
              updatedAt: '2026-07-12T09:10:00.000Z',
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        };
      }
      throw new Error(`Unhandled api() call: ${path}`);
    });

    await AsyncStorageMock.setItem(
      'compass:documentationDraft:sess-prefill-2',
      JSON.stringify({
        chwNotes: 'CHW-edited draft note, already in progress.',
        selectedDiagnosisCodes: [],
        selectedProcedureCode: '',
        sessionStartInput: '',
        sessionEndInput: '',
      }),
    );

    renderModal({ sessionId: 'sess-prefill-2', memberId: 'member-1' });

    // Let both the draft restoration AND the case-notes fetch settle, then
    // assert the stable end-state directly — `waitFor` polls (wrapped in
    // `act` internally) rather than a raw timer wait, so it both proves the
    // prefill effect never overwrites the restored draft AND avoids an
    // unwrapped-state-update warning from an arbitrary bare setTimeout.
    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        expect.stringContaining('/members/member-1/case-notes'),
      );
    });
    await waitFor(() => {
      expect(
        (screen.getByLabelText(
          'Your notes — CHW-authored. Type @ to mention a resource.',
        ) as HTMLTextAreaElement).value,
      ).toBe('CHW-edited draft note, already in progress.');
    });
  });

  it('an empty-notes restored draft (CHW deliberately cleared notes) still blocks the prefill', async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path.startsWith('/members/member-1/case-notes')) {
        return {
          items: [
            {
              id: 'note-1',
              memberId: 'member-1',
              chwId: 'chw-1',
              sessionId: 'sess-prefill-3',
              body: 'Should stay out of the notes field.',
              isPinned: false,
              createdAt: '2026-07-12T09:10:00.000Z',
              updatedAt: '2026-07-12T09:10:00.000Z',
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        };
      }
      throw new Error(`Unhandled api() call: ${path}`);
    });

    // Non-empty draft overall (has a diagnosis code) but deliberately blank notes.
    await AsyncStorageMock.setItem(
      'compass:documentationDraft:sess-prefill-3',
      JSON.stringify({
        chwNotes: '',
        selectedDiagnosisCodes: ['Z59.00'],
        selectedProcedureCode: '',
        sessionStartInput: '',
        sessionEndInput: '',
      }),
    );

    renderModal({ sessionId: 'sess-prefill-3', memberId: 'member-1' });

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        expect.stringContaining('/members/member-1/case-notes'),
      );
    });
    // Assert the stable end-state via `waitFor` (act-wrapped polling) rather
    // than a raw timer wait — proves the prefill never fires even once the
    // case-notes fetch has fully settled.
    await waitFor(() => {
      expect(
        (screen.getByLabelText(
          'Your notes — CHW-authored. Type @ to mention a resource.',
        ) as HTMLTextAreaElement).value,
      ).toBe('');
    });
  });
});
