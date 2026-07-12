/**
 * Component test for the "Add Case Note" × SDOH inline panel layout fix.
 *
 * Bug this guards against: `InlineSdohPanel`'s 'sheet' variant and
 * `CaseNoteModal` (a `RightDrawer`) are both `position: fixed`, right-docked,
 * same default z-index (1000). Whichever renders later in the DOM wins the
 * paint order — `InlineSdohPanel` is a sibling rendered AFTER
 * `MemberContextRail` (which owns `CaseNoteModal`), so it always painted on
 * top, silently burying "Add Case Note" underneath it. `CHWMessagesScreen.test.tsx`'s
 * existing coverage only exercises the 'pane' variant (a true in-flow
 * column, not a fixed overlay), so it never caught this.
 *
 * Fix under test (see `CaseNoteModalProps.sdohPanel`'s doc comment in
 * `CHWMessagesScreen.tsx`):
 *   - Wide viewport (enough room)  → case-note panel docks immediately LEFT
 *     of the SDOH panel (`right: sdohPanel.widthPx`), raised above it in
 *     z-order. Both fully visible + usable at once.
 *   - Narrower viewport (SDOH open, not enough room) → case-note panel
 *     stacks IN FRONT of (not behind) the SDOH panel — a dismissible sheet,
 *     not a silently-buried one.
 *
 * Tier 2 — jsdom + react-native-web (see native/TESTING.md). Each `describe`
 * below sets its own viewport width via `setViewportWidth` (react-native-web's
 * `Dimensions` module is a per-module-graph singleton; vitest's default
 * per-file isolation gives this file a fresh instance, and dispatching a
 * `resize` event forces it to re-read `document.documentElement.clientWidth`
 * between describes within this same file).
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ userName: 'Test CHW' }),
}));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: vi.fn(),
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
    setOptions: vi.fn(),
  }),
  useRoute: () => ({ params: {} }),
}));

import { api } from '../../api/client';
import {
  CHWMessagesScreen,
  BP_HIDE_RAIL,
  CASE_NOTE_PANEL_WIDTH,
  CASE_NOTE_SIDE_BY_SIDE_MIN_REMAINING_WIDTH,
} from './CHWMessagesScreen';
import { SDOH_PANEL_PANE_BREAKPOINT, SDOH_PANEL_SHEET_WIDTH } from '../../components/assessment/InlineSdohPanel';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

// ─── Fixtures (mirrors CHWMessagesScreen.test.tsx) ─────────────────────────────

const CONVERSATION_ID = 'conv-1';
const MEMBER_ID = 'member-1';
const CHW_ID = 'chw-1';
const SESSION_ID = 'sess-1';
const ASSESSMENT_ID = 'assess-1';

const conversationFixture = {
  id: CONVERSATION_ID,
  chw_id: CHW_ID,
  member_id: MEMBER_ID,
  session_id: SESSION_ID,
  active_session_id: SESSION_ID,
  active_session_started_at: '2026-07-11T09:00:00.000Z',
  created_at: '2026-06-01T00:00:00.000Z',
  chw_name: 'Test CHW',
  member_name: 'Rosa Gutierrez',
  member_last_active_at: null,
  last_message_preview: 'Hi there',
  last_message_at: '2026-07-11T09:00:00.000Z',
  last_message_sender_id: MEMBER_ID,
  unread_count: 0,
  pinned_at: null,
  archived_at: null,
  deleted_at: null,
  deleted_by_user_id: null,
};

const sessionFixture = {
  id: SESSION_ID,
  request_id: 'req-1',
  chw_id: CHW_ID,
  member_id: MEMBER_ID,
  vertical: 'housing',
  status: 'in_progress',
  mode: 'call',
  scheduled_at: '2026-07-11T09:00:00.000Z',
  started_at: '2026-07-11T09:00:00.000Z',
};

const assessmentTemplateFixture = {
  id: 'compass_member_v1',
  name: 'Compass Member Assessment',
  total_questions: 1,
  sections: [{ id: 'sec1', title: 'Housing', part: 1, part_label: 'Part 1', category: 'housing' }],
  questions: [
    {
      id: 'q1',
      section_id: 'sec1',
      source_q_num: 1,
      text: 'Do you have stable housing?',
      category: 'housing',
      subcategory: 'stability',
      tags: [],
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
    },
  ],
};

const startAssessmentFixture = {
  id: ASSESSMENT_ID,
  status: 'in_progress',
  template_id: 'compass_member_v1',
  session_id: SESSION_ID,
  member_id: MEMBER_ID,
};

function routeApi(path: string, options?: { method?: string; body?: string }): unknown {
  const method = options?.method ?? 'GET';

  if (path.startsWith(`/conversations/${CONVERSATION_ID}/messages`)) {
    if (method === 'GET') return [];
    if (method === 'POST') {
      const body = options?.body ? JSON.parse(options.body) : {};
      return {
        id: 'msg-new',
        conversation_id: CONVERSATION_ID,
        sender_id: CHW_ID,
        body: body.body ?? '',
        type: 'text',
        created_at: new Date().toISOString(),
      };
    }
  }

  if (path.startsWith('/conversations/')) {
    return [conversationFixture];
  }

  if (path === `/sessions/${SESSION_ID}/assessments` && method === 'POST') {
    return startAssessmentFixture;
  }

  if (path.startsWith('/sessions/')) {
    return sessionFixture;
  }

  if (path === '/chw/journeys') {
    return [];
  }

  if (path.startsWith('/member/services-consent')) {
    return null;
  }

  if (path.startsWith('/assessment-templates/')) {
    return assessmentTemplateFixture;
  }

  if (path === `/assessments/${ASSESSMENT_ID}/responses` && method === 'POST') {
    return {};
  }

  if (path === `/assessments/${ASSESSMENT_ID}/complete` && method === 'POST') {
    return {};
  }

  if (path === '/case-notes' && method === 'POST') {
    const body = options?.body ? JSON.parse(options.body) : {};
    return {
      id: 'note-1',
      member_id: body.member_id,
      body: body.body,
      session_id: body.session_id ?? null,
      is_pinned: body.is_pinned ?? false,
      created_at: new Date().toISOString(),
      author_id: CHW_ID,
      author_name: 'Test CHW',
    };
  }

  throw new Error(`Unhandled api() call in CHWMessagesScreen.caseNoteSdohLayout test: ${method} ${path}`);
}

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CHWMessagesScreen />
    </QueryClientProvider>,
  );
}

/**
 * Sets the viewport width `useWindowDimensions()` resolves to and forces
 * react-native-web's `Dimensions` singleton to re-read it. Must be called
 * BEFORE rendering — `useWindowDimensions`'s initial state is read
 * synchronously at mount (`useState(() => Dimensions.get('window'))`).
 */
function setViewportWidth(px: number): void {
  Object.defineProperty(document.documentElement, 'clientWidth', {
    value: px,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    value: 1000,
    configurable: true,
  });
  window.dispatchEvent(new Event('resize'));
}

async function openSdohThenCaseNote(): Promise<void> {
  await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });
  fireEvent.click(await screen.findByLabelText('Open SDOH / Health Screening'));
  await screen.findByText('Do you have stable housing?', {}, { timeout: 3000 });

  const addCaseNoteBtn = screen.getByLabelText('Add case note');
  fireEvent.click(addCaseNoteBtn);
  await screen.findByText("Attach a clinical note to this member's record");
}

beforeEach(() => {
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string; body?: string }) =>
    routeApi(path, options),
  );
});

// ─── Wide viewport: side by side ────────────────────────────────────────────────

describe('CHWMessagesScreen — Add Case Note beside an open SDOH panel (wide viewport)', () => {
  // 'sheet' variant specifically (BP_HIDE_RAIL <= width < SDOH_PANEL_PANE_BREAKPOINT)
  // — the exact geometry the reported bug occurred in (both fixed-position,
  // right-docked, same default z-index). Comfortably above the side-by-side
  // threshold so both panels fit without being cramped.
  const WIDTH =
    SDOH_PANEL_SHEET_WIDTH + CASE_NOTE_PANEL_WIDTH + CASE_NOTE_SIDE_BY_SIDE_MIN_REMAINING_WIDTH + 50;

  beforeAll(() => {
    expect(WIDTH).toBeLessThan(SDOH_PANEL_PANE_BREAKPOINT); // sanity: still 'sheet', not 'pane'
    expect(WIDTH).toBeGreaterThanOrEqual(BP_HIDE_RAIL); // sanity: rail (and thus "Add Case Note") visible
    setViewportWidth(WIDTH);
  });

  it('renders the case-note form AND the SDOH questionnaire simultaneously, with the case-note panel docked left of and above the SDOH panel', async () => {
    renderScreen();
    await openSdohThenCaseNote();

    // Both are queryable/visible in the DOM at once — the core "not hidden" requirement.
    const noteInput = screen.getByLabelText('Case note body');
    expect(noteInput).toBeTruthy();
    expect(screen.getByText('Do you have stable housing?')).toBeTruthy();

    // Geometry: the case-note panel is offset left by exactly the SDOH
    // panel's width (docked immediately beside it, not on top of it) and
    // raised above InlineSdohPanel's z-index (1000) so it can never again be
    // painted underneath it.
    const caseNotePanel = screen.getByTestId('case-note-panel-root-panel');
    expect(getComputedStyle(caseNotePanel).right).toBe(`${SDOH_PANEL_SHEET_WIDTH}px`);

    const caseNoteRoot = screen.getByTestId('case-note-panel-root');
    expect(Number(getComputedStyle(caseNoteRoot).zIndex)).toBeGreaterThan(1000);

    // The SDOH panel itself is still mounted and untouched.
    expect(screen.getByTestId('inline-sdoh-panel')).toBeTruthy();
  });

  it('lets the CHW fill out the case note and the SDOH form independently while both are open', async () => {
    renderScreen();
    await openSdohThenCaseNote();

    // Answer the SDOH question.
    fireEvent.click(screen.getByLabelText('Yes'));
    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        `/assessments/${ASSESSMENT_ID}/responses`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    // Write and save the case note — proves it's not just visible but
    // actually interactive/usable while the SDOH panel is open beside it.
    const noteInput = screen.getByLabelText('Case note body');
    fireEvent.change(noteInput, { target: { value: 'Filled out side by side with SDOH.' } });
    fireEvent.click(screen.getByLabelText('Save case note'));

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        '/case-notes',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Filled out side by side with SDOH.'),
        }),
      );
    });

    // SDOH's answer to the earlier question is untouched by the case-note save.
    expect(screen.getByText('Do you have stable housing?')).toBeTruthy();
  });
});

// ─── Narrow viewport: graceful degrade ──────────────────────────────────────────

describe('CHWMessagesScreen — Add Case Note with an open SDOH panel (narrow viewport, no room for side by side)', () => {
  // Rail (and "Add Case Note") is still visible (>= BP_HIDE_RAIL), but too
  // narrow for both panels to sit side by side without cramming the thread +
  // conversation pane. Documented tradeoff: degrades to stacking the
  // case-note panel IN FRONT of the SDOH panel instead of behind it.
  const WIDTH = BP_HIDE_RAIL + 20;

  beforeAll(() => {
    expect(WIDTH).toBeLessThan(
      SDOH_PANEL_SHEET_WIDTH + CASE_NOTE_PANEL_WIDTH + CASE_NOTE_SIDE_BY_SIDE_MIN_REMAINING_WIDTH,
    ); // sanity: below the side-by-side threshold
    setViewportWidth(WIDTH);
  });

  afterAll(() => {
    // Leave a known-good wide width behind in case Vitest reuses this jsdom
    // window for a subsequent file in the same worker.
    setViewportWidth(SDOH_PANEL_PANE_BREAKPOINT + 200);
  });

  it('brings the case-note panel to the front (still fully usable) instead of leaving it buried behind the SDOH panel', async () => {
    renderScreen();
    await openSdohThenCaseNote();

    const noteInput = screen.getByLabelText('Case note body');
    expect(noteInput).toBeTruthy();

    const caseNotePanel = screen.getByTestId('case-note-panel-root-panel');
    // Not offset (no room to sit beside SDOH) — but critically, raised above
    // InlineSdohPanel's z-index rather than left at the same z-index where
    // DOM order would bury it (the pre-fix bug).
    expect(getComputedStyle(caseNotePanel).right).toBe('0px');

    const caseNoteRoot = screen.getByTestId('case-note-panel-root');
    expect(Number(getComputedStyle(caseNoteRoot).zIndex)).toBeGreaterThan(1000);

    // Still fully usable: type and save.
    fireEvent.change(noteInput, { target: { value: 'Usable even when stacked in front.' } });
    fireEvent.click(screen.getByLabelText('Save case note'));

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        '/case-notes',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Usable even when stacked in front.'),
        }),
      );
    });

    // Closing the case note returns to the still-open, untouched SDOH panel.
    await waitFor(() => {
      expect(screen.queryByText("Attach a clinical note to this member's record")).toBeNull();
    });
    expect(screen.getByText('Do you have stable housing?')).toBeTruthy();
  });
});
