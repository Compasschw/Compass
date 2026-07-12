/**
 * Component test for CHWMessagesScreen — proves the in-Messages SDOH panel
 * (InlineSdohPanel, wired via MemberContextRail's onOpenSdohPanel) is
 * non-blocking: the message thread and the "Add Case Note" action stay
 * present and interactive in the DOM while the panel is open. This is the
 * core requirement of the SDOH-inline-panel feature (previously the rail
 * card navigated away to a separate CHWMemberAssessmentScreen).
 *
 * Only the network boundary (`../../api/client`), auth context, and
 * navigation hooks are mocked — every data hook (useConversations,
 * useSession, useConversationMessages, useChwJourneys,
 * useMemberServicesConsent, useAssessmentBootstrap's fetch/start calls,
 * useCreateCaseNote) runs for real against a routed `api()` mock, so this
 * exercises the actual production wiring, not a hand-rolled hook mock.
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

beforeAll(() => {
  // Wide desktop viewport so the SDOH panel renders as a true 4th pane
  // ('pane' variant) — the primary, non-blocking layout under test.
  Object.defineProperty(document.documentElement, 'clientWidth', {
    value: SDOH_PANEL_PANE_BREAKPOINT + 200,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    value: 1000,
    configurable: true,
  });
});

beforeEach(() => {
  mockedApi.mockReset();
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

    // The case note drawer opens on top (existing behaviour, unchanged) —
    // proves the click actually reached and activated the control, not just
    // that it was present in the DOM inertly. Match on the drawer's subtitle
    // (unique to the open drawer) rather than "Add Case Note" — that text is
    // ambiguous with the still-visible quick-action button label underneath.
    await screen.findByText("Attach a clinical note to this member's record");
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

    // The case note drawer closes after save, and the SDOH panel underneath
    // is still open/untouched — proves the two coexisted rather than one
    // having silently unmounted the other.
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
