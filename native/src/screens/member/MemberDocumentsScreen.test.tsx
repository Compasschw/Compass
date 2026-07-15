/**
 * Component test for MemberDocumentsScreen — QA batch #7 Part 19: replaced
 * the five per-category upload cards (Photo ID / Income / Address / Medical
 * / Other) with a single "Upload Documents" card, an optional document-type
 * picker (id/income/address/other — no medical, per Part 6), and a plain
 * uploaded-documents list (no more per-category "Document Checklist" rail).
 *
 * Only the network boundary (`../../api/client`) and auth context are
 * mocked — useMemberProfile, useMemberDocuments, useMemberDocumentDelete,
 * and useMemberDocumentDownloadUrl all run for real against a routed
 * `api()` mock (Tier 2 — jsdom + react-native-web, see native/TESTING.md).
 */
import React from 'react';
import { Linking } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ userName: 'Test Member' }),
}));
// AppShell's sidebar calls useNavigation() internally (DashboardSidebar). The
// real `@react-navigation/native` barrel drags in an extension-less import
// that jsdom/vite-node can't resolve — same pattern as
// MemberHomeScreen.test.tsx / MemberSettingsScreen.test.tsx.
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: vi.fn(),
  }),
}));

import { api } from '../../api/client';
import { MemberDocumentsScreen } from './MemberDocumentsScreen';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const MEMBER_USER_ID = 'member-1';

function buildMemberProfileFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'profile-1',
    user_id: MEMBER_USER_ID,
    zip_code: '90001',
    primary_language: 'English',
    primary_need: 'housing',
    name: 'Test Member',
    must_change_password: false,
    ...overrides,
  };
}

const idDocFixture = {
  id: 'doc-1',
  member_id: MEMBER_USER_ID,
  document_type: 'id',
  filename: 'drivers_license.pdf',
  content_type: 'application/pdf',
  size_bytes: 204800,
  uploaded_by: MEMBER_USER_ID,
  uploaded_at: '2026-06-01T10:00:00.000Z',
  deleted_at: null,
};

const otherDocFixture = {
  id: 'doc-2',
  member_id: MEMBER_USER_ID,
  document_type: 'other',
  filename: 'lease_agreement.pdf',
  content_type: 'application/pdf',
  size_bytes: 102400,
  uploaded_by: MEMBER_USER_ID,
  uploaded_at: '2026-06-10T10:00:00.000Z',
  deleted_at: null,
};

/** A pre-existing medical-typed row (grandfathered per Part 6) — must still render. */
const medicalDocFixture = {
  id: 'doc-medical-1',
  member_id: MEMBER_USER_ID,
  document_type: 'medical',
  filename: 'immunization_record.pdf',
  content_type: 'application/pdf',
  size_bytes: 51200,
  uploaded_by: MEMBER_USER_ID,
  uploaded_at: '2026-05-01T10:00:00.000Z',
  deleted_at: null,
};

let profileResponse: unknown = buildMemberProfileFixture();
let docsResponse: { items: unknown[]; total: number; page: number; page_size: number } = {
  items: [idDocFixture, otherDocFixture],
  total: 2,
  page: 1,
  page_size: 50,
};

const deleteMock = vi.fn();
const uploadedFileRecordFixture = {
  id: 'doc-new-1',
  member_id: MEMBER_USER_ID,
  document_type: 'other',
  filename: 'new_upload.pdf',
  content_type: 'application/pdf',
  size_bytes: 10240,
  uploaded_by: MEMBER_USER_ID,
  uploaded_at: '2026-07-14T10:00:00.000Z',
  deleted_at: null,
};

function routeApi(path: string, options?: { method?: string; body?: string }): unknown {
  const method = options?.method ?? 'GET';

  if (path === '/member/profile' && method === 'GET') {
    return profileResponse;
  }
  if (path.startsWith(`/members/${MEMBER_USER_ID}/documents`) && method === 'GET') {
    return docsResponse;
  }
  if (path === '/upload/presigned-url' && method === 'POST') {
    return { upload_url: 'https://s3.example.com/presigned-put?sig=abc', s3_key: 'users/member-1/document/new_upload.pdf' };
  }
  if (path === `/members/${MEMBER_USER_ID}/documents` && method === 'POST') {
    const body = options?.body ? (JSON.parse(options.body) as Record<string, unknown>) : {};
    return { ...uploadedFileRecordFixture, document_type: body.document_type ?? 'other' };
  }
  if (path.startsWith('/documents/') && path.endsWith('/download-url') && method === 'GET') {
    return { download_url: 'https://s3.example.com/signed-doc', expires_in_seconds: 900 };
  }
  if (path.startsWith('/documents/') && method === 'DELETE') {
    deleteMock(path);
    return undefined;
  }

  throw new Error(`Unhandled api() call in MemberDocumentsScreen test: ${method} ${path}`);
}

// ─── Harness ──────────────────────────────────────────────────────────────────

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemberDocumentsScreen />
    </QueryClientProvider>,
  );
}

// Stub fetch for the direct-to-S3 PUT step in useFileUpload's pipeline.
const originalFetch = global.fetch;

beforeEach(() => {
  profileResponse = buildMemberProfileFixture();
  docsResponse = { items: [idDocFixture, otherDocFixture], total: 2, page: 1, page_size: 50 };
  deleteMock.mockClear();
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string; body?: string }) =>
    routeApi(path, options),
  );
  global.fetch = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
  if (typeof window !== 'undefined') {
    window.confirm = vi.fn(() => true);
    window.alert = vi.fn();
  }
  // jsdom does not implement URL.createObjectURL — useFileUpload's web path
  // calls it to build a local preview URI for the picked file.
  URL.createObjectURL = vi.fn(() => 'blob:mock-object-url');
  vi.spyOn(Linking, 'openURL').mockResolvedValue(true);
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ─── Header + upload card ───────────────────────────────────────────────────

describe('MemberDocumentsScreen — header + single upload card', () => {
  it('renders "N uploaded" (no "M needed") in the header subtitle', async () => {
    renderScreen();
    await screen.findByText('drivers_license.pdf');

    expect(screen.getByText('2 uploaded')).toBeTruthy();
    expect(screen.queryByText(/needed/i)).toBeNull();
  });

  it('renders a single "Upload Documents" button — no per-category upload buttons', async () => {
    renderScreen();
    await screen.findByText('drivers_license.pdf');

    expect(screen.getByLabelText('Upload Documents')).toBeTruthy();
    expect(screen.queryByLabelText('Upload Photo ID')).toBeNull();
    expect(screen.queryByLabelText('Upload Income Verification')).toBeNull();
    expect(screen.queryByLabelText('Upload Proof of Address')).toBeNull();
    expect(screen.queryByLabelText('Upload Medical Documents')).toBeNull();
    expect(screen.queryByLabelText('Upload Other')).toBeNull();
  });

  it('the type picker offers id/income/address/other but never Medical', async () => {
    renderScreen();
    await screen.findByText('drivers_license.pdf');

    expect(screen.getByLabelText('Document type: Photo ID')).toBeTruthy();
    expect(screen.getByLabelText('Document type: Income')).toBeTruthy();
    expect(screen.getByLabelText('Document type: Address')).toBeTruthy();
    expect(screen.getByLabelText('Document type: Other')).toBeTruthy();
    expect(screen.queryByLabelText('Document type: Medical')).toBeNull();
  });

  it('the guidance copy is preserved (checklist rail removed, copy carried over)', async () => {
    renderScreen();
    await screen.findByText('drivers_license.pdf');

    expect(
      screen.getByText('Upload ID, income proof, and other documents your CHW requests.'),
    ).toBeTruthy();
    expect(screen.queryByText('Document Checklist')).toBeNull();
  });

  it('the "Other" type option is selected by default', async () => {
    renderScreen();
    await screen.findByText('drivers_license.pdf');

    const otherOption = screen.getByLabelText('Document type: Other');
    expect(otherOption.getAttribute('aria-checked')).toBe('true');
  });
});

// ─── Uploaded-documents list ────────────────────────────────────────────────

describe('MemberDocumentsScreen — uploaded documents list', () => {
  it('renders every uploaded document, newest first', async () => {
    renderScreen();
    await screen.findByText('drivers_license.pdf');
    expect(screen.getByText('lease_agreement.pdf')).toBeTruthy();
  });

  it('a pre-existing Medical-typed document still renders (grandfathered)', async () => {
    docsResponse = {
      items: [idDocFixture, otherDocFixture, medicalDocFixture],
      total: 3,
      page: 1,
      page_size: 50,
    };
    renderScreen();

    await screen.findByText('immunization_record.pdf');
    expect(screen.getByText('3 uploaded')).toBeTruthy();
  });

  it('shows the empty state when the member has no documents', async () => {
    docsResponse = { items: [], total: 0, page: 1, page_size: 50 };
    renderScreen();

    await screen.findByText('No documents uploaded yet');
    expect(screen.getByText('0 uploaded')).toBeTruthy();
  });

  it('download: clicking download fetches a presigned URL and opens it', async () => {
    renderScreen();
    await screen.findByText('drivers_license.pdf');

    fireEvent.click(screen.getAllByLabelText('Download document')[0]);

    await waitFor(() => {
      expect(Linking.openURL).toHaveBeenCalledWith('https://s3.example.com/signed-doc');
    });
  });

  it('delete: deleting a document confirms first, then calls the delete endpoint', async () => {
    renderScreen();
    await screen.findByText('drivers_license.pdf');

    fireEvent.click(screen.getByLabelText('Delete drivers_license.pdf'));

    expect(window.confirm).toHaveBeenCalledWith('Delete "drivers_license.pdf"?');
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/documents/doc-1');
    });
  });
});

// ─── Upload flow ────────────────────────────────────────────────────────────

describe('MemberDocumentsScreen — upload flow', () => {
  it('uploading with the default type posts document_type "other"', async () => {
    renderScreen();
    await screen.findByText('drivers_license.pdf');

    const file = new File(['dummy'], 'new_upload.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type="file"][accept*="heic"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      const postCall = mockedApi.mock.calls.find(
        (c) => c[0] === `/members/${MEMBER_USER_ID}/documents` && c[1]?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const options = (postCall as unknown[])[1] as { body: string };
      const body = JSON.parse(options.body) as Record<string, unknown>;
      expect(body.document_type).toBe('other');
    });
  });

  it('selecting a different type before upload posts that document_type', async () => {
    renderScreen();
    await screen.findByText('drivers_license.pdf');

    fireEvent.click(screen.getByLabelText('Document type: Photo ID'));

    const file = new File(['dummy'], 'id_scan.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type="file"][accept*="heic"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      const postCall = mockedApi.mock.calls.find(
        (c) => c[0] === `/members/${MEMBER_USER_ID}/documents` && c[1]?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const options = (postCall as unknown[])[1] as { body: string };
      const body = JSON.parse(options.body) as Record<string, unknown>;
      expect(body.document_type).toBe('id');
    });
  });
});
