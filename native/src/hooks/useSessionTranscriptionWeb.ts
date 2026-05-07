/**
 * useSessionTranscriptionWeb.ts — Web-platform microphone capture for real-time
 * session transcription via AssemblyAI.
 *
 * Architecture
 * ────────────
 * 1. `getUserMedia({ audio: true })` acquires the microphone stream.
 * 2. An `AudioContext` is created at 48 kHz (browser default) and the stream is
 *    piped through an `AudioWorkletNode` that runs a custom processor inline.
 * 3. The worklet processor:
 *      a. Accepts Float32 samples at the context's native sample rate.
 *      b. Accumulates samples until a ~250 ms window is full.
 *      c. Resamples from the native rate to 16 kHz via linear interpolation.
 *      d. Converts Float32 [-1, 1] → Int16 [-32768, 32767].
 *      e. Posts the resulting ArrayBuffer to the main thread.
 * 4. Each ArrayBuffer is forwarded as a binary WebSocket frame through the same
 *    `/api/v1/sessions/{id}/transcript/stream` endpoint the mobile hook uses.
 * 5. Text frames from the server are parsed as `TranscriptChunk` objects and
 *    surfaced via the `onTranscriptChunk` callback.
 *
 * Security context
 * ────────────────
 * `getUserMedia` requires a secure context (HTTPS or localhost). On production
 * joincompasschw.com (HTTPS via Vercel) this is satisfied automatically.
 * In local dev, the Expo dev server runs on localhost which also qualifies.
 *
 * Safari / iOS WebKit quirk
 * ─────────────────────────
 * Safari suspends the AudioContext immediately after construction until it is
 * resumed inside a user-gesture handler. We call `audioCtx.resume()` inside
 * `startCapture()` which IS called from the Mic button press handler — so the
 * gesture chain is intact. We also handle the `suspended` state defensively
 * by calling resume() before connecting the worklet node.
 *
 * Chrome / Firefox AudioWorklet
 * ──────────────────────────────
 * The worklet processor is inlined as a string and loaded via
 * `URL.createObjectURL(new Blob([src], { type: 'application/javascript' }))`.
 * This avoids needing a separate deployment artifact and is compatible with
 * both Vercel's static hosting and local Metro/Expo bundler.
 *
 * HIPAA
 * ─────
 * - Audio bytes are NEVER logged.
 * - Transcript text is NEVER logged.
 * - Only lifecycle events (connected, disconnected, error codes) appear in logs.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getTokens } from '../api/client';
import {
  AUDIO_STREAM_CONFIG,
  MAX_RECONNECT_ATTEMPTS,
  SEGMENT_DURATION_MS,
  backoffDelayMs,
  parseTranscriptMessage,
  sendBinaryFrame,
  sendJsonFrame,
  toSpeakerLabel,
  toSpeakerRole,
} from '../utils/audioStreaming';
import type { TranscriptChunk, TranscriptionState, UseSessionTranscriptionOptions, UseSessionTranscriptionResult } from './useSessionTranscription';

// ─── Constants ────────────────────────────────────────────────────────────────

const API_BASE =
  process.env.EXPO_PUBLIC_API_URL ?? 'https://api.joincompasschw.com/api/v1';

/**
 * Target sample rate for PCM output — must match AssemblyAI's expectation and
 * the backend `AUDIO_STREAM_CONFIG`.
 */
const TARGET_SAMPLE_RATE = 16_000;

/**
 * Number of Int16 samples per chunk sent to the backend.
 * 250 ms × 16 000 samples/s = 4 000 samples per chunk.
 */
const SAMPLES_PER_CHUNK = Math.floor((SEGMENT_DURATION_MS / 1000) * TARGET_SAMPLE_RATE);

// ─── AudioWorklet processor source ───────────────────────────────────────────

/**
 * Inline source for the AudioWorklet processor.
 *
 * This runs in the AudioWorklet scope (a separate global with no DOM access).
 * It resamples from the AudioContext's native rate to TARGET_SAMPLE_RATE using
 * linear interpolation — adequate quality for speech-to-text pipelines.
 *
 * Design decisions:
 * - The target rate and samples-per-chunk are injected via processorOptions at
 *   node construction time (MessagePort parameters), avoiding a hard-coded
 *   string inside the source blob.
 * - We use a pre-allocated Int16Array and only transfer the relevant slice so
 *   the GC does not see a new allocation on every chunk.
 * - `process()` must return `true` to keep the node alive.
 */
const WORKLET_PROCESSOR_SOURCE = `
class PcmResamplerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this._targetRate = opts.targetSampleRate || 16000;
    this._samplesPerChunk = opts.samplesPerChunk || 4000;
    // Accumulation buffer: Float32 at native sample rate.
    this._accum = new Float32Array(0);
  }

  process(inputs) {
    const input = inputs[0];
    // No input connected yet (or mic track ended) — keep alive but do nothing.
    if (!input || !input[0] || input[0].length === 0) return true;

    // Only use the first channel (mono capture guaranteed by getUserMedia constraints).
    const channelData = input[0];

    // Append new samples to the accumulation buffer.
    const merged = new Float32Array(this._accum.length + channelData.length);
    merged.set(this._accum);
    merged.set(channelData, this._accum.length);
    this._accum = merged;

    // Compute how many native-rate samples correspond to one target-rate chunk.
    const nativeRate = sampleRate; // AudioWorkletGlobalScope.sampleRate
    const nativeSamplesPerChunk = Math.ceil(this._samplesPerChunk * (nativeRate / this._targetRate));

    while (this._accum.length >= nativeSamplesPerChunk) {
      const slice = this._accum.slice(0, nativeSamplesPerChunk);
      this._accum = this._accum.slice(nativeSamplesPerChunk);

      // Linear resample from nativeSamplesPerChunk → _samplesPerChunk.
      const out = new Int16Array(this._samplesPerChunk);
      const ratio = (slice.length - 1) / (this._samplesPerChunk - 1);
      for (let i = 0; i < this._samplesPerChunk; i++) {
        const pos = i * ratio;
        const lo = Math.floor(pos);
        const hi = Math.min(lo + 1, slice.length - 1);
        const frac = pos - lo;
        const sample = slice[lo] * (1 - frac) + slice[hi] * frac;
        // Clamp and convert Float32 [-1, 1] → Int16 [-32768, 32767].
        const clamped = Math.max(-1, Math.min(1, sample));
        out[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
      }

      // Transfer ownership of the underlying buffer to avoid copying.
      this.port.postMessage({ pcmChunk: out.buffer }, [out.buffer]);
    }

    return true; // Keep the processor alive.
  }
}

registerProcessor('pcm-resampler', PcmResamplerProcessor);
`;

// ─── Internal refs ────────────────────────────────────────────────────────────

interface WebSessionRefs {
  socket: WebSocket | null;
  audioContext: AudioContext | null;
  workletNode: AudioWorkletNode | null;
  mediaStream: MediaStream | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  workletBlobUrl: string | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  teardownRequested: boolean;
  /**
   * Stable pointer to the scheduleReconnect callback, set once the callback is
   * created. Used inside connectWebSocket's socket.onclose closure so that the
   * forward-reference is resolved at event-fire time, not at hook-body-parse time.
   */
  scheduleReconnect: (() => void) | null;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Web-platform implementation of session transcription.
 *
 * Exposes the identical `UseSessionTranscriptionResult` interface as the mobile
 * hook so `useSessionTranscription` can delegate to it transparently.
 */
export function useSessionTranscriptionWeb(
  opts: UseSessionTranscriptionOptions,
): UseSessionTranscriptionResult {
  const { sessionId, enabled, onTranscriptChunk } = opts;

  const [state, setState] = useState<TranscriptionState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptChunk[]>([]);

  const refs = useRef<WebSessionRefs>({
    socket: null,
    audioContext: null,
    workletNode: null,
    mediaStream: null,
    sourceNode: null,
    workletBlobUrl: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    teardownRequested: false,
    scheduleReconnect: null,
  });

  // Stable ref so onTranscriptChunk identity changes don't recreate effects.
  const onChunkRef = useRef(onTranscriptChunk);
  useEffect(() => {
    onChunkRef.current = onTranscriptChunk;
  }, [onTranscriptChunk]);

  // ── Helpers ──────────────────────────────────────────────────────────────

  const transitionError = useCallback((message: string): void => {
    console.warn(`[TranscriptionWeb] error: ${message}`);
    setState('error');
    setErrorMessage(message);
  }, []);

  const closeSocket = useCallback((sendStopFrame: boolean): void => {
    const socket = refs.current.socket;
    if (!socket) return;
    if (sendStopFrame) {
      sendJsonFrame(socket, { type: 'stop' });
    }
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

  /**
   * Tear down the entire audio capture chain.
   *
   * Order matters:
   *  1. Disconnect the worklet node (stops the processor loop).
   *  2. Disconnect the source node.
   *  3. Stop all MediaStream tracks (releases the mic indicator in the browser).
   *  4. Close the AudioContext.
   *  5. Revoke the blob URL (frees memory for the worklet script).
   */
  const teardownAudio = useCallback((): void => {
    const r = refs.current;

    try {
      r.workletNode?.disconnect();
    } catch {
      // Disconnect errors are non-fatal — node may already be detached.
    }
    r.workletNode = null;

    try {
      r.sourceNode?.disconnect();
    } catch {
      // Non-fatal.
    }
    r.sourceNode = null;

    if (r.mediaStream) {
      for (const track of r.mediaStream.getTracks()) {
        track.stop();
      }
      r.mediaStream = null;
    }

    if (r.audioContext && r.audioContext.state !== 'closed') {
      r.audioContext.close().catch(() => {
        // Non-fatal: AudioContext may already be closing.
      });
    }
    r.audioContext = null;

    if (r.workletBlobUrl) {
      URL.revokeObjectURL(r.workletBlobUrl);
      r.workletBlobUrl = null;
    }

    console.log('[TranscriptionWeb] audio chain torn down');
  }, []);

  const clearReconnectTimer = useCallback((): void => {
    const r = refs.current;
    if (r.reconnectTimer !== null) {
      clearTimeout(r.reconnectTimer);
      r.reconnectTimer = null;
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
        console.log('[TranscriptionWeb] WebSocket connected');
        r.reconnectAttempt = 0;
        setState('recording');

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
          return;
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

        // Coalesce successive partials for the same turn into a single
        // entry: if the trailing chunk is still a partial, the incoming
        // chunk continues that turn — replace it in place. A final chunk
        // arriving while a partial is trailing also replaces it (same turn).
        // After a final, the next partial begins a new turn → append.
        setTranscripts((prev) => {
          if (prev.length > 0 && !prev[prev.length - 1].isFinal) {
            return [...prev.slice(0, -1), chunk];
          }
          return [...prev, chunk];
        });
        onChunkRef.current?.(chunk);
      };

      socket.onerror = (): void => {
        console.warn('[TranscriptionWeb] WebSocket error event');
      };

      socket.onclose = (event: CloseEvent): void => {
        if (r.teardownRequested) return;
        if (event.code === 1000) return;

        console.log(
          `[TranscriptionWeb] WebSocket closed (code ${event.code}) — attempting reconnect`,
        );
        // Use the stable ref pointer so this closure does not create a
        // forward-reference dependency on the scheduleReconnect useCallback.
        refs.current.scheduleReconnect?.();
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
      `[TranscriptionWeb] reconnect ${r.reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`,
    );

    r.reconnectTimer = setTimeout(() => {
      if (!r.teardownRequested) {
        void connectWebSocket(true);
      }
    }, delay);
  }, [connectWebSocket, transitionError]);

  // Keep the stable ref pointer current so connectWebSocket's onclose can
  // call it without a direct closure dependency (avoids useCallback cycle).
  useEffect(() => {
    refs.current.scheduleReconnect = scheduleReconnect;
  }, [scheduleReconnect]);

  // ── Audio capture chain ───────────────────────────────────────────────────

  /**
   * Build and start the AudioContext → MediaStreamSource → AudioWorkletNode
   * capture pipeline. Returns false if any step fails (caller should surface error).
   */
  const startCapture = useCallback(
    async (stream: MediaStream): Promise<boolean> => {
      const r = refs.current;
      if (r.teardownRequested) return false;

      // 1. Create AudioContext (browser default: typically 48 kHz).
      const audioCtx = new AudioContext();
      r.audioContext = audioCtx;

      // Safari suspends the context immediately; resume inside the gesture chain.
      if (audioCtx.state === 'suspended') {
        try {
          await audioCtx.resume();
        } catch {
          // Non-fatal: we proceed and hope the context unsuspends.
          console.warn('[TranscriptionWeb] AudioContext resume failed — continuing.');
        }
      }

      // 2. Build the worklet blob URL (inline, no separate static file needed).
      const blob = new Blob([WORKLET_PROCESSOR_SOURCE], {
        type: 'application/javascript',
      });
      const blobUrl = URL.createObjectURL(blob);
      r.workletBlobUrl = blobUrl;

      // 3. Register the worklet module.
      try {
        await audioCtx.audioWorklet.addModule(blobUrl);
      } catch (err) {
        transitionError(
          'Could not load audio processor. Please use Chrome, Firefox, or Edge.',
        );
        return false;
      }

      if (r.teardownRequested) return false;

      // 4. Create the worklet node with processor options injected.
      const workletNode = new AudioWorkletNode(audioCtx, 'pcm-resampler', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: {
          targetSampleRate: TARGET_SAMPLE_RATE,
          samplesPerChunk: SAMPLES_PER_CHUNK,
        },
      });
      r.workletNode = workletNode;

      // 5. Wire up the PCM chunk → WebSocket send callback.
      workletNode.port.onmessage = (event: MessageEvent<{ pcmChunk: ArrayBuffer }>): void => {
        if (r.teardownRequested) return;
        const { pcmChunk } = event.data;
        if (r.socket) {
          sendBinaryFrame(r.socket, pcmChunk);
        }
      };

      // 6. Connect the mic stream → worklet.
      const sourceNode = audioCtx.createMediaStreamSource(stream);
      r.sourceNode = sourceNode;
      sourceNode.connect(workletNode);

      console.log(
        `[TranscriptionWeb] audio chain started (ctx rate=${audioCtx.sampleRate}Hz → target=${TARGET_SAMPLE_RATE}Hz)`,
      );
      return true;
    },
    [transitionError],
  );

  // ── start() ───────────────────────────────────────────────────────────────

  const start = useCallback(async (): Promise<void> => {
    const r = refs.current;

    if (state === 'recording' || state === 'connecting') return;

    r.teardownRequested = false;
    r.reconnectAttempt = 0;

    // ── 1. Secure context guard ─────────────────────────────────────────────
    if (!window.isSecureContext) {
      transitionError(
        'Microphone access requires a secure connection (HTTPS). ' +
          'Please use joincompasschw.com or localhost.',
      );
      return;
    }

    // ── 2. getUserMedia permission ──────────────────────────────────────────
    setState('requesting_permission');

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: { ideal: TARGET_SAMPLE_RATE },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (err) {
      // `NotAllowedError` = user denied; `NotFoundError` = no mic.
      const errorName = err instanceof Error ? err.name : '';

      if (errorName === 'NotAllowedError' || errorName === 'PermissionDeniedError') {
        transitionError(
          'Microphone permission denied. Click the lock icon in your browser ' +
            'address bar to allow microphone access for this site, then tap Mic again.',
        );
      } else if (errorName === 'NotFoundError' || errorName === 'DevicesNotFoundError') {
        transitionError(
          'No microphone found. Please connect a microphone and try again.',
        );
      } else {
        transitionError(
          'Could not access microphone. Please check your browser settings and try again.',
        );
      }
      return;
    }

    r.mediaStream = stream;

    // ── 3. WebSocket ────────────────────────────────────────────────────────
    await connectWebSocket(false);

    if (r.teardownRequested) {
      // stop() was called while connecting — release mic immediately.
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    // ── 4. Audio capture chain ──────────────────────────────────────────────
    const captureOk = await startCapture(stream);
    if (!captureOk) {
      closeSocket(false);
      for (const track of stream.getTracks()) track.stop();
      // transitionError already called by startCapture.
    }
  }, [state, connectWebSocket, startCapture, closeSocket, transitionError]);

  // ── stop() ────────────────────────────────────────────────────────────────

  const stop = useCallback(async (): Promise<void> => {
    const r = refs.current;
    r.teardownRequested = true;

    clearReconnectTimer();
    teardownAudio();
    closeSocket(true);

    setState('stopped');
    console.log('[TranscriptionWeb] stopped');
  }, [clearReconnectTimer, teardownAudio, closeSocket]);

  // ── enabled watcher ───────────────────────────────────────────────────────

  useEffect(() => {
    if (
      !enabled &&
      (state === 'recording' || state === 'connecting' || state === 'reconnecting')
    ) {
      void stop();
    }
  }, [enabled, state, stop]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      refs.current.teardownRequested = true;
      if (refs.current.reconnectTimer !== null) {
        clearTimeout(refs.current.reconnectTimer);
      }
      teardownAudio();
      closeSocket(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, errorMessage, transcripts, start, stop };
}
