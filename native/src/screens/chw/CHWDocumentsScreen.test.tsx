/**
 * Component test for CHWDocumentsScreen — QA item ② restructure: the
 * Documents page landing view is now the CHW's caseload member list
 * (searchable), and selecting a member opens THEIR per-member repository:
 * uploaded documents (useMemberDocuments) merged with chat file attachments
 * (useMemberChatAttachments), date-sorted, each row tagged with its source.
 *
 * Only the network boundary (`../../api/client`), auth context, and
 * navigation are mocked — useChwMembers, useMemberDocuments,
 * useMemberChatAttachments, useMemberDocumentDelete,
 * useMemberDocumentDownloadUrl, and useMessageAttachmentDownloadUrl all run
 * for real against a routed `api()` mock (Tier 2 — jsdom + react-native-web,
 * see native/TESTING.md). `Platform.OS` resolves to 'web' under
 * react-native-web, so this exercises the real web AppShell layout.
 */
import React from 'react';
import { Linking } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ userName: 'Test CHW' }),
}));
// Full literal replacement (not importOriginal) — the real
// @react-navigation/native barrel throws under jsdom/vite-node module
// resolution. CHWDocumentsScreen only needs useRoute (RouteProp is
// type-only, erased at compile time). See CHWMessagesScreen.test.tsx for the
// detailed rationale.
let routeParams: { memberId?: string } = {};
const mockNavigate = vi.fn();
vi.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: routeParams }),
  useNavigation: () => ({
    navigate: mockNavigate,
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
    setOptions: vi.fn(),
  }),
}));

import { api } from '../../api/client';
import { CHWDocumentsScreen } from './CHWDocumentsScreen';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const MEMBER_1_ID = 'member-1';
const MEMBER_1_NAME = 'Rosa Gutierrez';
const MEMBER_2_ID = 'member-2';
const MEMBER_2_NAME = 'Miguel Alvarez';

const member1Fixture = {
  id: MEMBER_1_ID,
  display_name: MEMBER_1_NAME,
  age: 34,
  date_of_birth: '1992-01-01',
  masked_id: '...4567',
  medi_cal_id: '91234567A',
  avatar_initials: 'RG',
  status: 'active',
  risk: null,
  engagement: 'moderately',
  active_journey: null,
  last_contact_at: null,
  top_need: null,
  created_at: '2026-03-14T12:00:00.000Z',
};

const member2Fixture = {
  ...member1Fixture,
  id: MEMBER_2_ID,
  display_name: MEMBER_2_NAME,
  avatar_initials: 'MA',
  masked_id: '...8899',
};

const uploadedDocFixture = {
  id: 'doc-1',
  member_id: MEMBER_1_ID,
  document_type: 'id',
  filename: 'passport.pdf',
  content_type: 'application/pdf',
  size_bytes: 204800,
  uploaded_by: 'chw-1',
  uploaded_at: '2026-06-01T10:00:00.000Z',
  deleted_at: null,
};

const chatAttachmentFixture = {
  id: 'msg-1',
  filename: 'insurance_card.jpg',
  content_type: 'image/jpeg',
  size_bytes: 51200,
  created_at: '2026-06-15T10:00:00.000Z',
};

/** A grandfathered 'medical' document row — QA batch #7 Part 6: the type/filter
 * chip is removed from pickers, but pre-existing 'medical' rows must keep
 * rendering under "All Types". */
const medicalDocFixture = {
  id: 'doc-medical-1',
  member_id: MEMBER_1_ID,
  document_type: 'medical',
  filename: 'immunization_record.pdf',
  content_type: 'application/pdf',
  size_bytes: 102400,
  uploaded_by: 'chw-1',
  uploaded_at: '2026-05-01T10:00:00.000Z',
  deleted_at: null,
};

/** QA batch #7 Part 7 — a CHW's own compliance-checklist upload (GET /credentials/mine). */
const myCredentialFixture = {
  id: 'cred-1',
  chw_id: 'chw-1',
  type: 'hipaa_training',
  label: 'HIPAA Training',
  status: 'pending',
  s3_key: 'users/chw-1/credential/hipaa-cert.pdf',
  file_name: 'hipaa-cert.pdf',
  verified_by: null,
  verified_at: null,
  created_at: '2026-06-20T09:00:00.000Z',
};

let membersResponse: unknown[] = [member1Fixture, member2Fixture];
let docsResponse: { items: unknown[]; total: number; page: number; page_size: number } = {
  items: [uploadedDocFixture],
  total: 1,
  page: 1,
  page_size: 50,
};
let attachmentsResponse: { items: unknown[]; total: number; page: number; page_size: number } = {
  items: [chatAttachmentFixture],
  total: 1,
  page: 1,
  page_size: 50,
};
let myCredentialsResponse: unknown[] = [];

const deleteMock = vi.fn();

function routeApi(path: string, options?: { method?: string; body?: string }): unknown {
  const method = options?.method ?? 'GET';

  if (path === '/credentials/mine' && method === 'GET') {
    return myCredentialsResponse;
  }
  if (path.startsWith('/credentials/') && path.endsWith('/download-url') && method === 'GET') {
    return { download_url: 'https://s3.example.com/signed-credential', expires_in_seconds: 900 };
  }

  if (path === '/chw/members' && method === 'GET') {
    return membersResponse;
  }
  if (path.startsWith(`/members/${MEMBER_1_ID}/documents`) && method === 'GET') {
    return docsResponse;
  }
  if (path.startsWith(`/members/${MEMBER_2_ID}/documents`) && method === 'GET') {
    return { items: [], total: 0, page: 1, page_size: 50 };
  }
  if (path.startsWith(`/chw/members/${MEMBER_1_ID}/attachments`) && method === 'GET') {
    return attachmentsResponse;
  }
  if (path.startsWith(`/chw/members/${MEMBER_2_ID}/attachments`) && method === 'GET') {
    return { items: [], total: 0, page: 1, page_size: 50 };
  }
  if (path.startsWith('/documents/') && path.endsWith('/download-url') && method === 'GET') {
    return { download_url: 'https://s3.example.com/signed-doc', expires_in_seconds: 900 };
  }
  if (path.startsWith('/conversations/messages/') && path.endsWith('/attachment-url') && method === 'GET') {
    return {
      url: 'https://s3.example.com/signed-chat-file',
      filename: chatAttachmentFixture.filename,
      content_type: chatAttachmentFixture.content_type,
      size_bytes: chatAttachmentFixture.size_bytes,
      expires_in_seconds: 300,
    };
  }
  if (path.startsWith('/documents/') && method === 'DELETE') {
    deleteMock(path);
    return undefined;
  }

  throw new Error(`Unhandled api() call in CHWDocumentsScreen test: ${method} ${path}`);
}

// ─── Harness ──────────────────────────────────────────────────────────────────

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CHWDocumentsScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  routeParams = {};
  membersResponse = [member1Fixture, member2Fixture];
  docsResponse = { items: [uploadedDocFixture], total: 1, page: 1, page_size: 50 };
  attachmentsResponse = { items: [chatAttachmentFixture], total: 1, page: 1, page_size: 50 };
  myCredentialsResponse = [];
  deleteMock.mockClear();
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string; body?: string }) =>
    routeApi(path, options),
  );
  if (typeof window !== 'undefined') {
    window.confirm = vi.fn(() => true);
    window.open = vi.fn();
    window.alert = vi.fn();
  }
  vi.spyOn(Linking, 'openURL').mockResolvedValue(true);
});

// ─── Landing view: member list + search ────────────────────────────────────────

describe('CHWDocumentsScreen — landing member list', () => {
  it('renders the caseload member list (not the old collapsible-groups feed)', async () => {
    renderScreen();

    await screen.findByText(MEMBER_1_NAME);
    expect(screen.getByText(MEMBER_2_NAME)).toBeTruthy();
    // Landing copy directs the CHW to select a member.
    expect(screen.getByText('Select a member to view their document repository')).toBeTruthy();
  });

  it('search filters the member list by name', async () => {
    renderScreen();
    await screen.findByText(MEMBER_1_NAME);

    const search = screen.getByLabelText('Search caseload members');
    fireEvent.change(search, { target: { value: 'Miguel' } });

    await waitFor(() => {
      expect(screen.queryByText(MEMBER_1_NAME)).toBeNull();
    });
    expect(screen.getByText(MEMBER_2_NAME)).toBeTruthy();
  });

  it('selecting a member opens their repository', async () => {
    renderScreen();
    const row = await screen.findByLabelText(`Open documents for ${MEMBER_1_NAME}`);
    fireEvent.click(row);

    // Repository header shows the member's name as the page title, plus a
    // back control to return to the list.
    await screen.findByLabelText('Back to member list');
    expect(screen.getAllByText(MEMBER_1_NAME).length).toBeGreaterThan(0);
  });
});

// ─── Repository view: merged sources + filters ─────────────────────────────────

describe('CHWDocumentsScreen — member repository', () => {
  async function openRepository() {
    renderScreen();
    const row = await screen.findByLabelText(`Open documents for ${MEMBER_1_NAME}`);
    fireEvent.click(row);
    await screen.findByLabelText('Back to member list');
  }

  it('renders BOTH the uploaded document and the chat attachment, with correct source badges', async () => {
    await openRepository();

    await screen.findByText('passport.pdf');
    expect(screen.getByText('insurance_card.jpg')).toBeTruthy();

    // Uploaded doc shows its document-type pill (Photo ID) — also present as
    // a filter chip label, hence getAllByText; chat attachment shows the
    // "From chat" badge.
    expect(screen.getAllByText('Photo ID').length).toBeGreaterThan(0);
    expect(screen.getByText('From chat')).toBeTruthy();
  });

  it('the "From Chat" filter chip shows only chat attachments', async () => {
    await openRepository();
    await screen.findByText('passport.pdf');

    fireEvent.click(screen.getByLabelText('Filter by From Chat'));

    await waitFor(() => {
      expect(screen.queryByText('passport.pdf')).toBeNull();
    });
    expect(screen.getByText('insurance_card.jpg')).toBeTruthy();
  });

  it('a document-type chip filters to uploaded docs of that type only', async () => {
    await openRepository();
    await screen.findByText('passport.pdf');

    fireEvent.click(screen.getByLabelText('Filter by Photo ID'));

    await waitFor(() => {
      expect(screen.queryByText('insurance_card.jpg')).toBeNull();
    });
    expect(screen.getByText('passport.pdf')).toBeTruthy();
  });

  it('back control returns to the member list', async () => {
    await openRepository();
    await screen.findByText('passport.pdf');

    fireEvent.click(screen.getByLabelText('Back to member list'));

    await screen.findByText('Select a member to view their document repository');
    expect(screen.getByText(MEMBER_1_NAME)).toBeTruthy();
    expect(screen.getByText(MEMBER_2_NAME)).toBeTruthy();
  });

  it('shows the member-scoped empty state when a member has neither uploads nor chat files', async () => {
    renderScreen();
    const row = await screen.findByLabelText(`Open documents for ${MEMBER_2_NAME}`);
    fireEvent.click(row);

    await screen.findByText(
      `No documents yet for ${MEMBER_2_NAME} — upload one or files shared in chat will appear here.`,
    );
  });

  it('download regression: clicking download on an uploaded doc fetches its presigned URL and opens it', async () => {
    await openRepository();
    await screen.findByText('passport.pdf');

    fireEvent.click(screen.getByLabelText('Download document'));

    await waitFor(() => {
      expect(Linking.openURL).toHaveBeenCalledWith('https://s3.example.com/signed-doc');
    });
  });

  it('download regression: clicking download on a chat attachment fetches the message attachment-url', async () => {
    await openRepository();
    await screen.findByText('insurance_card.jpg');

    fireEvent.click(screen.getByLabelText('Download file shared in chat'));

    await waitFor(() => {
      const calledPaths = mockedApi.mock.calls.map((c) => c[0]);
      expect(
        calledPaths.some(
          (p) => typeof p === 'string' && p.includes('/conversations/messages/msg-1/attachment-url'),
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(Linking.openURL).toHaveBeenCalledWith('https://s3.example.com/signed-chat-file');
    });
  });

  it('delete regression: deleting an uploaded doc calls the delete endpoint and confirms first', async () => {
    await openRepository();
    await screen.findByText('passport.pdf');

    fireEvent.click(screen.getByLabelText('Delete passport.pdf'));

    expect(window.confirm).toHaveBeenCalledWith('Delete "passport.pdf"?');
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/documents/doc-1');
    });
  });

  it('chat attachments have no delete control (uploaded docs only)', async () => {
    await openRepository();
    await screen.findByText('insurance_card.jpg');

    expect(screen.queryByLabelText('Delete insurance_card.jpg')).toBeNull();
  });
});

// ─── Upload-from-repository preselect ──────────────────────────────────────────

describe('CHWDocumentsScreen — upload preselect', () => {
  it('"Upload for Member" from inside a repository skips the member picker', async () => {
    renderScreen();
    const row = await screen.findByLabelText(`Open documents for ${MEMBER_1_NAME}`);
    fireEvent.click(row);
    await screen.findByText('passport.pdf');

    const uploadButtons = screen.getAllByLabelText(`Upload document for ${MEMBER_1_NAME}`);
    fireEvent.click(uploadButtons[0]);

    // Jumps straight to doc-type choice — never shows the "Select a member"
    // picker step or a "Back to members" link inside the drawer.
    await screen.findByText('Choose document type');
    expect(screen.getByText(`Uploading for ${MEMBER_1_NAME}`)).toBeTruthy();
    expect(screen.queryByLabelText('Search caseload')).toBeNull();
    expect(screen.queryByLabelText('Back to member list')).toBeTruthy(); // repository's own back control still present
    expect(screen.queryByText('Back to members')).toBeNull(); // drawer-internal back link is absent when preselected
  });

  it('the global "Upload for Member" trigger (landing view) still shows the full picker', async () => {
    renderScreen();
    await screen.findByText(MEMBER_1_NAME);

    fireEvent.click(screen.getByLabelText('Upload document for a member'));

    await screen.findByText('Select a member');
    expect(screen.getByLabelText('Search caseload')).toBeTruthy();
  });
});

// ─── Deep-link ──────────────────────────────────────────────────────────────────

describe('CHWDocumentsScreen — deep link', () => {
  it('a memberId route param opens that member’s repository directly', async () => {
    routeParams = { memberId: MEMBER_2_ID };
    renderScreen();

    await screen.findByLabelText('Back to member list');
    expect(screen.getAllByText(MEMBER_2_NAME).length).toBeGreaterThan(0);
  });
});

// ─── QA batch #7 Part 6: 'Medical' category removed (grandfathered) ───────────

describe('CHWDocumentsScreen — Medical category removed (Part 6)', () => {
  it('the repository filter chips no longer include Medical', async () => {
    renderScreen();
    const row = await screen.findByLabelText(`Open documents for ${MEMBER_1_NAME}`);
    fireEvent.click(row);
    await screen.findByText('passport.pdf');

    expect(screen.queryByLabelText('Filter by Medical')).toBeNull();
    // The other type chips are still present.
    expect(screen.getByLabelText('Filter by Photo ID')).toBeTruthy();
  });

  it('the upload doc-type picker no longer offers Medical', async () => {
    renderScreen();
    await screen.findByText(MEMBER_1_NAME);

    fireEvent.click(screen.getByLabelText('Upload document for a member'));
    await screen.findByText('Select a member');

    fireEvent.click(screen.getByLabelText(`Select ${MEMBER_1_NAME}`));
    await screen.findByText('Choose document type');

    expect(screen.queryByLabelText('Upload Medical')).toBeNull();
    expect(screen.getByLabelText('Upload Photo ID')).toBeTruthy();
  });

  it('a previously-uploaded Medical-typed document still renders under All Types', async () => {
    docsResponse = {
      items: [uploadedDocFixture, medicalDocFixture],
      total: 2,
      page: 1,
      page_size: 50,
    };
    renderScreen();
    const row = await screen.findByLabelText(`Open documents for ${MEMBER_1_NAME}`);
    fireEvent.click(row);

    // Default filter is "All Types" — the grandfathered medical row renders
    // with its filename and its (still-present) "Medical" type label.
    await screen.findByText('immunization_record.pdf');
    expect(screen.getByText('passport.pdf')).toBeTruthy();
    expect(screen.getByText('Medical')).toBeTruthy();
  });
});

// ─── QA batch #7 Part 7: My Compliance Documents (landing view) ───────────────

describe('CHWDocumentsScreen — My Compliance Documents (Part 7)', () => {
  it('renders nothing when the CHW has no compliance-document uploads', async () => {
    myCredentialsResponse = [];
    renderScreen();
    await screen.findByText(MEMBER_1_NAME);

    expect(screen.queryByText('My Compliance Documents')).toBeNull();
  });

  it('renders the section with label, status chip, and date for an uploaded credential', async () => {
    myCredentialsResponse = [myCredentialFixture];
    renderScreen();

    await screen.findByText('My Compliance Documents');
    expect(screen.getByText('HIPAA Training')).toBeTruthy();
    expect(screen.getByText('Pending review')).toBeTruthy();
  });

  it('View fetches a presigned URL via the credentials download-url endpoint and opens it', async () => {
    myCredentialsResponse = [myCredentialFixture];
    renderScreen();
    await screen.findByText('My Compliance Documents');

    fireEvent.click(screen.getByLabelText('View document'));

    await waitFor(() => {
      const calledPaths = mockedApi.mock.calls.map((c) => c[0]);
      expect(
        calledPaths.some(
          (p) => typeof p === 'string' && p === '/credentials/cred-1/download-url',
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(Linking.openURL).toHaveBeenCalledWith('https://s3.example.com/signed-credential');
    });
  });

  it('shows a Verified pill for a verified credential', async () => {
    myCredentialsResponse = [{ ...myCredentialFixture, status: 'verified' }];
    renderScreen();

    await screen.findByText('My Compliance Documents');
    expect(screen.getByText('Verified')).toBeTruthy();
  });
});
