/**
 * Upload API — get S3 presigned URLs and upload files directly from the device.
 *
 * RN adaptation: the web version accepts a `File` object. Here we accept an
 * object describing the local asset (uri, name, type) which maps to how
 * expo-image-picker / expo-document-picker return files — no web File API needed.
 */

import { api } from './client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PresignedUrlResponse {
  upload_url: string;
  s3_key: string;
}

/**
 * A minimal file descriptor produced by expo-image-picker or
 * expo-document-picker. `uri` is the local file:// path on device.
 */
export interface RNFileAsset {
  uri: string;
  name: string;
  type: string;
  /** File size in bytes — forwarded to the presigned-URL endpoint for server-side validation. */
  sizeBytes?: number;
}

// Must stay in sync with backend/app/routers/upload.py — 'credential',
// 'recording', 'document' route to the PHI bucket; everything else (e.g.
// 'profile_photo') is public. 'documentation' is a legacy alias kept while
// callers migrate to 'document'.
export type UploadPurpose = 'credential' | 'profile_photo' | 'documentation' | 'document' | 'recording';

// ─── API functions ────────────────────────────────────────────────────────────

/**
 * Request a pre-signed S3 PUT URL from the API server.
 *
 * @param filename    - Original filename (used for S3 key construction).
 * @param contentType - MIME type of the file.
 * @param purpose     - Categorises the upload for server-side routing.
 * @param sizeBytes   - File size in bytes; validated server-side (max 20 MB).
 */
export async function getPresignedUploadUrl(
  filename: string,
  contentType: string,
  purpose: UploadPurpose = 'credential',
  sizeBytes?: number,
): Promise<PresignedUrlResponse> {
  return api<PresignedUrlResponse>('/upload/presigned-url', {
    method: 'POST',
    body: JSON.stringify({
      filename,
      content_type: contentType,
      purpose,
      // size_bytes is required by the backend schema; default to 1 if unknown
      // to avoid a 422 on older call sites that don't yet pass the value.
      size_bytes: sizeBytes ?? 1,
    }),
  });
}

/**
 * Upload a local device file to S3 using a pre-signed PUT URL.
 *
 * Uses React Native's fetch with a Blob constructed from the file URI —
 * no web File API required.
 *
 * @param asset   - Local file descriptor from expo-image-picker / expo-document-picker.
 * @param purpose - Upload purpose forwarded to getPresignedUploadUrl.
 * @returns The S3 key for the uploaded object.
 */
export async function uploadFile(
  asset: RNFileAsset,
  purpose: UploadPurpose = 'credential',
): Promise<string> {
  const { upload_url, s3_key } = await getPresignedUploadUrl(
    asset.name,
    asset.type,
    purpose,
    asset.sizeBytes,
  );

  // React Native fetch supports PUT with a FormData body containing a blob
  // constructed from the local file URI.
  const formData = new FormData();
  formData.append('file', {
    uri: asset.uri,
    name: asset.name,
    type: asset.type,
  } as unknown as Blob);

  const putResponse = await fetch(upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': asset.type },
    body: formData,
  });

  if (!putResponse.ok) {
    throw new Error(
      `S3 upload failed: HTTP ${putResponse.status} for key "${s3_key}"`,
    );
  }

  return s3_key;
}
