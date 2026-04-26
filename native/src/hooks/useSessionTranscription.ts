/**
 * useSessionTranscription.ts — captures device microphone audio and streams
 * 16-bit PCM 16 kHz mono segments to the backend WebSocket for real-time
 * session transcription.
 *
 * Architecture
 * ────────────
 * expo-audio 1.x does not expose a low-level PCM callback; it records to a
 * device file URI. This hook implements a segment loop:
 *
 *   1. prepareToRecordAsync() → record() → (250 ms elapses) → stop()
 *   2. Read completed file URI as ArrayBuffer via fetch(file://)
 *   3. Send ArrayBuffer as binary WebSocket frame
 *   4. prepareToRecordAsync() again for the next window
 *
 * The loop runs on a setInterval timer. Each iteration is non-blocking: the
 * interval fires the stop, the async read+send+prepare happens in a Promise
 * chain, and the next interval fires the record() call once ready.
 *
 * Web fallback
 * ────────────
 * expo-audio's AudioRecorder does not work in browsers (the underlying native
 * module is absent). Rather than adding a complex MediaRecorder + PCM-decode
 * worker path, we set state to `'error'` with a clear user-facing message.
 * This is intentional: in-person session transcription is a mobile-only
 * feature for v1.
 *
 * HIPAA
 * ─────
 * - Audio bytes and transcript text are NEVER logged.
 * - Only lifecycle events (connected, disconnected, error codes) are logged.
 * - Console statements use __DEV__ guards or are lifecycle-only.
 *
 * Background audio
 * ────────────────
 * setAudioModeAsync is called with `allowsBackgroundRecording: true` on both
 * platforms before recording starts. iOS also requires UIBackgroundModes to
 * include "audio" in the native build — that is set in app.config.ts (see
 * the ios.infoPlist section). On Android no extra manifest entry is needed
 * beyond the RECORD_AUDIO permission already declared.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import type { AudioRecorder } from 'expo-audio';
import AudioModule from 'expo-audio/build/AudioModule';

import { getTokens } from '../api/client';
import {
  AUDIO_STREAM_CONFIG,
  MAX_RECONNECT_ATTEMPTS,
  SEGMENT_DURATION_MS,
  backoffDelayMs,
  parseTranscriptMessage,
  readSegmentAsArrayBuffer,
  sendBinaryFrame,
  sendJsonFrame,
  toSpeakerLabel,
  toSpeakerRole,
} from '../utils/audioStreaming';
import { IOSOutputFormat, AudioQuality } from 'expo-audio/build/RecordingConstants';

// ─── Constants ────────────────────────────────────────────────────────────────

const API_BASE =
  process.env.EXPO_PUBLIC_API_URL ?? 'https://api.joincompasschw.com/api/v1';

/**
 * 16 kHz mono 16-bit linear PCM — the exact format AssemblyAI streaming
 * expects. iOS writes a CAF container; Android writes a raw PCM file.
 * Both are accepted by the backend session config.
 */
const PCM_RECORDING_OPTIONS = {
  extension: '.caf',
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 16_000 * 1 * 16, // 256 000 bps (uncompressed PCM)
  ios: {
    extension: '.caf',
    outputFormat: IOSOutputFormat.LINEARPCM,
    audioQuality: AudioQuality.MAX,
    sampleRate: 16_000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  android: {
    extension: '.pcm',
    outputFormat: 'default' as const,  // raw PCM on Android
    audioEncoder: 'default' as const,
    sampleRate: 16_000,
  },
  web: {
    mimeType: 'audio/webm',
    bitsPerSecond: 256_000,
  },
} as const;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface TranscriptChunk {
  speakerLabel: 'A' | 'B';
  speakerRole: 'chw' | 'member' | 'unknown';
  text: string;
  isFinal: boolean;
  confidence: number;
  startedAtMs: number;
  endedAtMs: number;
}

export type TranscriptionState =
  | 'idle'
  | 'requesting_permission'
  | 'connecting'
  | 'recording'
  | 'reconnecting'
  | 'error'
  | 'stopped';

export interface UseSessionTranscriptionOptions {
  sessionId: string;
  /** Toggle false to trigger graceful shutdown. */
  enabled: boolean;
  onTranscriptChunk?: (chunk: TranscriptChunk) => void;
}

export interface UseSessionTranscriptionResult {
  state: TranscriptionState;
  errorMessage: string | null;
  /** Accumulated transcript chunks for the lifetime of the hook instance. */
  transcripts: TranscriptChunk[];
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

// ─── Internal refs ────────────────────────────────────────────────────────────

interface SessionRefs {
  socket: WebSocket | null;
  recorder: AudioRecorder | null;
  segmentTimer: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  /** Whether a stop-read-send-prepare cycle is currently in flight. */
  cycleInFlight: boolean;
  /** Set true when the hook is torn down to abort any in-flight async work. */
  teardownRequested: boolean;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Captures device microphone audio and streams PCM segments to the backend
 * WebSocket transcript endpoint. Consumes transcript chunks returned by the
 * server and accumulates them for the UI layer.
 *
 * @example
 * ```tsx
 * const { state, transcripts, start, stop } = useSessionTranscription({
 *   sessionId: session.id,
 *   enabled: isSessionActive,
 *   onTranscriptChunk: (chunk) => console.log(chunk.text),
 * });
 * ```
 */
export function useSessionTranscription(
  opts: UseSessionTranscriptionOptions,
): UseSessionTranscriptionResult {
  const { sessionId, enabled, onTranscriptChunk } = opts;

  const [state, setState] = useState<TranscriptionState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptChunk[]>([]);

  // Stable refs — mutated directly so they don't cause re-renders.
  const refs = useRef<SessionRefs>({
    socket: null,
    recorder: null,
    segmentTimer: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    cycleInFlight: false,
    teardownRequested: false,
  });

  // Keep a stable ref to the latest onTranscriptChunk without recreating effects.
  const onChunkRef = useRef(onTranscriptChunk);
  useEffect(() => {
    onChunkRef.current = onTranscriptChunk;
  }, [onTranscriptChunk]);

  // ── Helpers ──────────────────────────────────────────────────────────────

  const transitionError = useCallback((message: string): void => {
    console.warn(`[Transcription] error: ${message}`);
    setState('error');
    setErrorMessage(message);
  }, []);

  const clearTimers = useCallback((): void => {
    const r = refs.current;
    if (r.segmentTimer !== null) {
      clearInterval(r.segmentTimer);
      r.segmentTimer = null;
    }
    if (r.reconnectTimer !== null) {
      clearTimeout(r.reconnectTimer);
      r.reconnectTimer = null;
    }
  }, []);

  const stopRecorder = useCallback(async (): Promise<void> => {
    const recorder = refs.current.recorder;
    if (!recorder) return;
    try {
      if (recorder.isRecording) {
        await recorder.stop();
      }
    } catch (err) {
      // Non-fatal — log only the fact that stop failed, not any audio data.
      console.warn('[Transcription] recorder stop error during teardown');
    }
  }, []);

  const closeSocket = useCallback((sendStopFrame: boolean): void => {
    const socket = refs.current.socket;
    if (!socket) return;
    if (sendStopFrame) {
      sendJsonFrame(socket, { type: 'stop' });
    }
    // Remove listeners before close to avoid spurious onclose triggers.
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.close(1000, 'Graceful stop');
    }
    refs.current.socket = null;
  }, []);

  // ── Segment loop ─────────────────────────────────────────────────────────

  /**
   * One segment cycle: stop the current recording window, read the file,
   * ship it over the socket, and start the next window.
   *
   * Guard: if `cycleInFlight` is true (prior cycle hasn't finished), skip —
   * this prevents re-entrant overlapping cycles on slow I/O.
   */
  const runSegmentCycle = useCallback(async (): Promise<void> => {
    const r = refs.current;
    if (r.teardownRequested || r.cycleInFlight || !r.recorder) return;
    if (!r.recorder.isRecording) return;

    r.cycleInFlight = true;
    try {
      await r.recorder.stop();

      const uri = r.recorder.uri;
      if (uri && r.socket && !r.teardownRequested) {
        try {
          const buffer = await readSegmentAsArrayBuffer(uri);
          sendBinaryFrame(r.socket, buffer);
        } catch {
          // Non-fatal: segment read failure. Log only that it happened.
          console.warn('[Transcription] segment read failed — continuing.');
        }
      }

      if (!r.teardownRequested) {
        await r.recorder.prepareToRecordAsync();
        r.recorder.record();
      }
    } catch {
      // Non-fatal cycle error — log lifecycle event, not audio content.
      console.warn('[Transcription] segment cycle error — continuing.');
    } finally {
      r.cycleInFlight = false;
    }
  }, []);

  // ── WebSocket connect ─────────────────────────────────────────────────────

  const connectWebSocket = useCallback(
    async (isReconnect: boolean): Promise<void> => {
      const r = refs.current;
      if (r.teardownRequested) return;

      const tokens = await getTokens();
      if (!tokens?.access) {
        transitionError('Session expired. Please log in again.');
        return;
      }

      const wsBase = API_BASE.replace(/^http/, 'ws');
      const url = `${wsBase}/sessions/${sessionId}/transcript/stream?token=${tokens.access}`;

      if (!isReconnect) {
        setState('connecting');
      }

      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      r.socket = socket;

      socket.onopen = (): void => {
        if (r.teardownRequested) {
          socket.close(1000, 'Teardown during connect');
          return;
        }
        console.log('[Transcription] WebSocket connected');
        r.reconnectAttempt = 0;
        setState('recording');

        // Send session descriptor so the backend knows encoding.
        sendJsonFrame(socket, {
          type: 'session_config',
          audio: AUDIO_STREAM_CONFIG,
          session_id: sessionId,
        });
      };

      socket.onmessage = (event: MessageEvent): void => {
        if (r.teardownRequested) return;

        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data as string);
        } catch {
          return; // Binary echo or unparseable frame — ignore.
        }

        const msg = parseTranscriptMessage(parsed);
        if (!msg) return;

        const chunk: TranscriptChunk = {
          speakerLabel: toSpeakerLabel(msg.speaker_label),
          speakerRole: toSpeakerRole(msg.speaker_role),
          text: msg.text,
          isFinal: msg.is_final,
          confidence: msg.confidence,
          startedAtMs: msg.started_at_ms,
          endedAtMs: msg.ended_at_ms,
        };

        setTranscripts((prev) => [...prev, chunk]);
        onChunkRef.current?.(chunk);
      };

      socket.onerror = (): void => {
        // Error event carries no useful detail beyond the fact that it occurred.
        console.warn('[Transcription] WebSocket error event');
      };

      socket.onclose = (event: CloseEvent): void => {
        if (r.teardownRequested) return;
        // code 1000 = normal closure (our own stop())
        if (event.code === 1000) return;

        console.log(`[Transcription] WebSocket closed (code ${event.code}) — attempting reconnect`);
        scheduleReconnect();
      };
    },
    [sessionId, transitionError],
  );

  // ── Reconnect ─────────────────────────────────────────────────────────────

  const scheduleReconnect = useCallback((): void => {
    const r = refs.current;
    if (r.teardownRequested) return;
    if (r.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      transitionError(
        `Transcription connection lost after ${MAX_RECONNECT_ATTEMPTS} attempts. ` +
          'Please stop and restart the session.',
      );
      return;
    }

    setState('reconnecting');
    const delay = backoffDelayMs(r.reconnectAttempt);
    r.reconnectAttempt += 1;

    console.log(
      `[Transcription] reconnect attempt ${r.reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`,
    );

    r.reconnectTimer = setTimeout(() => {
      if (!r.teardownRequested) {
        void connectWebSocket(true);
      }
    }, delay);
  }, [connectWebSocket, transitionError]);

  // ── start() ───────────────────────────────────────────────────────────────

  const start = useCallback(async (): Promise<void> => {
    const r = refs.current;

    // Web is not supported for this feature.
    if (Platform.OS === 'web') {
      transitionError('In-person transcription requires the mobile app.');
      return;
    }

    if (state === 'recording' || state === 'connecting') return;

    r.teardownRequested = false;
    r.reconnectAttempt = 0;

    // ── 1. Mic permission ───────────────────────────────────────────────────
    setState('requesting_permission');
    let granted = false;
    try {
      const result = await requestRecordingPermissionsAsync();
      granted = result.granted;
    } catch {
      transitionError('Could not check microphone permission.');
      return;
    }

    if (!granted) {
      transitionError(
        'Microphone permission denied. Enable it in Settings to use session transcription.',
      );
      return;
    }

    // ── 2. Audio session mode ───────────────────────────────────────────────
    try {
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        interruptionMode: 'duckOthers',
        allowsBackgroundRecording: true,
      });
    } catch {
      // Non-fatal — some platforms ignore unsupported mode keys.
      console.warn('[Transcription] setAudioModeAsync partial failure — continuing.');
    }

    // ── 3. WebSocket ────────────────────────────────────────────────────────
    await connectWebSocket(false);

    // ── 4. Recorder setup ───────────────────────────────────────────────────
    try {
      const recorder = new AudioModule.AudioRecorder(PCM_RECORDING_OPTIONS);
      r.recorder = recorder;
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch (err) {
      closeSocket(false);
      transitionError('Failed to start microphone recorder. Please try again.');
      return;
    }

    // ── 5. Segment loop ─────────────────────────────────────────────────────
    r.segmentTimer = setInterval(() => {
      void runSegmentCycle();
    }, SEGMENT_DURATION_MS);
  }, [state, connectWebSocket, closeSocket, runSegmentCycle, transitionError]);

  // ── stop() ────────────────────────────────────────────────────────────────

  const stop = useCallback(async (): Promise<void> => {
    const r = refs.current;
    r.teardownRequested = true;

    clearTimers();
    await stopRecorder();
    closeSocket(true);

    setState('stopped');
    console.log('[Transcription] stopped');
  }, [clearTimers, stopRecorder, closeSocket]);

  // ── enabled watcher ───────────────────────────────────────────────────────

  useEffect(() => {
    if (!enabled && (state === 'recording' || state === 'connecting' || state === 'reconnecting')) {
      void stop();
    }
  }, [enabled, state, stop]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      refs.current.teardownRequested = true;
      clearTimers();
      // Fire-and-forget: we can't await in a cleanup function.
      void stopRecorder();
      closeSocket(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, errorMessage, transcripts, start, stop };
}
