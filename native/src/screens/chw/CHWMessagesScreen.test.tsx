/**
 * Component test for CHWMessagesScreen. Covers three fixes to the Messages
 * member-context rail:
 *
 *   1. Inline SDOH panel (InlineSdohPanel, wired via MemberContextRail's
 *      onOpenSdohPanel) is non-blocking: the message thread and "Add Case
 *      Note" stay present and interactive in the DOM while it's open
 *      (previously the rail card navigated away to a separate
 *      CHWMemberAssessmentScreen).
 *   2. "Add Case Note" is an inline, in-flow section inside the rail's own
 *      scroll content (CaseNoteInlineSection) — NOT a RightDrawer. It used
 *      to be a right-docked RightDrawer, which on web is `position: fixed`
 *      at the same edge/z-index InlineSdohPanel's 'sheet' variant uses, so
 *      opening a case note while the SDOH panel was open visually
 *      overlapped it. The tests below assert both can be open
 *      simultaneously with neither unmounting or covering the other.
 *   3. Adaptive SDOH sizing (see the "adaptive sizing" describe block
 *      further down): on mid-width viewports where the rail is visible but
 *      there isn't room for all 4 columns, opening the SDOH panel collapses
 *      the thread-list pane to render as a real pane instead of an overlay
 *      sheet that would cover the rail.
 *
 * Only the network boundary (`../../api/client`), auth context, and
 * navigation hooks are mocked — every data hook (useConversations,
 * useSession, useConversationMessages, useChwJourneys,
 * useMemberServicesConsent, useAssessmentBootstrap's fetch/start calls,
 * useCreateCaseNote, useToggleConversationPin/Archive,
 * useSoftDeleteConversation) runs for real against a routed `api()` mock, so
 * this exercises the actual production wiring, not a hand-rolled hook mock.
 * Tier 2 — jsdom + react-native-web (see native/TESTING.md).
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ userName: 'Test CHW' }),
}));
// No `importOriginal` here (unlike the two mocks above): @react-navigation/native's
// real barrel eagerly re-exports NavigationContainer, whose ESM build does an
// extension-less `import ... from './useBackButton'` that Vite/vite-node's
// module resolution can't satisfy under jsdom (Metro's RN platform-extension
// resolver isn't in play here) — loading the real module at all throws
// ERR_MODULE_NOT_FOUND. CHWMessagesScreen only uses `useNavigation` and
// `useRoute` (plus the type-only `RouteProp`, erased at compile time) from
// this package, so a full literal replacement covers everything it needs
// without ever touching the real module.
//
// `mockNavigate` is hoisted so every `useNavigation()` call across the whole
// component tree (ConversationPane's header PressableMembers, the rail's
// Quick Actions PressableMember, CalendarNavigationButton, etc.) returns the
// SAME spy — needed to assert "Back to Messages" origin params below (Epic S
// follow-up), same pattern as CHWDashboardScreen.test.tsx.
const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
    setOptions: vi.fn(),
  }),
  useRoute: () => ({ params: {} }),
}));

import { api } from '../../api/client';
import { CHWMessagesScreen } from './CHWMessagesScreen';
import { SDOH_PANEL_PANE_BREAKPOINT } from '../../components/assessment/InlineSdohPanel';
import * as showAlertModule from '../../utils/showAlert';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

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

// ─── API router — the sole network boundary ──────────────────────────────────

// Mutable session status the GET /sessions/{id} route reflects back — lets
// the Cancel/Missed Session tests assert the rail re-renders with the
// post-mutation terminal state after the sessions-query invalidation
// triggers a refetch (mirrors what the real backend does: PATCH .../abort or
// .../no-show changes the row a subsequent GET then returns). Reset in
// beforeEach so no state leaks between tests.
let currentSessionStatus = 'in_progress';

// Mutable per-test `ended_at` the mocked POST /sessions/{id}/end route
// returns, alongside the fixture's fixed `started_at`
// ('2026-07-11T09:00:00.000Z') — lets individual tests control the
// resulting session duration (e.g. a sub-16-minute end time for the
// not-billable-floor test) instead of always computing off the real wall
// clock. Defaults to a comfortably-billable 50 minutes after start.
let endSessionEndedAt = '2026-07-11T09:50:00.000Z';

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
    // Mirrors what the real backend does once a mutation ends the active
    // session (abort/no-show/complete's documentation submit): the
    // conversation's active_session_id clears so a subsequent GET (triggered
    // by the mutation's `queryKeys.conversations` invalidation) reflects a
    // bare, no-active-session conversation — the signal `canBeginNewSession`
    // gates on. Sessions ended via `/end` (Complete's first step) are NOT yet
    // terminal (`awaiting_documentation` isn't in TERMINAL_SESSION_STATUSES),
    // so only fully-terminal statuses clear it here.
    const isSessionTerminal =
      currentSessionStatus === 'cancelled' ||
      currentSessionStatus === 'cancelled_no_consent' ||
      currentSessionStatus === 'no_show' ||
      currentSessionStatus === 'completed';
    return [
      isSessionTerminal
        ? { ...conversationFixture, session_id: null, active_session_id: null, active_session_started_at: null }
        : conversationFixture,
    ];
  }

  if (path === `/sessions/${SESSION_ID}/assessments` && method === 'POST') {
    return startAssessmentFixture;
  }

  if (path === `/sessions/${SESSION_ID}/abort` && method === 'PATCH') {
    currentSessionStatus = 'cancelled';
    return { ...sessionFixture, status: 'cancelled', ended_at: new Date().toISOString() };
  }

  if (path === `/sessions/${SESSION_ID}/no-show` && method === 'PATCH') {
    currentSessionStatus = 'no_show';
    return { ...sessionFixture, status: 'no_show', ended_at: new Date().toISOString() };
  }

  if (path === `/sessions/${SESSION_ID}/end` && method === 'POST') {
    currentSessionStatus = 'awaiting_documentation';
    return {
      ...sessionFixture,
      status: 'awaiting_documentation',
      started_at: sessionFixture.started_at,
      ended_at: endSessionEndedAt,
    };
  }

  if (path.startsWith('/sessions/')) {
    return { ...sessionFixture, status: currentSessionStatus };
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

  throw new Error(`Unhandled api() call in CHWMessagesScreen test: ${method} ${path}`);
}

// ─── Harness ──────────────────────────────────────────────────────────────────

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // Note: AppDialogProvider (the component that actually renders showAlert()'s
  // queued dialog) is intentionally NOT mounted here — it's mounted once at
  // the app root in production (App.tsx) and has its own dedicated render
  // test (AppDialogProvider.test.tsx). For the "no active session" case below
  // we assert the *call* to showAlert() with the right title/message instead
  // of rendering the dialog — that's the boundary this screen actually owns.
  return render(
    <QueryClientProvider client={qc}>
      <CHWMessagesScreen />
    </QueryClientProvider>,
  );
}

/** Wide desktop viewport — plenty of room for all 4 panes at once. */
const WIDE_VIEWPORT_WIDTH = SDOH_PANEL_PANE_BREAKPOINT + 200;

/**
 * react-native-web's `Dimensions` module reads `document.documentElement
 * .clientWidth/clientHeight` once (lazily, on the first `Dimensions.get()`
 * call anywhere in the process) and thereafter only refreshes that cached
 * snapshot when a `window` 'resize' event fires (see
 * `react-native-web/src/exports/Dimensions`). `useWindowDimensions`'s
 * initial `useState` reads the cached snapshot synchronously at mount, so —
 * for a test to render at a specific width — the property must be set *and*
 * a resize event dispatched *before* `render()` is called.
 */
function setViewportWidth(width: number, height = 1000): void {
  Object.defineProperty(document.documentElement, 'clientWidth', {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    value: height,
    configurable: true,
  });
  // Wrapped in act() because dispatching 'resize' can synchronously flip
  // `useWindowDimensions()` state on any component still mounted from a
  // preceding test (e.g. an afterEach restoring the wide viewport before
  // the global cleanup() in vitest.setup.ts unmounts it).
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

beforeAll(() => {
  // Wide desktop viewport so the SDOH panel renders as a true 4th pane
  // ('pane' variant) — the primary, non-blocking layout under test.
  Object.defineProperty(document.documentElement, 'clientWidth', {
    value: WIDE_VIEWPORT_WIDTH,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    value: 1000,
    configurable: true,
  });
});

beforeEach(() => {
  mockedApi.mockReset();
  currentSessionStatus = 'in_progress';
  endSessionEndedAt = '2026-07-11T09:50:00.000Z';
  mockNavigate.mockClear();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string; body?: string }) =>
    routeApi(path, options),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CHWMessagesScreen — inline SDOH panel', () => {
  it('opens the SDOH panel inline and keeps the thread + Add Case Note usable at the same time', async () => {
    renderScreen();

    // Wait for the conversation to load and auto-select.
    await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });

    // Sanity: the message compose box is present before opening the panel.
    const composeBefore = await screen.findByPlaceholderText(/type a message/i);
    expect(composeBefore).toBeTruthy();

    // Open the SDOH / Health Screening panel from the rail.
    const sdohCard = await screen.findByLabelText('Open SDOH / Health Screening');
    fireEvent.click(sdohCard);

    // The questionnaire loads and renders its first question — proves the
    // bootstrap hook + AssessmentForm wiring (same persistence engine as the
    // old full-screen flow) works end to end inside the panel.
    await screen.findByText('Do you have stable housing?', {}, { timeout: 3000 });

    // ── Core requirement: thread stays interactive while the panel is open ──
    const composeAfter = screen.getByPlaceholderText(/type a message/i);
    expect(composeAfter).toBeTruthy();
    fireEvent.change(composeAfter, { target: { value: 'Still able to message while SDOH is open' } });
    expect((composeAfter as HTMLInputElement | HTMLTextAreaElement).value).toBe(
      'Still able to message while SDOH is open',
    );

    // ── Core requirement: "Add Case Note" stays interactive while the panel is open ──
    const addCaseNoteBtn = screen.getByLabelText('Add case note');
    expect(addCaseNoteBtn).toBeTruthy();
    fireEvent.click(addCaseNoteBtn);

    // The case note editor opens INLINE, in-flow inside the rail's own
    // scroll content (CaseNoteInlineSection) — proves the click actually
    // reached and activated the control, not just that it was present in
    // the DOM inertly. Match on the section's subtitle (unique to the open
    // editor) rather than "Add Case Note" — that text is ambiguous with the
    // still-visible quick-action button label underneath.
    await screen.findByText("Attach a clinical note to this member's record");

    // It must NOT be rendered via RightDrawer's fixed-position overlay +
    // backdrop mechanism (the old behaviour that caused it to visually
    // overlap the SDOH panel — both docked at the same right-edge z-index).
    expect(screen.queryByLabelText('Close drawer')).toBeNull();

    const noteInput = screen.getByLabelText('Case note body');
    fireEvent.change(noteInput, { target: { value: 'Member mentioned housing concerns.' } });

    const saveBtn = screen.getByLabelText('Save case note');
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        '/case-notes',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Member mentioned housing concerns.'),
        }),
      );
    });

    // The inline case note section closes after save, and the SDOH panel
    // underneath is still open/untouched — proves the two coexisted rather
    // than one having silently unmounted the other.
    await waitFor(() => {
      expect(screen.queryByText("Attach a clinical note to this member's record")).toBeNull();
    });
    expect(screen.getByText('Do you have stable housing?')).toBeTruthy();
  });

  it('answering a question in the inline panel persists through the same endpoint AssessmentForm always used', async () => {
    renderScreen();

    await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });
    fireEvent.click(await screen.findByLabelText('Open SDOH / Health Screening'));
    await screen.findByText('Do you have stable housing?', {}, { timeout: 3000 });

    const yesOption = screen.getByLabelText('Yes');
    fireEvent.click(yesOption);

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        `/assessments/${ASSESSMENT_ID}/responses`,
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"question_id":"q1"'),
        }),
      );
    });
    const call = mockedApi.mock.calls.find(
      (args: unknown[]) => args[0] === `/assessments/${ASSESSMENT_ID}/responses`,
    );
    const payload = JSON.parse((call as [string, { body: string }])[1].body);
    expect(payload).toMatchObject({
      question_id: 'q1',
      answer_value: 'yes',
      answer_label: 'Yes',
      category: 'housing',
      subcategory: 'stability',
    });
  });

  it('shows an on-brand success panel (not a browser alert) after completing the assessment, and closing it does not disturb the thread', async () => {
    renderScreen();

    await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });
    fireEvent.click(await screen.findByLabelText('Open SDOH / Health Screening'));
    await screen.findByText('Do you have stable housing?', {}, { timeout: 3000 });

    fireEvent.click(screen.getByLabelText('Yes'));
    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        `/assessments/${ASSESSMENT_ID}/responses`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    // Single-question, single-section fixture — the section is already the
    // last one, so "Done" completes the assessment.
    const doneBtn = screen.getByLabelText('Complete assessment');
    await act(async () => {
      fireEvent.click(doneBtn);
    });

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        `/assessments/${ASSESSMENT_ID}/complete`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    // On-brand in-panel confirmation — DocumentationModal's success-panel look.
    await screen.findByText('Assessment Complete');
    expect(screen.getByLabelText('Done')).toBeTruthy();

    // Thread is untouched underneath the whole time.
    expect(screen.getByPlaceholderText(/type a message/i)).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Done'));
    await waitFor(() => {
      expect(screen.queryByText('Assessment Complete')).toBeNull();
    });
  });

  it('routes to the in-app "Begin a session first" dialog (not a browser alert) when there is no active session', async () => {
    mockedApi.mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
      if (path.startsWith('/conversations/') && !path.includes('/messages')) {
        return [{ ...conversationFixture, active_session_id: null, session_id: null }];
      }
      return routeApi(path, options);
    });
    // showAlert() is what CHWMessagesScreen actually calls in this case — the
    // dialog itself is rendered by AppDialogProvider, which is mounted once
    // at the app root (App.tsx) and has its own dedicated render test
    // (AppDialogProvider.test.tsx). Asserting the call here, at this
    // screen's actual boundary, avoids duplicating that coverage.
    const showAlertSpy = vi.spyOn(showAlertModule, 'showAlert');

    renderScreen();
    await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });

    fireEvent.click(await screen.findByLabelText('Open SDOH / Health Screening'));

    await waitFor(() => {
      expect(showAlertSpy).toHaveBeenCalledWith(
        'Begin a session first',
        'Start a session with this member to run the SDOH / Health Screening and capture answers.',
      );
    });
  });
});

// ─── Epic W1 — adaptive SDOH panel sizing at mid-width ─────────────────────────

describe('CHWMessagesScreen — adaptive SDOH panel sizing at mid-width (Epic W1)', () => {
  // BP_HIDE_RAIL (1280) <= width < SDOH_PANEL_PANE_BREAKPOINT (1700): the
  // rail is visible, but there isn't quite enough room for all 4 columns
  // (thread list + conversation + rail + SDOH panel) at once. Before this
  // fix, InlineSdohPanel fell back to its 'sheet' overlay variant here,
  // which visually covered the rail. This fix reflows instead: the
  // thread-list pane collapses to reclaim the room so the panel can render
  // as a real pane.
  const MID_VIEWPORT_WIDTH = 1450;

  beforeEach(() => {
    setViewportWidth(MID_VIEWPORT_WIDTH);
  });

  afterEach(() => {
    // Restore the wide viewport the other describe blocks in this file assume.
    setViewportWidth(WIDE_VIEWPORT_WIDTH);
  });

  it('reflows to a real pane (not an overlay sheet) by collapsing the thread list, and never covers the rail', async () => {
    renderScreen();

    await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });

    // Before opening the panel, the thread list renders normally at this width.
    expect(screen.getByLabelText('Search message threads')).toBeTruthy();

    fireEvent.click(await screen.findByLabelText('Open SDOH / Health Screening'));
    await screen.findByText('Do you have stable housing?', {}, { timeout: 3000 });

    // 'pane' variant, not 'sheet': no dismissible backdrop overlay is rendered.
    expect(screen.queryByLabelText('Dismiss SDOH panel backdrop')).toBeNull();

    // The thread list pane collapsed to reclaim room for the SDOH pane —
    // the reflow this fix introduces — instead of the panel overlaying the rail.
    expect(screen.queryByLabelText('Search message threads')).toBeNull();

    // The rail itself stays fully visible AND interactive the whole time —
    // the core "must not cover the rail" requirement. Actually opening the
    // inline case note editor (not just checking the button exists) proves
    // the rail is genuinely reachable, not merely present-but-obscured.
    fireEvent.click(screen.getByLabelText('Add case note'));
    expect(await screen.findByLabelText('Case note body')).toBeTruthy();

    // Closing the panel restores the thread list.
    fireEvent.click(screen.getByLabelText('Close SDOH panel'));
    await waitFor(() => {
      expect(screen.getByLabelText('Search message threads')).toBeTruthy();
    });
  });

  it('leaves the thread list visible at mid-width when the SDOH panel is not open (no unnecessary reflow)', async () => {
    renderScreen();

    await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });
    expect(screen.getByLabelText('Search message threads')).toBeTruthy();
  });

  it('still uses the real pane variant at the original wide breakpoint (wide-screen behaviour unchanged)', async () => {
    setViewportWidth(WIDE_VIEWPORT_WIDTH);
    renderScreen();

    await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });
    fireEvent.click(await screen.findByLabelText('Open SDOH / Health Screening'));
    await screen.findByText('Do you have stable housing?', {}, { timeout: 3000 });

    expect(screen.queryByLabelText('Dismiss SDOH panel backdrop')).toBeNull();
    // Plenty of room at this width — the thread list does NOT need to collapse.
    expect(screen.getByLabelText('Search message threads')).toBeTruthy();
  });
});

// ─── Epic I1 — conversation "…" kebab menu verification ────────────────────────

describe('CHWMessagesScreen — conversation "…" kebab menu (Pin / Archive / Delete) — Epic I1', () => {
  // Note: SwipeableThreadRow (swipe-to-act, a separate control) has its own
  // "Archive conversation" / "Delete conversation" accessibility labels, so
  // queries below scope to `role="menuitem"` (the "…" dropdown's items) to
  // disambiguate from the swipe actions rather than colliding on label text
  // alone.

  it('opens the menu and Pin fires useToggleConversationPin against PATCH /conversations/{id}/pin', async () => {
    renderScreen();
    await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });

    fireEvent.click(screen.getByLabelText('More options for thread with Rosa Gutierrez'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin conversation' }));

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        `/conversations/${CONVERSATION_ID}/pin`,
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ pinned: true }),
        }),
      );
    });
  });

  it('opens the menu and Archive fires useToggleConversationArchive against PATCH /conversations/{id}/archive', async () => {
    renderScreen();
    await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });

    fireEvent.click(screen.getByLabelText('More options for thread with Rosa Gutierrez'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive conversation' }));

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        `/conversations/${CONVERSATION_ID}/archive`,
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ archived: true }),
        }),
      );
    });
  });

  it('opens the menu and Delete (after confirming the native dialog) fires useSoftDeleteConversation against DELETE /conversations/{id}', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    try {
      renderScreen();
      await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });

      fireEvent.click(screen.getByLabelText('More options for thread with Rosa Gutierrez'));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete conversation' }));

      expect(confirmSpy).toHaveBeenCalled();
      await waitFor(() => {
        expect(mockedApi).toHaveBeenCalledWith(
          `/conversations/${CONVERSATION_ID}`,
          expect.objectContaining({ method: 'DELETE' }),
        );
      });
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('declining the native confirm dialog does NOT call the delete endpoint', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    try {
      renderScreen();
      await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });

      fireEvent.click(screen.getByLabelText('More options for thread with Rosa Gutierrez'));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete conversation' }));

      expect(confirmSpy).toHaveBeenCalled();
      expect(mockedApi).not.toHaveBeenCalledWith(
        `/conversations/${CONVERSATION_ID}`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    } finally {
      confirmSpy.mockRestore();
    }
  });
});

// ─── Epic P — Cancel / Missed actions on the Complete-Session confirm panel ────

describe('CHWMessagesScreen — Cancel / Missed Session actions (Epic P + O2)', () => {
  /**
   * Scopes queries to the member-context rail (accessibilityLabel "Member
   * context"), not the whole document — AppShell (role="chw") also mounts
   * ActiveSessionBadge in the corner, which renders its OWN "Complete
   * session" button reading off the same active-session fixture data. Both
   * are real, simultaneously-mounted controls in production; the rail is
   * the one under test here (Epic P's second location — ActiveSessionBadge
   * itself is covered in ActiveSessionBadge.test.tsx).
   */
  async function openEndConfirmPanel(): Promise<void> {
    renderScreen();
    await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });
    const rail = within(screen.getByLabelText('Member context'));
    fireEvent.click(await rail.findByLabelText('Complete session'));
    await rail.findByText('Complete the session for Rosa?');
  }

  it('shows Cancel Session, Missed Session, and Complete Session together — no window.confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    try {
      await openEndConfirmPanel();

      expect(screen.getByLabelText('Cancel session (abort)')).toBeTruthy();
      expect(screen.getByLabelText('Mark session missed (no-show)')).toBeTruthy();
      expect(screen.getByLabelText('Confirm complete session')).toBeTruthy();
      expect(confirmSpy).not.toHaveBeenCalled();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('Cancel Session fires PATCH /sessions/{id}/abort and closes the confirm panel', async () => {
    await openEndConfirmPanel();

    fireEvent.click(screen.getByLabelText('Cancel session (abort)'));

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        `/sessions/${SESSION_ID}/abort`,
        expect.objectContaining({ method: 'PATCH' }),
      );
    });

    // The confirm panel closes immediately on tap (before the mutation
    // resolves) — mirrors handleCancelSessionConfirmed's setShowEndConfirm(false).
    await waitFor(() => {
      expect(screen.queryByText('Complete the session for Rosa?')).toBeNull();
    });
  });

  it('Missed Session fires PATCH /sessions/{id}/no-show and closes the confirm panel', async () => {
    await openEndConfirmPanel();

    fireEvent.click(screen.getByLabelText('Mark session missed (no-show)'));

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        `/sessions/${SESSION_ID}/no-show`,
        expect.objectContaining({ method: 'PATCH' }),
      );
    });

    await waitFor(() => {
      expect(screen.queryByText('Complete the session for Rosa?')).toBeNull();
    });
  });

  it('after Cancel Session succeeds, the rail clears the destructive-session state (badge/timer gone, no longer showing Complete Session)', async () => {
    await openEndConfirmPanel();

    fireEvent.click(screen.getByLabelText('Cancel session (abort)'));

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        `/sessions/${SESSION_ID}/abort`,
        expect.objectContaining({ method: 'PATCH' }),
      );
    });

    // The `cancelled` status is real and briefly reachable via useSession,
    // but — now that the abort mutation also invalidates `queryKeys
    // .conversations` (the fix under test) — the conversations refetch that
    // clears `activeSessionId` can land in the same act() flush, so the
    // terminal "Session cancelled" note is not a reliably observable
    // intermediate state here (see the dedicated recovery test below, which
    // covers the full Begin-Session-reset behavior this note is a step
    // toward). What IS guaranteed and asserted: the destructive action
    // fired, and the rail no longer shows a "Complete session" button for
    // the now-ended session.
    const rail = within(screen.getByLabelText('Member context'));
    await waitFor(() => {
      expect(rail.queryByLabelText('Complete session')).toBeNull();
    });
  });

  it('after Missed Session succeeds, the rail clears the destructive-session state (badge/timer gone, no longer showing Complete Session)', async () => {
    await openEndConfirmPanel();

    fireEvent.click(screen.getByLabelText('Mark session missed (no-show)'));

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        `/sessions/${SESSION_ID}/no-show`,
        expect.objectContaining({ method: 'PATCH' }),
      );
    });

    const rail = within(screen.getByLabelText('Member context'));
    await waitFor(() => {
      expect(rail.queryByLabelText('Complete session')).toBeNull();
    });
  });

  // ── Regression: Begin Session must reset without a manual refresh ──────────
  //
  // This is the actual bug under test: does the rail recover to "Begin
  // Session" so the CHW can immediately start a new session with the same
  // member, or does it stay stuck until a manual page reload? That
  // transition is driven by useSessionHook re-keying off
  // `conv.activeSessionId` once the conversations query refetches with
  // `active_session_id: null` — which only happens if the mutation
  // invalidates `queryKeys.conversations` (not just `queryKeys.sessions`).
  // These tests assert that full recovery, relying ONLY on the mutations'
  // own onSuccess invalidation (this file's mocked `/conversations/` route
  // reflects `currentSessionStatus`, mirroring the real backend) — no manual
  // refetch/reload call anywhere in the test.
  it('after Missed Session succeeds, Begin Session reappears in the rail without a manual refresh', async () => {
    await openEndConfirmPanel();

    fireEvent.click(screen.getByLabelText('Mark session missed (no-show)'));

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        `/sessions/${SESSION_ID}/no-show`,
        expect.objectContaining({ method: 'PATCH' }),
      );
    });

    // Purely from the conversations-query invalidation the mutation itself
    // triggers (no test-driven refetch call), the rail must recover to a
    // fresh "Begin Session" — proving the CHW can start a new session with
    // this member immediately, matching Complete Session's behavior.
    const rail = within(screen.getByLabelText('Member context'));
    expect(await rail.findByLabelText('Begin session')).toBeTruthy();
    expect(rail.queryByText('Missed — member did not attend')).toBeNull();
  });

  it('after Cancel Session succeeds, Begin Session reappears in the rail without a manual refresh', async () => {
    await openEndConfirmPanel();

    fireEvent.click(screen.getByLabelText('Cancel session (abort)'));

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        `/sessions/${SESSION_ID}/abort`,
        expect.objectContaining({ method: 'PATCH' }),
      );
    });

    const rail = within(screen.getByLabelText('Member context'));
    expect(await rail.findByLabelText('Begin session')).toBeTruthy();
    expect(rail.queryByText('Session cancelled')).toBeNull();
  });
});

// ─── Epic Q4 — Documentation submission as an on-brand Messages overlay ───────

describe('CHWMessagesScreen — Documentation modal renders as an on-brand overlay (Epic Q4)', () => {
  it('End Session opens DocumentationModal as an on-brand overlay (not a full-screen Modal takeover), with Q1-Q3 internals intact', async () => {
    renderScreen();
    await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });

    const rail = within(screen.getByLabelText('Member context'));
    fireEvent.click(await rail.findByLabelText('Complete session'));
    await rail.findByText('Complete the session for Rosa?');
    fireEvent.click(screen.getByLabelText('Confirm complete session'));

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        `/sessions/${SESSION_ID}/end`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    // The documentation form is now open — its header close button is a
    // reliable "the modal mounted" signal.
    const closeBtn = await screen.findByLabelText('Close documentation modal');
    expect(closeBtn).toBeTruthy();

    // On-brand overlay: rendered in-place inside the Messages page, NOT via
    // RN's Modal (which react-native-web portals to a node outside the
    // rendered tree). Asserting it's reachable through the same `document`
    // that also still contains the Messages thread/composer proves it's an
    // in-page overlay, not a screen takeover that replaced the page.
    expect(screen.getByPlaceholderText(/type a message/i)).toBeTruthy();
    expect(screen.getByLabelText('Search message threads')).toBeTruthy();

    // Q1: inline "Units: N" line present (spot-assert Q1-Q3 survive the
    // presentation change).
    expect(screen.getByText('Units:')).toBeTruthy();

    // Q3: a grouped diagnosis chip renders inside the overlay.
    fireEvent.click(screen.getByLabelText('Housing'));
    expect(screen.getByLabelText('Z59.00: Homelessness, unspecified')).toBeTruthy();
  });

  it('the 16-minute not-billable gate still blocks submit inside the Messages overlay', async () => {
    // 10-minute session (started 09:00, ended 09:10) — under the 16-minute
    // floor, so the overlay's submit must stay blocked.
    endSessionEndedAt = '2026-07-11T09:10:00.000Z';
    renderScreen();
    await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });

    const rail = within(screen.getByLabelText('Member context'));
    fireEvent.click(await rail.findByLabelText('Complete session'));
    await rail.findByText('Complete the session for Rosa?');
    fireEvent.click(screen.getByLabelText('Confirm complete session'));

    await screen.findByLabelText('Close documentation modal');

    expect(
      screen.getByText('Under 16 minutes — not billable; no claim will be filed.'),
    ).toBeTruthy();
    const submit = screen.getByLabelText('Submit documentation and billing');
    expect(submit.getAttribute('aria-disabled')).toBe('true');
  });
});

// ─── Epic S follow-up — PressableMember "Back to Messages" origin params ──────

describe('CHWMessagesScreen — Member Profile links pass backLabel "Messages" (Epic S follow-up)', () => {
  it('the conversation header "Open Profile" button passes backLabel/backTo "Messages"', async () => {
    renderScreen();
    await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });

    // The conversation header wraps the avatar, the name, AND the explicit
    // "Open Profile" button in their own PressableMember, all sharing this
    // same accessibility label — click any one; they all resolve to the same
    // navigation call under test here. findAll (not getAll): under CI load
    // the header PressableMembers can mount a tick after the name text
    // resolves, which flaked this test in slower parallel runs.
    const profileLinks = await screen.findAllByLabelText(
      "Open Rosa Gutierrez's profile",
      {},
      { timeout: 3000 },
    );
    expect(profileLinks.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(profileLinks[0]);

    expect(mockNavigate).toHaveBeenCalledWith('SessionsStack', {
      screen: 'MemberProfile',
      params: { memberId: MEMBER_ID, backLabel: 'Messages', backTo: 'Messages' },
    });
  });

  it('the rail Quick Actions "Open Member Profile" button passes backLabel/backTo "Messages"', async () => {
    renderScreen();
    await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });

    // findBy variants for the same CI-load reason as the header test above.
    const rail = within(await screen.findByLabelText('Member context', {}, { timeout: 3000 }));
    fireEvent.click(await rail.findByLabelText("Open Rosa Gutierrez's profile", {}, { timeout: 3000 }));

    expect(mockNavigate).toHaveBeenCalledWith('SessionsStack', {
      screen: 'MemberProfile',
      params: { memberId: MEMBER_ID, backLabel: 'Messages', backTo: 'Messages' },
    });
  });
});
