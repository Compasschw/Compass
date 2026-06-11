/**
 * useFileUpload — shared hook for presigned-URL → S3 → metadata record uploads.
 *
 * Supports two purposes at the moment:
 *   - 'member_document' (documents stored in compass-prod-member-documents PHI bucket)
 *
 * Platform behaviour:
 *   - web:    <input type="file"> driven via a ref you supply (or inline trigger).
 *             Returns a pick() function that resolves to a picked file object.
 *   - native: expo-document-picker with getDocumentAsync.
 *
 * Upload flow:
 *   1. Pick a file (validate size ≤ 10 MB client-side + MIME type).
 *   2. POST /upload/presigned-url with { purpose, filename, content_type, size_bytes }.
 *   3. PUT the file blob directly to the returned upload_url (bypasses our API).
 *   4. POST /members/{memberId}/documents to record the metadata.
 *   5. Invalidate the member documents list query.
 *   6. Return success / error state.
 *
 * Client-side size cap is 10 MB (conservative vs the 20 MB server cap) to
 * reduce upload failures on slower mobile connections.
 */

import { Platform } from 'react-native';
import { useState, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { api, getTokens } from '../api/client';
import { transformKeys } from '../utils/caseTransform';

// ─── Types ────────────────────────────────────────────────────────────────────

export type FileUploadPurpose = 'member_document';

export type DocumentType = 'id' | 'income' | 'address' | 'medical' | 'other';

export interface PickedFile {
  uri: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Blob available on web; on native we fetch() the uri to produce one. */
  blob?: Blob;
}

export interface PresignedUrlPayload {
  filename: string;
  content_type: string;
  purpose: FileUploadPurpose;
  size_bytes: number;
}

export interface PresignedUrlResponse {
  upload_url: string;
  s3_key: string;
}

export interface MemberDocumentRecord {
  id: string;
  memberId: string;
  documentType: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedAt: string;
  deletedAt: string | null;
}

export interface MemberDocumentList {
  items: MemberDocumentRecord[];
  total: number;
  page: number;
  pageSize: number;
}

export interface UseFileUploadOptions {
  /** Member UUID for metadata record creation + query invalidation. */
  memberId: string;
  /** Document category recorded on the MemberDocument row. */
  documentType: DocumentType;
  /**
   * Called after a fully successful upload (presigned PUT + metadata POST).
   * Receives the newly created MemberDocumentRecord.
   */
  onSuccess?: (doc: MemberDocumentRecord) => void;
  /** Called when any step in the pipeline fails. */
  onError?: (error: Error) => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Client-side size cap: 10 MB (conservative; server cap is 20 MB). */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
]);

const ALLOWED_EXTENSIONS = [
  'application/pdf',
  'image/*',
];

// ─── Query key for member documents ───────────────────────────────────────────

export const memberDocumentsQueryKey = (memberId: string) =>
  ['member', 'documents', memberId] as const;

// ─── Platform file picker helpers ─────────────────────────────────────────────

/**
 * Pick a document on native using expo-document-picker.
 * Returns null when the user cancels or an unsupported file is chosen.
 */
async function pickDocumentNative(): Promise<PickedFile | null> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const DocumentPicker = require('expo-document-picker') as typeof import('expo-document-picker');

  const result = await DocumentPicker.getDocumentAsync({
    type: ALLOWED_EXTENSIONS,
    copyToCacheDirectory: true,
    multiple: false,
  });

  if (result.canceled || result.assets.length === 0) return null;

  const asset = result.assets[0];
  if (!asset) return null;

  const mimeType = asset.mimeType ?? 'application/octet-stream';
  const filename = asset.name ?? `document-${Date.now()}`;
  const sizeBytes = asset.size ?? 0;

  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new Error(
      `Unsupported file type "${mimeType}". Please upload a PDF, JPEG, PNG, or HEIC file.`,
    );
  }
  if (sizeBytes > MAX_FILE_BYTES) {
    throw new Error(
      `File is too large (${(sizeBytes / (1024 * 1024)).toFixed(1)} MB). Maximum size is 10 MB.`,
    );
  }

  return { uri: asset.uri, filename, mimeType, sizeBytes };
}

/**
 * Fetch a native URI as a Blob for the presigned PUT.
 */
async function uriBlobNative(uri: string, mimeType: string): Promise<Blob> {
  const response = await fetch(uri);
  if (!response.ok) {
    throw new Error(`Failed to read local file (HTTP ${response.status})`);
  }
  const blob = await response.blob();
  return new Blob([blob], { type: mimeType });
}

// ─── Upload pipeline ──────────────────────────────────────────────────────────

/**
 * Execute the full upload pipeline:
 *   1. POST /upload/presigned-url
 *   2. PUT blob → S3 presigned URL
 *   3. POST /members/{memberId}/documents
 *
 * Returns the newly created MemberDocumentRecord.
 */
async function runUploadPipeline(
  purpose: FileUploadPurpose,
  memberId: string,
  documentType: DocumentType,
  file: PickedFile,
  blob: Blob,
): Promise<MemberDocumentRecord> {
  // Step 1 — get presigned upload URL.
  const presignedPayload: PresignedUrlPayload = {
    filename: file.filename,
    content_type: file.mimeType,
    purpose,
    size_bytes: file.sizeBytes,
  };
  const presigned = await api<PresignedUrlResponse>('/upload/presigned-url', {
    method: 'POST',
    body: JSON.stringify(presignedPayload),
  });

  // Step 2 — PUT directly to S3.
  const tokens = await getTokens();
  const putResponse = await fetch(presigned.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': file.mimeType },
    body: blob,
  });
  if (!putResponse.ok) {
    throw new Error(
      `Failed to upload file to S3 (HTTP ${putResponse.status}). Please try again.`,
    );
  }

  // Derive s3_url from the presigned upload URL (strip query params).
  const uploadUrlNoQuery = presigned.upload_url.split('?')[0] ?? presigned.upload_url;

  // Step 3 — record metadata.
  const metadataPayload = {
    document_type: documentType,
    filename: file.filename,
    s3_url: uploadUrlNoQuery,
    s3_key: presigned.s3_key,
    content_type: file.mimeType,
    size_bytes: file.sizeBytes,
  };
  const raw = await api<unknown>(`/members/${memberId}/documents`, {
    method: 'POST',
    body: JSON.stringify(metadataPayload),
  });
  return transformKeys<MemberDocumentRecord>(raw);
}

// ─── Main hook ────────────────────────────────────────────────────────────────

export interface UseFileUploadReturn {
  /** True while any step of the upload pipeline is running. */
  isUploading: boolean;
  /** Error from the most recent upload attempt. Cleared on next upload start. */
  uploadError: Error | null;
  /**
   * Trigger the full upload flow.
   *
   * On web: pass a File object from an <input type="file"> onChange handler.
   * On native: pass null — the hook will invoke expo-document-picker internally.
   *
   * Returns the new MemberDocumentRecord on success, or null on cancellation.
   */
  upload: (webFile?: File | null) => Promise<MemberDocumentRecord | null>;
}

/**
 * useFileUpload — drives presigned-URL → S3 → metadata record upload flow.
 *
 * Usage:
 *   const { upload, isUploading, uploadError } = useFileUpload('member_document', {
 *     memberId,
 *     documentType: 'id',
 *     onSuccess: (doc) => console.log('uploaded', doc.id),
 *   });
 *
 *   // web: <input onChange={e => upload(e.target.files?.[0])} />
 *   // native: <Pressable onPress={() => upload()} />
 */
export function useFileUpload(
  purpose: FileUploadPurpose,
  options: UseFileUploadOptions,
): UseFileUploadReturn {
  const { memberId, documentType, onSuccess, onError } = options;
  const queryClient = useQueryClient();
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<Error | null>(null);

  const upload = useCallback(
    async (webFile?: File | null): Promise<MemberDocumentRecord | null> => {
      setUploadError(null);
      setIsUploading(true);

      try {
        let pickedFile: PickedFile;
        let blob: Blob;

        if (Platform.OS === 'web') {
          if (!webFile) {
            // Nothing selected (user cancelled).
            return null;
          }

          if (!ALLOWED_MIME_TYPES.has(webFile.type)) {
            throw new Error(
              `Unsupported file type "${webFile.type}". Please upload a PDF, JPEG, PNG, or HEIC file.`,
            );
          }
          if (webFile.size > MAX_FILE_BYTES) {
            throw new Error(
              `File is too large (${(webFile.size / (1024 * 1024)).toFixed(1)} MB). Maximum size is 10 MB.`,
            );
          }

          blob = webFile;
          pickedFile = {
            uri: URL.createObjectURL(webFile),
            filename: webFile.name,
            mimeType: webFile.type,
            sizeBytes: webFile.size,
            blob,
          };
        } else {
          // Native — use expo-document-picker.
          const picked = await pickDocumentNative();
          if (!picked) {
            return null; // User cancelled.
          }
          blob = await uriBlobNative(picked.uri, picked.mimeType);
          pickedFile = { ...picked, blob };
        }

        const doc = await runUploadPipeline(
          purpose,
          memberId,
          documentType,
          pickedFile,
          blob,
        );

        // Invalidate the documents list so the screen re-renders with the new doc.
        await queryClient.invalidateQueries({
          queryKey: memberDocumentsQueryKey(memberId),
        });

        onSuccess?.(doc);
        return doc;
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        setUploadError(error);
        onError?.(error);
        return null;
      } finally {
        setIsUploading(false);
      }
    },
    [purpose, memberId, documentType, queryClient, onSuccess, onError],
  );

  return { isUploading, uploadError, upload };
}
