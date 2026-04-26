/**
 * audioStreaming.ts — helpers for reading expo-audio recorder output files
 * as raw 16-bit PCM binary frames and enqueuing them onto a WebSocket.
 *
 * Architecture note
 * -----------------
 * expo-audio 1.x does not expose a streaming PCM callback. The `AudioRecorder`
 * writes audio to a device file URI (CAF on iOS, MPEG-4 on Android). To
 * approximate streaming we record in fixed 250 ms windows, stop the recorder,
 * read the completed segment file via `fetch()` (React Native allows fetching
 * file:// URIs), and forward the raw bytes as a binary WebSocket frame.
 *
 * For in-session transcription the backend is expected to receive PCM-encoded
 * audio (16 kHz, mono, 16-bit little-endian). iOS CAF with LINEARPCM settings
 * stores exactly that; Android raw-PCM output does the same. The containers
 * differ, but AssemblyAI's streaming endpoint accepts both when the Content-Type
 * / session config is correct. If the backend later requires headerless PCM,
 * strip the container header (44-byte WAV / 8-byte CAF) inside readSegmentAsArrayBuffer.
 *
 * HIPAA note: this module never logs audio byte contents or durations.
 */

import { Platform } from 'react-native';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Duration (ms) of each recording segment sent to the backend.
 * Shorter = lower latency; longer = fewer round-trips per minute.
 * 250 ms is a reasonable balance for real-time transcription.
 */
export const SEGMENT_DURATION_MS = 250;

/**
 * Audio configuration for the WebSocket session descriptor
 * (sent in the first handshake frame so the backend knows the encoding).
 */
export interface AudioStreamConfig {
  readonly sampleRate: 16000;
  readonly channels: 1;
  readonly encoding: 'pcm_s16le';
}

export const AUDIO_STREAM_CONFIG: AudioStreamConfig = {
  sampleRate: 16000,
  channels: 1,
  encoding: 'pcm_s16le',
};

// ─── File → ArrayBuffer ───────────────────────────────────────────────────────

/**
 * Read a local audio file URI produced by expo-audio's AudioRecorder and
 * return its binary contents as an `ArrayBuffer`.
 *
 * React Native's `fetch` implementation supports `file://` URIs and can
 * return `arrayBuffer()`, so this avoids adding `expo-file-system` as a dep.
 *
 * @throws {Error} when the URI is empty, the fetch fails, or the response body
 *   is empty (a zero-byte write can happen if the recorder stopped abnormally).
 */
export async function readSegmentAsArrayBuffer(fileUri: string): Promise<ArrayBuffer> {
  if (!fileUri) {
    throw new Error('audioStreaming: fileUri is empty — recorder may not have flushed.');
  }

  const response = await fetch(fileUri);
  if (!response.ok) {
    throw new Error(
      `audioStreaming: fetch(${Platform.OS}) returned ${response.status} for segment file.`,
    );
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new Error('audioStreaming: segment file is empty (0 bytes).');
  }

  return buffer;
}

// ─── WebSocket send helpers ───────────────────────────────────────────────────

/**
 * Send an `ArrayBuffer` audio segment as a binary frame on an open WebSocket.
 * No-ops silently if the socket is not in OPEN state — the caller's reconnect
 * loop handles buffering and replay when reconnected.
 *
 * @returns true when the frame was sent, false when the socket was not ready.
 */
export function sendBinaryFrame(socket: WebSocket, buffer: ArrayBuffer): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  socket.send(buffer);
  return true;
}

/**
 * Send a JSON control message (e.g. `{"type":"stop"}`) as a UTF-8 text frame.
 * No-ops silently if the socket is not OPEN.
 */
export function sendJsonFrame(socket: WebSocket, payload: Record<string, unknown>): boolean {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  socket.send(JSON.stringify(payload));
  return true;
}

// ─── Backoff calculator ───────────────────────────────────────────────────────

/**
 * Exponential backoff delay in milliseconds for WebSocket reconnect attempts.
 *
 * Attempt 0 → 1 000 ms
 * Attempt 1 → 2 000 ms
 * Attempt 2 → 4 000 ms
 * Attempt 3 → 8 000 ms
 * Attempt ≥ 4 → capped at 8 000 ms (MAX_RECONNECT_ATTEMPTS enforced by caller)
 */
export function backoffDelayMs(attempt: number): number {
  return Math.min(1_000 * Math.pow(2, attempt), 8_000);
}

export const MAX_RECONNECT_ATTEMPTS = 4;

// ─── Transcript chunk validation ─────────────────────────────────────────────

/**
 * Shape of a raw transcript message arriving over the WebSocket.
 * Mirrors the server's wire format so callers can validate before mapping.
 */
export interface RawTranscriptMessage {
  speaker_label: string;
  speaker_role: string;
  text: string;
  is_final: boolean;
  confidence: number;
  started_at_ms: number;
  ended_at_ms: number;
}

type SpeakerLabel = 'A' | 'B';
type SpeakerRole = 'chw' | 'member' | 'unknown';

/**
 * Validate and narrow a raw JSON object to `RawTranscriptMessage`.
 * Returns `null` for malformed payloads so the caller can discard safely.
 */
export function parseTranscriptMessage(raw: unknown): RawTranscriptMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const obj = raw as Record<string, unknown>;

  if (
    typeof obj['speaker_label'] !== 'string' ||
    typeof obj['speaker_role'] !== 'string' ||
    typeof obj['text'] !== 'string' ||
    typeof obj['is_final'] !== 'boolean' ||
    typeof obj['confidence'] !== 'number' ||
    typeof obj['started_at_ms'] !== 'number' ||
    typeof obj['ended_at_ms'] !== 'number'
  ) {
    return null;
  }

  return obj as unknown as RawTranscriptMessage;
}

/**
 * Narrow a raw string to the `SpeakerLabel` union.
 * Defaults to `'A'` for any unexpected value.
 */
export function toSpeakerLabel(raw: string): SpeakerLabel {
  return raw === 'B' ? 'B' : 'A';
}

/**
 * Narrow a raw string to the `SpeakerRole` union.
 * Defaults to `'unknown'` for any unexpected value.
 */
export function toSpeakerRole(raw: string): SpeakerRole {
  if (raw === 'chw' || raw === 'member') return raw;
  return 'unknown';
}
